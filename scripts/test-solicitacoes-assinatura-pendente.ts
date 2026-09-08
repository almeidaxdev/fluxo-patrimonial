// scripts/test-solicitacoes-assinatura-pendente.ts
//
// Teste manual (mesmo padrão de scripts/test-solicitacoes-post-aguardando-gestor.ts)
// da Etapa email-assinatura-pendente: ASSINATURA_PENDENTE criado em
// POST /api/solicitacoes/[id]/assinatura quando o link é encaminhado e a
// solicitação passa a AGUARDANDO_ASSINATURA — exclusivo do solicitante,
// nunca gestor/Patrimônio/administradores, e sem criar RESERVA_CONFIRMADA
// neste momento (isso continua sendo /assinatura/confirmar).
//
// Importa e chama o handler POST REAL da rota — prisma, getSession e
// sendEmail() são mocks em memória; processarEmailEvento(),
// criarValidadorDeEvento() e buildAppUrl() rodam DE VERDADE. Não abre
// conexão real com o banco nem envia e-mail real pelo Resend.
//
// Etapa fix/signature-resend (auditoria de concorrência) — a rota agora usa
// DOIS gates atômicos independentes (ver comentário no topo de route.ts):
//
// GATE 1 — tx.solicitacao.updateMany condicionado a `status` E `updatedAt`
// (não só `status`): necessário porque o reenvio (AGUARDANDO_ASSINATURA →
// AGUARDANDO_ASSINATURA) é uma AUTO-transição — só `status` no WHERE não
// distingue duas chamadas concorrentes. O mock de `tx.solicitacao.updateMany`
// abaixo reproduz isso (compara `updatedAt` por valor, e o incrementa a
// cada escrita bem-sucedida, imitando `@updatedAt`).
//
// GATE 2 — tx.emailEvento.findUnique + create/updateMany condicionado a
// `status IN [ENVIADO, FALHA, OBSOLETO]`: um EmailEvento PENDENTE ou
// PROCESSANDO bloqueia um novo reenvio (409, "já existe um envio em
// andamento"), sem criar histórico/notificação/rearme algum.
//
// prisma.$transaction agora simula ROLLBACK real: se `fn` lançar, TODO o
// estado mutável tocado dentro da transação (Solicitacao, EmailEvento,
// Assinatura, histórico, notificação) é revertido ao que era ANTES da
// chamada — necessário para os cenários N/O (Gate 1 passa, muta
// Solicitacao, e só DEPOIS o Gate 2 rejeita; sem rollback o mock deixaria
// esse efeito parcial vazar, o que o Postgres real nunca permite).
//
// Executar com: npm run test:solicitacoes-assinatura-pendente

import type { SendEmailInput, SendEmailResult } from '../src/lib/email/send-email'
import { idempotencyKeyParaEvento } from '../src/lib/email/processar-evento'

process.env.APP_URL = 'http://localhost:3000'
process.env.EMAIL_TEST_MODE = 'false'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { prisma } = require('../src/lib/prisma')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const authModule = require('../src/lib/auth')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sendEmailModule = require('../src/lib/email/send-email')
import { resetEmailConfigCache } from '../src/lib/email/config'

let failures = 0

function assert(condition: boolean, label: string, detalhe?: unknown) {
  if (condition) {
    console.log(`OK   - ${label}`)
  } else {
    failures++
    console.error(`FALHA - ${label}${detalhe !== undefined ? ` (${JSON.stringify(detalhe)})` : ''}`)
  }
}

// --- Fixtures ------------------------------------------------------------

const SOLICITANTE = { id: 'user-solicitante', nome: 'Fulano Solicitante', email: 'fulano@example.com' }
const PATRIMONIO_SESSION = { id: 'user-patrimonio', nome: 'Beltrana Patrimônio', email: 'beltrana@example.com', permissao: 'patrimonio' as const, versaoSessao: 0 }
const SOL_ID = 'sol-assinatura-1'
const CHAVE_EVENTO = `${SOL_ID}|ASSINATURA_PENDENTE|${SOLICITANTE.email}`

type StatusEventoFake = 'PENDENTE' | 'PROCESSANDO' | 'ENVIADO' | 'FALHA' | 'OBSOLETO'

interface SolicitacaoFake {
  id: string
  numero: number
  tipoEmprestimo: 'interno' | 'externo'
  status: string
  solicitanteId: string
  data: Date
  periodos: string[]
  finalidade: string | null
  atividadeExterna: string | null
  local: string | null
  cidade: string | null
  observacoes: string | null
  notebooksComDominio: boolean | null
  tipoDominio: string | null
  updatedAt: Date
}

interface EventoFake {
  id: string
  tipo: string
  destinatario: string
  status: StatusEventoFake
  tentativas: number
  erro: string | null
  enviadoEm: Date | null
  payload: unknown
}

let solicitacaoFake: SolicitacaoFake
let eventoSeq: number
let eventos: Map<string, EventoFake> // por id
let eventosPorChave: Map<string, string> // "solicitacaoId|tipo|destinatario" -> id
let emailEventoCreateCalls: Array<Record<string, unknown>>
let notificacaoCriada: Array<Record<string, unknown>>
let historicoCriado: Array<Record<string, unknown>>
let assinaturaUpsertCalls: number
let assinaturaUpsertLinks: string[]
let sendEmailCalls: SendEmailInput[]

function resetMocks(statusInicial: string = 'AGUARDANDO_ENVIO_ASSINATURA') {
  solicitacaoFake = {
    id: SOL_ID,
    numero: 88,
    tipoEmprestimo: 'externo',
    status: statusInicial,
    solicitanteId: SOLICITANTE.id,
    data: new Date('2026-09-05'),
    periodos: ['MANHA'],
    finalidade: null,
    atividadeExterna: 'Feira de tecnologia',
    local: 'Centro de Convenções',
    cidade: 'São Paulo',
    observacoes: null,
    notebooksComDominio: null,
    tipoDominio: null,
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  }
  eventoSeq = 0
  eventos = new Map()
  eventosPorChave = new Map()
  emailEventoCreateCalls = []
  notificacaoCriada = []
  historicoCriado = []
  assinaturaUpsertCalls = 0
  assinaturaUpsertLinks = []
  sendEmailCalls = []
  desarmarBarreira()
}

// Barreira de sincronização para os cenários de concorrência real (I, K/L,
// M) — Etapa security/rate-limit: a rota agora chama
// checkSensitiveRateLimit() ANTES da transação, que usa
// `crypto.subtle.digest` (SHA-256) para derivar a chave — uma operação
// genuinamente assíncrona via threadpool do Node, cuja ordem de conclusão
// relativa entre duas chamadas quase-simultâneas NÃO é garantida pela ordem
// de submissão (ao contrário de todo o resto deste mock, que resolve por
// microtask determinística). Sem esta barreira, os testes de concorrência
// abaixo dependiam implicitamente de as duas chamadas do `Promise.all`
// permanecerem "lado a lado" por pura sorte de ordenação de microtask até
// chegarem em `tx.solicitacao.findUnique` — pressuposto que deixou de valer
// assim que uma operação genuinamente assíncrona entrou no caminho antes da
// transação. A barreira torna a simulação de concorrência explícita e
// robusta a qualquer trabalho assíncrono adicional que passe a existir
// antes da transação no futuro: ela força as duas chamadas armadas para
// `armarBarreira(2)` a aguardarem UMA A OUTRA em `tx.solicitacao.findUnique`
// (o verdadeiro ponto de contenção do Gate 1) antes de qualquer uma
// prosseguir — reproduzindo overlap real independentemente de quantos
// awaits (ou de que tipo) aconteceram antes.
let barreiraTotal = 0
let barreiraContagem = 0
let barreiraResolvers: Array<() => void> = []

function armarBarreira(totalParticipantes: number) {
  barreiraTotal = totalParticipantes
  barreiraContagem = 0
  barreiraResolvers = []
}

function desarmarBarreira() {
  barreiraTotal = 0
  barreiraContagem = 0
  barreiraResolvers = []
}

function aguardarBarreira(): Promise<void> {
  // Barreira desarmada (todo o resto do arquivo, fora dos blocos I/K/L/M) —
  // resolve imediatamente, sem nenhuma espera: comportamento idêntico ao de
  // antes desta mudança para qualquer teste que não seja de concorrência.
  if (barreiraTotal === 0) return Promise.resolve()
  return new Promise((resolve) => {
    barreiraContagem++
    barreiraResolvers.push(resolve)
    if (barreiraContagem >= barreiraTotal) {
      // Disparo ÚNICO: zera também `barreiraTotal` (não só a contagem), não
      // apenas um "novo round" com o mesmo total. Isso é essencial porque
      // `tx.solicitacao.findUnique` (onde esta barreira é chamada) é
      // acionado uma SEGUNDA vez pela chamada PERDEDORA da corrida — a
      // "reconsulta obrigatória" que a rota faz para distinguir 404 de 409
      // quando `updateMany` casa 0 linhas (ver comentário no topo do
      // arquivo de rota). Sem este auto-desarme, essa segunda chamada
      // reabriria um novo "round" da barreira sozinha, esperando para
      // sempre por um segundo participante que nunca chega — um deadlock
      // real, encontrado e corrigido durante a Etapa security/rate-limit.
      const paraLiberar = barreiraResolvers
      barreiraResolvers = []
      barreiraContagem = 0
      barreiraTotal = 0
      for (const liberar of paraLiberar) liberar()
    }
  })
}

/** Pré-semeia um EmailEvento ASSINATURA_PENDENTE existente (simula um envio/reenvio anterior). */
function seedEvento(status: StatusEventoFake, overrides: Partial<EventoFake> = {}): EventoFake {
  const id = overrides.id ?? `evento-seed-${++eventoSeq}`
  const evento: EventoFake = {
    id,
    tipo: 'ASSINATURA_PENDENTE',
    destinatario: SOLICITANTE.email,
    status,
    tentativas: 1,
    erro: status === 'FALHA' ? 'Erro simulado do provedor.' : null,
    enviadoEm: status === 'ENVIADO' ? new Date('2026-01-01T00:00:00.000Z') : null,
    payload: { versao: 1, geracao: 1, numeroOriginal: solicitacaoFake.numero },
    ...overrides,
  }
  eventos.set(id, evento)
  eventosPorChave.set(CHAVE_EVENTO, id)
  return evento
}

function instalarMockPrisma() {
  // Etapa security/session-revocation: getValidatedMutationSession() faz
  // prisma.user.findUnique() ANTES de prisma.$transaction ser aberto (mas
  // DEPOIS do rate limit — ver comentário em route.ts). Roda fora da
  // barreira de sincronização (armarBarreira()/aguardarBarreira() abaixo,
  // amarradas especificamente a tx.solicitacao.findUnique) — resolve
  // imediatamente, sem interferir na simulação de concorrência real.
  prisma.user = {
    findUnique: async ({ where }: { where: { id: string } }) =>
      where.id === PATRIMONIO_SESSION.id
        ? { id: PATRIMONIO_SESSION.id, nome: PATRIMONIO_SESSION.nome, email: PATRIMONIO_SESSION.email, permissao: PATRIMONIO_SESSION.permissao, ativo: true, podeSerGestor: false, podeSolicitarParaOutro: false, versaoSessao: PATRIMONIO_SESSION.versaoSessao }
        : null,
  }

  // aindaValido (criarValidadorDeEvento) relê isto DEPOIS do commit, via o
  // `prisma` de nível superior.
  prisma.solicitacao = {
    findUnique: async () => ({ status: solicitacaoFake.status }),
  }

  // Simula atomicidade real de transação via UNDO LOG por chamada — não via
  // snapshot/restore do estado global. Um snapshot tirado no INÍCIO desta
  // transação e restaurado cegamente no catch seria INSEGURO sob
  // concorrência real: se, entre o início desta transação e seu rollback,
  // uma OUTRA transação concorrente já tiver commitado (ex.: cenário I/K —
  // a vencedora termina e muta o estado global ANTES da perdedora lançar),
  // restaurar para o snapshot antigo apagaria também o commit da vencedora.
  // O undo log, em vez disso, grava a ação inversa de CADA mutação feita
  // POR ESTA chamada, no momento em que ela acontece, e desfaz só essas
  // ações (na ordem inversa) se a transação lançar — nunca toca no que
  // outra transação concorrente já commitou.
  prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
    const undoLog: Array<() => void> = []

    const tx = {
      solicitacao: {
        // `aguardarBarreira()` primeiro: ver comentário completo acima de
        // `armarBarreira()` — ponto real de contenção do Gate 1.
        findUnique: async ({ where }: { where: { id: string } }) => {
          await aguardarBarreira()
          return where.id === solicitacaoFake.id ? { ...solicitacaoFake } : null
        },
        // GATE 1 (ver comentário no topo do arquivo): condicionado a
        // `status` E `updatedAt` — comparação por VALOR (`getTime()`), já
        // que o objeto Date lido pela rota antes desta chamada é uma
        // referência distinta do Date atualmente em `solicitacaoFake`. A
        // cada escrita bem-sucedida, `updatedAt` avança — imita
        // `@updatedAt`, que o Prisma real bate em TODA escrita, mesmo
        // quando `status` não muda de valor (auto-transição do reenvio).
        updateMany: async ({ where, data }: { where: { id: string; status: string; updatedAt: Date }; data: Record<string, unknown> }) => {
          if (where.id !== solicitacaoFake.id) return { count: 0 }
          if (where.status !== solicitacaoFake.status) return { count: 0 }
          if (where.updatedAt.getTime() !== solicitacaoFake.updatedAt.getTime()) return { count: 0 }
          const statusAntes = solicitacaoFake.status
          const updatedAtAntes = solicitacaoFake.updatedAt
          if (typeof data.status === 'string') solicitacaoFake.status = data.status
          solicitacaoFake.updatedAt = new Date(solicitacaoFake.updatedAt.getTime() + 1)
          undoLog.push(() => {
            solicitacaoFake.status = statusAntes
            solicitacaoFake.updatedAt = updatedAtAntes
          })
          return { count: 1 }
        },
        findUniqueOrThrow: async ({ where, include }: { where: { id: string }; include?: Record<string, unknown> }) => {
          if (where.id !== solicitacaoFake.id) throw new Error('Solicitação não encontrada (mock).')
          if (!include) return { ...solicitacaoFake }
          return {
            ...solicitacaoFake,
            solicitante: { nome: SOLICITANTE.nome, email: SOLICITANTE.email },
            itensPatrimonio: [],
            itensPapelaria: [{ descricao: 'Caneta', quantidade: 5 }],
            itensServico: [],
          }
        },
      },
      assinatura: {
        upsert: async (args: { create?: Record<string, unknown>; update?: Record<string, unknown> }) => {
          assinaturaUpsertCalls++
          undoLog.push(() => { assinaturaUpsertCalls-- })
          const link = (args.update?.link ?? args.create?.link) as string | undefined
          if (link) {
            assinaturaUpsertLinks.push(link)
            undoLog.push(() => { assinaturaUpsertLinks.pop() })
          }
          return {}
        },
      },
      historicoSolicitacao: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          historicoCriado.push(data)
          undoLog.push(() => { historicoCriado.pop() })
          return { ...data }
        },
      },
      notificacao: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          notificacaoCriada.push(data)
          undoLog.push(() => { notificacaoCriada.pop() })
          return { ...data }
        },
      },
      emailEvento: {
        // GATE 2, parte 1: leitura simples (não precisa ser atômica
        // sozinha — quem garante exclusividade é o updateMany condicionado
        // abaixo, ou o `create` no caso "não existe ainda", protegido pelo
        // Gate 1, que já serializa chamadas concorrentes para o MESMO
        // solicitacaoId).
        findUnique: async ({ where }: { where: { solicitacaoId_tipo_destinatario: { solicitacaoId: string; tipo: string; destinatario: string } } }) => {
          const chaveObj = where.solicitacaoId_tipo_destinatario
          const chave = `${chaveObj.solicitacaoId}|${chaveObj.tipo}|${chaveObj.destinatario}`
          const existenteId = eventosPorChave.get(chave)
          if (!existenteId) return null
          const ev = eventos.get(existenteId)!
          return { id: ev.id, status: ev.status, payload: ev.payload }
        },
        create: (args: { data: Record<string, unknown> }) => {
          emailEventoCreateCalls.push(args.data)
          const id = `evento-${++eventoSeq}`
          const novo: EventoFake = {
            id,
            tipo: args.data.tipo as string,
            destinatario: args.data.destinatario as string,
            status: 'PENDENTE',
            tentativas: 0,
            erro: null,
            enviadoEm: null,
            payload: args.data.payload,
          }
          const chave = `${args.data.solicitacaoId}|${args.data.tipo}|${args.data.destinatario}`
          eventos.set(id, novo)
          eventosPorChave.set(chave, id)
          undoLog.push(() => {
            emailEventoCreateCalls.pop()
            eventos.delete(id)
            eventosPorChave.delete(chave)
          })
          return Promise.resolve({ ...novo })
        },
        // GATE 2, parte 2: reabertura atômica condicionada ao estado
        // elegível LIDO no findUnique acima — se, entre a leitura e esta
        // escrita, o status já não bater mais (ex.: outra chamada já
        // rearmou/reivindicou), `count` vem 0 e a rota trata como conflito
        // (409), nunca sucesso silencioso.
        updateMany: (args: { where: { id: string; status: { in?: StatusEventoFake[] } }; data: Record<string, unknown> }) => {
          const ev = eventos.get(args.where.id)
          if (!ev) return Promise.resolve({ count: 0 })
          if (args.where.status?.in && !args.where.status.in.includes(ev.status)) {
            return Promise.resolve({ count: 0 })
          }
          const antes = { ...ev }
          Object.assign(ev, args.data)
          undoLog.push(() => { Object.assign(ev, antes) })
          return Promise.resolve({ count: 1 })
        },
      },
    }

    try {
      return await fn(tx)
    } catch (err) {
      for (let i = undoLog.length - 1; i >= 0; i--) undoLog[i]()
      throw err
    }
  }

  prisma.emailEvento = {
    updateMany: async ({ where, data }: { where: { id: string; status?: string }; data: Record<string, unknown> }) => {
      const ev = eventos.get(where.id)
      if (!ev || (where.status !== undefined && ev.status !== where.status)) return { count: 0 }
      if (typeof data.status === 'string') ev.status = data.status as EventoFake['status']
      const tentativasOp = data.tentativas as { increment?: number } | undefined
      if (tentativasOp?.increment) ev.tentativas += tentativasOp.increment
      return { count: 1 }
    },
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
      const ev = eventos.get(where.id)
      if (!ev) throw new Error('EmailEvento não encontrado (mock).')
      return { destinatario: ev.destinatario, payload: ev.payload }
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const ev = eventos.get(where.id)
      if (!ev) throw new Error('EmailEvento não encontrado (mock).')
      Object.assign(ev, data)
      return { ...ev }
    },
  }
}

function instalarMockSendEmail(resultado: SendEmailResult) {
  sendEmailCalls = []
  sendEmailModule.sendEmail = async (input: SendEmailInput): Promise<SendEmailResult> => {
    sendEmailCalls.push(input)
    return resultado
  }
}

function instalarMockGetSession() {
  authModule.getSession = async () => ({ ...PATRIMONIO_SESSION })
}

async function postar(link: string = 'https://assinafacil.example.com/doc/abc123') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rota = require('../src/app/api/solicitacoes/[id]/assinatura/route')
  const req = { json: async () => ({ link }) } as unknown as Parameters<typeof rota.POST>[0]
  return rota.POST(req, { params: Promise.resolve({ id: SOL_ID }) })
}

async function main() {
  instalarMockPrisma()
  instalarMockGetSession()

  // --- A) externa entra em AGUARDANDO_ASSINATURA → 1 EmailEvento ASSINATURA_PENDENTE ------
  resetMocks()
  instalarMockSendEmail({ success: true, providerId: 'p-A', originalRecipient: SOLICITANTE.email, physicalRecipient: SOLICITANTE.email, isTest: false })
  {
    const res = await postar()
    assert(res.status === 200, 'A) resposta 200 ao encaminhar o link de assinatura', res.status)
    assert(solicitacaoFake.status === 'AGUARDANDO_ASSINATURA', 'A) solicitação passa para AGUARDANDO_ASSINATURA', solicitacaoFake.status)
    assert(emailEventoCreateCalls.length === 1, 'A) exatamente 1 EmailEvento criado', emailEventoCreateCalls.length)
    assert(emailEventoCreateCalls[0]?.tipo === 'ASSINATURA_PENDENTE', 'A) tipo do evento é ASSINATURA_PENDENTE', emailEventoCreateCalls[0]?.tipo)
    assert(sendEmailCalls.length === 1, 'A) sendEmail (provider) chamado exatamente 1 vez', sendEmailCalls.length)
    const ev = Array.from(eventos.values())[0]
    assert(ev?.status === 'ENVIADO', 'A) evento termina ENVIADO', ev?.status)
  }

  // --- B) destinatário lógico é o solicitante -----------------------------------------------
  // --- C) Patrimônio não recebe --- D) Gestor não recebe -------------------------------------
  resetMocks()
  instalarMockSendEmail({ success: true, providerId: 'p-BCD', originalRecipient: SOLICITANTE.email, physicalRecipient: SOLICITANTE.email, isTest: false })
  {
    await postar()
    const destinatarios = emailEventoCreateCalls.map((e) => e.destinatario)
    assert(destinatarios.length === 1 && destinatarios[0] === SOLICITANTE.email, 'B) destinatário lógico é exatamente o e-mail do solicitante', destinatarios)
    assert(!destinatarios.includes(PATRIMONIO_SESSION.email), 'C) Patrimônio (quem encaminhou o link) NÃO recebe este evento', destinatarios)
    // Não há gestor nos dados desta solicitação de teste — a ausência de
    // qualquer destinatário além do solicitante já prova D por construção.
    assert(destinatarios.length === 1, 'D) nenhum destinatário além do solicitante (gestor não recebe)', destinatarios)
  }

  // --- E) EMAIL_TEST_MODE=true não altera o destinatário lógico persistido -------------------
  resetMocks()
  process.env.EMAIL_TEST_MODE = 'true'
  process.env.EMAIL_TEST_RECIPIENT = 'caixa-de-teste@example.com'
  resetEmailConfigCache()
  instalarMockSendEmail({ success: true, providerId: 'p-E', originalRecipient: SOLICITANTE.email, physicalRecipient: 'caixa-de-teste@example.com', isTest: true })
  {
    await postar()
    assert(emailEventoCreateCalls[0]?.destinatario === SOLICITANTE.email, 'E) EmailEvento.destinatario continua sendo o e-mail lógico do solicitante em EMAIL_TEST_MODE', emailEventoCreateCalls[0]?.destinatario)
  }
  process.env.EMAIL_TEST_MODE = 'false'
  delete process.env.EMAIL_TEST_RECIPIENT
  resetEmailConfigCache()

  // --- I) 1º ENVIO concorrente: evento duplicado não é criado --------------------------------
  // (concorrência do PRIMEIRO envio — protegida pela transição REAL de
  // status, distinta da concorrência do REENVIO, que é uma auto-transição
  // e é coberta pelos cenários K/L/M mais abaixo.)
  resetMocks()
  instalarMockSendEmail({ success: true, providerId: 'p-I', originalRecipient: SOLICITANTE.email, physicalRecipient: SOLICITANTE.email, isTest: false })
  {
    // Duas chamadas "ao mesmo tempo" — Promise.all começa as duas antes de
    // qualquer uma terminar, simulando concorrência real. Barreira armada
    // (ver comentário acima de armarBarreira): garante overlap real em
    // tx.solicitacao.findUnique, independentemente da assincronia real do
    // hashing em checkSensitiveRateLimit (Etapa security/rate-limit).
    armarBarreira(2)
    const [r1, r2] = await Promise.all([postar(), postar()])
    desarmarBarreira()
    const statuses = [r1.status, r2.status].sort()
    assert(statuses[0] === 200 && statuses[1] === 409, 'I) exatamente uma das duas chamadas concorrentes vence (200), a outra perde (409) — Gate 1 (transição real de status)', statuses)
    assert(emailEventoCreateCalls.length === 1, 'I) mesmo com duas chamadas concorrentes, exatamente 1 EmailEvento é criado (Gate 1 evita que a perdedora chegue a criar evento)', emailEventoCreateCalls.length)
    assert(eventos.size === 1, 'I) apenas 1 linha existe para a chave [solicitacaoId, tipo, destinatario]', eventos.size)
    assert(assinaturaUpsertCalls === 1, 'I) assinatura.upsert roda exatamente 1 vez — a chamada perdedora nunca sobrescreve link/enviadoEm', assinaturaUpsertCalls)
    assert(notificacaoCriada.length === 1, 'I) apenas 1 notificação in-app é criada (nunca para a chamada que perdeu a corrida)', notificacaoCriada.length)
  }

  // --- R) envio a partir de CONFIRMADA (não só AGUARDANDO_ENVIO_ASSINATURA) continua
  //        funcionando — a transição atômica casa o status EXATO lido (qualquer um dos
  //        dois), nunca restringe ao caso mais comum.
  resetMocks('CONFIRMADA')
  instalarMockSendEmail({ success: true, providerId: 'p-R', originalRecipient: SOLICITANTE.email, physicalRecipient: SOLICITANTE.email, isTest: false })
  {
    const res = await postar()
    assert(res.status === 200, 'R) resposta 200 ao encaminhar o link a partir de CONFIRMADA', res.status)
    assert(solicitacaoFake.status === 'AGUARDANDO_ASSINATURA', 'R) solicitação passa para AGUARDANDO_ASSINATURA a partir de CONFIRMADA', solicitacaoFake.status)
    assert(assinaturaUpsertCalls === 1, 'R) assinatura.upsert roda normalmente quando a origem é CONFIRMADA', assinaturaUpsertCalls)
  }

  // --- P) reenvio de um EmailEvento em FALHA — reabre, reivindica e envia de verdade ---------
  // Bug original (Etapa fix/signature-resend, 1ª rodada): `update: {}` no
  // upsert deixava um EmailEvento em FALHA parado para sempre — o reenvio
  // virava um no-op silencioso (200, mas sendEmail nunca era chamado de
  // novo). Corrigido pelo Gate 2 (rearme atômico condicionado a estado
  // elegível).
  resetMocks('AGUARDANDO_ASSINATURA')
  instalarMockSendEmail({ success: true, providerId: 'p-P', originalRecipient: SOLICITANTE.email, physicalRecipient: SOLICITANTE.email, isTest: false })
  {
    const evt = seedEvento('FALHA')
    const res = await postar()
    assert(res.status === 200, 'P) resposta 200 ao reenviar a partir de AGUARDANDO_ASSINATURA', res.status)
    assert(solicitacaoFake.status === 'AGUARDANDO_ASSINATURA', 'P/F) solicitação permanece AGUARDANDO_ASSINATURA (auto-transição)', solicitacaoFake.status)
    assert(solicitacaoFake.status !== 'ASSINATURA_CONFIRMADA', 'P/S) esta rota nunca confirma a assinatura', solicitacaoFake.status)
    assert(eventos.size === 1, 'P/J) nenhum EmailEvento novo é criado — o reenvio reabre a MESMA linha', eventos.size)
    const ev = eventos.get(evt.id)
    assert(ev?.status === 'ENVIADO', 'P) evento antes em FALHA termina ENVIADO após o reenvio', ev?.status)
    assert(ev?.erro === null, 'P) erro da tentativa anterior é limpo', ev?.erro)
    assert(sendEmailCalls.length === 1, 'P) sendEmail (provider) é chamado de verdade no reenvio — não é mais um no-op', sendEmailCalls.length)

    // Geração (Etapa fix/signature-resend, 2ª rodada): reabrir de FALHA
    // PRESERVA a geração — o payload seedado já começa em geracao:1, e o
    // retry não deve incrementar. A chave usada tem que corresponder a
    // essa MESMA geração (nunca uma nova).
    const payloadRearmado = ev?.payload as { geracao?: number }
    assert(payloadRearmado?.geracao === 1, 'P) geração é PRESERVADA (continua 1) ao reabrir de FALHA — retry técnico, não novo envio lógico', payloadRearmado)
    const chaveUsada = sendEmailCalls[0]?.idempotencyKey
    assert(chaveUsada === idempotencyKeyParaEvento(evt.id, 1), 'P) idempotencyKey do retry pós-FALHA é a MESMA da geração 1 — protege contra FALHA ambígua do provedor', chaveUsada)
  }

  // --- Q) reenvio de um EmailEvento já ENVIADO — reabre, incrementa tentativa, chave nova ----
  // Consolida vários itens do checklist num único cenário: C) reenvio de
  // ENVIADO; E) link atualizado; G) histórico de reenvio; H) notificação de
  // reenvio; I) payload atualizado; J) unique continua 1 linha só.
  resetMocks('AGUARDANDO_ASSINATURA')
  instalarMockSendEmail({ success: true, providerId: 'p-Q1', originalRecipient: SOLICITANTE.email, physicalRecipient: SOLICITANTE.email, isTest: false })
  {
    const evt = seedEvento('ENVIADO', { tentativas: 1 })
    // Muda o número da solicitação DEPOIS do envio original — prova que o
    // payload rearmado reflete o snapshot ATUAL, não o congelado na
    // primeira tentativa (item I do checklist).
    solicitacaoFake.numero = 999

    const NOVO_LINK = 'https://assinafacil.example.com/doc/novo-link-reenvio'
    const res = await postar(NOVO_LINK)
    assert(res.status === 200, 'Q) resposta 200 ao reenviar um evento já ENVIADO', res.status)
    assert(eventos.size === 1, 'Q/J) nenhum EmailEvento novo é criado — mesma linha reaberta', eventos.size)

    const ev = eventos.get(evt.id)!
    assert(ev.tentativas === 2, 'Q) tentativas incrementa (1 → 2) — nova tentativa lógica de verdade', ev.tentativas)
    assert(ev.status === 'ENVIADO', 'Q) evento é reprocessado e termina ENVIADO de novo', ev.status)
    assert(sendEmailCalls.length === 1, 'Q) sendEmail (provider) é chamado de novo — não é um no-op', sendEmailCalls.length)

    const chaveUsada = sendEmailCalls[0]?.idempotencyKey
    assert(chaveUsada === idempotencyKeyParaEvento(evt.id, 2), 'Q) idempotencyKey da 2ª tentativa é DIFERENTE da 1ª — não depende de dedup do provedor', chaveUsada)

    assert(assinaturaUpsertLinks[assinaturaUpsertLinks.length - 1] === NOVO_LINK, 'Q/E) Assinatura.link é atualizado para o novo link enviado no reenvio', assinaturaUpsertLinks)

    const ultimoHistorico = historicoCriado[historicoCriado.length - 1]
    assert(ultimoHistorico?.acao === 'REENVIO_LINK_ASSINATURA', 'Q/G) histórico registra REENVIO_LINK_ASSINATURA (não ENVIO_LINK_ASSINATURA)', ultimoHistorico?.acao)

    const ultimaNotificacao = notificacaoCriada[notificacaoCriada.length - 1]
    assert(typeof ultimaNotificacao?.mensagem === 'string' && (ultimaNotificacao.mensagem as string).includes('reenviado'), 'Q/H) notificação usa a redação de reenvio ("foi reenviado")', ultimaNotificacao?.mensagem)

    const payloadRearmado = ev.payload as { numero?: number; geracao?: number }
    assert(payloadRearmado?.numero === 999, 'Q/I) payload do evento rearmado reflete o snapshot ATUAL (número 999), não o congelado na 1ª tentativa', payloadRearmado)
    assert(payloadRearmado?.geracao === 2, 'Q) geração INCREMENTA (1 → 2) ao reabrir de ENVIADO — reenvio explícito de algo já confirmado entregue', payloadRearmado)
  }

  // --- GC) cadeia completa de gerações através da ROTA REAL (itens 14-18 do pedido) ----------
  // Diferente de P/Q (que seedam o evento anterior diretamente no mock),
  // este cenário nunca toca `eventos`/`eventosPorChave` manualmente — cada
  // passo é uma chamada real a POST /assinatura, exatamente como um usuário
  // faria clicando "Enviar"/"Reenviar" várias vezes seguidas. Prova a
  // cadeia completa: geração 1 (envio) → geração 2 (reenvio explícito, que
  // desta vez FALHA no provider — geração 2 fica "ambígua") → retry da
  // geração 2 (a partir da FALHA, PRESERVA geração, mesma chave, agora com
  // sucesso) → geração 3 (novo reenvio explícito depois do sucesso da
  // geração 2).
  resetMocks('CONFIRMADA')
  {
    // Geração 1: primeiro envio, sucesso.
    instalarMockSendEmail({ success: true, providerId: 'p-GC1', originalRecipient: SOLICITANTE.email, physicalRecipient: SOLICITANTE.email, isTest: false })
    const res1 = await postar()
    assert(res1.status === 200, 'GC1) primeiro envio (geração 1): 200', res1.status)
    const eventoId = Array.from(eventos.keys())[0]
    const chaveGeracao1 = sendEmailCalls[0]?.idempotencyKey
    assert(chaveGeracao1 === idempotencyKeyParaEvento(eventoId, 1), 'GC1) chave corresponde à geração 1', chaveGeracao1)
    assert(eventos.get(eventoId)?.status === 'ENVIADO', 'GC1) evento termina ENVIADO', eventos.get(eventoId)?.status)

    // Geração 2: reenvio explícito (status já é AGUARDANDO_ASSINATURA) —
    // desta vez o provider FALHA (timeout ambíguo simulado).
    instalarMockSendEmail({
      success: false,
      originalRecipient: SOLICITANTE.email,
      physicalRecipient: SOLICITANTE.email,
      isTest: false,
      error: 'Falha simulada do provedor (timeout ambíguo).',
    })
    const res2 = await postar()
    assert(res2.status === 200, 'GC2) reenvio explícito (geração 2): a rota responde 200 mesmo que o ENVIO em si falhe — falha é assíncrona, pós-commit', res2.status)
    const chaveGeracao2Falha = sendEmailCalls[0]?.idempotencyKey
    assert(chaveGeracao2Falha === idempotencyKeyParaEvento(eventoId, 2), 'GC2) chave corresponde à geração 2', chaveGeracao2Falha)
    assert(chaveGeracao2Falha !== chaveGeracao1, 'GC2) chave da geração 2 é diferente da geração 1', [chaveGeracao1, chaveGeracao2Falha])
    assert(eventos.get(eventoId)?.status === 'FALHA', 'GC2) evento termina FALHA — geração 2 fica registrada como possivelmente ambígua (nunca confirmada)', eventos.get(eventoId)?.status)

    // Retry técnico da geração 2 (reenvio a partir de FALHA) — item 17 do
    // pedido: precisa PRESERVAR a geração e usar a MESMA chave da tentativa
    // anterior (que falhou) da mesma geração — não é só a geração 1 que
    // precisa disso.
    instalarMockSendEmail({ success: true, providerId: 'p-GC3', originalRecipient: SOLICITANTE.email, physicalRecipient: SOLICITANTE.email, isTest: false })
    const res3 = await postar()
    assert(res3.status === 200, 'GC3) retry da geração 2 (a partir de FALHA): 200', res3.status)
    const chaveGeracao2Retry = sendEmailCalls[0]?.idempotencyKey
    assert(
      chaveGeracao2Retry === chaveGeracao2Falha,
      'GC3) retry técnico da geração 2 usa EXATAMENTE A MESMA chave da tentativa anterior (falha) da mesma geração — a solução funciona em qualquer geração, não só na 1ª',
      [chaveGeracao2Falha, chaveGeracao2Retry]
    )
    assert(eventos.get(eventoId)?.status === 'ENVIADO', 'GC3) evento termina ENVIADO', eventos.get(eventoId)?.status)

    // Geração 3: novo reenvio explícito depois que a geração 2 foi ENVIADA
    // com sucesso — item 18 do pedido.
    instalarMockSendEmail({ success: true, providerId: 'p-GC4', originalRecipient: SOLICITANTE.email, physicalRecipient: SOLICITANTE.email, isTest: false })
    const res4 = await postar()
    assert(res4.status === 200, 'GC4) novo reenvio explícito (geração 3): 200', res4.status)
    const chaveGeracao3 = sendEmailCalls[0]?.idempotencyKey
    assert(chaveGeracao3 === idempotencyKeyParaEvento(eventoId, 3), 'GC4) chave corresponde à geração 3', chaveGeracao3)
    assert(
      chaveGeracao3 !== chaveGeracao1 && chaveGeracao3 !== chaveGeracao2Falha,
      'GC4) chave da geração 3 é diferente das gerações 1 e 2 — e assim sucessivamente',
      { chaveGeracao1, chaveGeracao2Falha, chaveGeracao3 }
    )

    assert(eventos.size === 1, 'GC) durante toda a cadeia (4 requests), só 1 linha de EmailEvento existiu — nunca uma segunda criada', eventos.size)
  }

  // --- N) EmailEvento PENDENTE bloqueia um novo reenvio — 409, zero efeitos colaterais -------
  resetMocks('AGUARDANDO_ASSINATURA')
  instalarMockSendEmail({ success: true, providerId: 'p-N', originalRecipient: SOLICITANTE.email, physicalRecipient: SOLICITANTE.email, isTest: false })
  {
    seedEvento('PENDENTE')
    const updatedAtAntes = solicitacaoFake.updatedAt.getTime()

    const res = await postar()
    const body = await res.json()
    assert(res.status === 409, 'N) resposta 409 quando já existe um EmailEvento PENDENTE', res.status)
    assert(typeof body.message === 'string' && body.message.toLowerCase().includes('andamento'), 'N) mensagem amigável menciona envio em andamento', body.message)
    assert(historicoCriado.length === 0, 'N) nenhum histórico novo é criado', historicoCriado.length)
    assert(notificacaoCriada.length === 0, 'N) nenhuma notificação nova é criada', notificacaoCriada.length)
    assert(assinaturaUpsertCalls === 0, 'N) Assinatura.link não é alterado', assinaturaUpsertCalls)
    assert(sendEmailCalls.length === 0, 'N) sendEmail nunca é chamado', sendEmailCalls.length)
    assert(
      solicitacaoFake.updatedAt.getTime() === updatedAtAntes,
      'N) rollback total: a auto-transição do Gate 1 (que rodou ANTES do Gate 2 rejeitar) é revertida — updatedAt volta ao valor de antes da chamada',
      { antes: updatedAtAntes, depois: solicitacaoFake.updatedAt.getTime() }
    )
  }

  // --- O) EmailEvento PROCESSANDO bloqueia um novo reenvio — 409, zero efeitos colaterais ----
  resetMocks('AGUARDANDO_ASSINATURA')
  instalarMockSendEmail({ success: true, providerId: 'p-O', originalRecipient: SOLICITANTE.email, physicalRecipient: SOLICITANTE.email, isTest: false })
  {
    const evt = seedEvento('PROCESSANDO')
    const updatedAtAntes = solicitacaoFake.updatedAt.getTime()

    const res = await postar()
    const body = await res.json()
    assert(res.status === 409, 'O) resposta 409 quando já existe um EmailEvento PROCESSANDO', res.status)
    assert(typeof body.message === 'string' && body.message.toLowerCase().includes('andamento'), 'O) mensagem amigável menciona envio em andamento', body.message)
    assert(eventos.get(evt.id)?.status === 'PROCESSANDO', 'O) evento em PROCESSANDO não é rebobinado para PENDENTE pelo reenvio', eventos.get(evt.id)?.status)
    assert(historicoCriado.length === 0, 'O) nenhum histórico novo é criado', historicoCriado.length)
    assert(notificacaoCriada.length === 0, 'O) nenhuma notificação nova é criada', notificacaoCriada.length)
    assert(assinaturaUpsertCalls === 0, 'O) Assinatura.link não é alterado', assinaturaUpsertCalls)
    assert(sendEmailCalls.length === 0, 'O) sendEmail não é chamado — o claim exclusivo do evento em voo é respeitado', sendEmailCalls.length)
    assert(solicitacaoFake.updatedAt.getTime() === updatedAtAntes, 'O) rollback total: updatedAt volta ao valor de antes da chamada', updatedAtAntes)
  }

  // --- K/L) REENVIO concorrente real (Promise.all): uma 200, uma 409; efeitos únicos ---------
  // Diferente do cenário I (1º envio, transição real de status), aqui a
  // transição é uma AUTO-transição (AGUARDANDO_ASSINATURA → AGUARDANDO_
  // ASSINATURA) — é exatamente o caso que o Gate 1 (status + updatedAt)
  // existe para fechar. Ambas as chamadas partem do MESMO evento ENVIADO
  // elegível para reabertura.
  resetMocks('AGUARDANDO_ASSINATURA')
  instalarMockSendEmail({ success: true, providerId: 'p-K', originalRecipient: SOLICITANTE.email, physicalRecipient: SOLICITANTE.email, isTest: false })
  {
    seedEvento('ENVIADO')
    armarBarreira(2)
    const [r1, r2] = await Promise.all([postar(), postar()])
    desarmarBarreira()
    const statuses = [r1.status, r2.status].sort()
    assert(statuses[0] === 200 && statuses[1] === 409, 'K) reenvio concorrente: uma chamada vence (200), a outra perde (409)', statuses)
    assert(eventos.size === 1, 'K/L) apenas 1 linha de EmailEvento continua existindo (nenhuma nova)', eventos.size)
    assert(historicoCriado.length === 1, 'L) exatamente 1 histórico é criado sob concorrência (não 2)', historicoCriado.length)
    assert(notificacaoCriada.length === 1, 'L) exatamente 1 notificação é criada sob concorrência (não 2)', notificacaoCriada.length)
    assert(assinaturaUpsertCalls === 1, 'L) exatamente 1 rearme/atualização de Assinatura sob concorrência (não 2)', assinaturaUpsertCalls)
    assert(sendEmailCalls.length === 1, 'L) exatamente 1 chamada ao provider sob concorrência (não 2)', sendEmailCalls.length)
  }

  // --- M) link X vs link Y concorrentes — só o link da chamada vencedora persiste ------------
  resetMocks('AGUARDANDO_ASSINATURA')
  instalarMockSendEmail({ success: true, providerId: 'p-M', originalRecipient: SOLICITANTE.email, physicalRecipient: SOLICITANTE.email, isTest: false })
  {
    seedEvento('ENVIADO')
    const LINK_X = 'https://assinafacil.example.com/doc/link-x'
    const LINK_Y = 'https://assinafacil.example.com/doc/link-y'
    armarBarreira(2)
    const [r1, r2] = await Promise.all([postar(LINK_X), postar(LINK_Y)])
    desarmarBarreira()
    const vencedora = r1.status === 200 ? { res: r1, link: LINK_X } : { res: r2, link: LINK_Y }
    const perdedora = r1.status === 200 ? r2 : r1

    assert(vencedora.res.status === 200, 'M) exatamente uma chamada vence (200)', [r1.status, r2.status])
    assert(perdedora.status === 409, 'M) a outra perde (409)', [r1.status, r2.status])
    assert(assinaturaUpsertCalls === 1, 'M) Assinatura é escrita exatamente 1 vez — sem "last write wins" entre concorrentes', assinaturaUpsertCalls)
    assert(assinaturaUpsertLinks[0] === vencedora.link, 'M) o link persistido é exatamente o da chamada VENCEDORA, nunca uma mistura/o da perdedora', {
      persistido: assinaturaUpsertLinks[0],
      esperado: vencedora.link,
    })
    assert(historicoCriado.length === 1, 'M) apenas 1 histórico é criado (nunca para a chamada perdedora)', historicoCriado.length)
    assert(notificacaoCriada.length === 1, 'M) apenas 1 notificação é criada (nunca para a chamada perdedora)', notificacaoCriada.length)
  }

  // --- RC) RESERVA_CONFIRMADA continua NÃO sendo criado por esta rota ------------------------
  resetMocks()
  instalarMockSendEmail({ success: true, providerId: 'p-RC', originalRecipient: SOLICITANTE.email, physicalRecipient: SOLICITANTE.email, isTest: false })
  {
    await postar()
    const tipos = emailEventoCreateCalls.map((e) => e.tipo)
    assert(!tipos.includes('RESERVA_CONFIRMADA'), 'RC) nenhum EmailEvento RESERVA_CONFIRMADA é criado ao encaminhar o link de assinatura', tipos)
  }

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) de ASSINATURA_PENDENTE em POST /api/solicitacoes/[id]/assinatura falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes de ASSINATURA_PENDENTE em POST /api/solicitacoes/[id]/assinatura passaram. Nenhum e-mail real foi enviado, nenhum banco real foi acessado.')
}

main().catch((err) => {
  console.error('Falha inesperada ao executar os testes de ASSINATURA_PENDENTE:', err instanceof Error ? err.message : err)
  process.exit(1)
})
