// scripts/test-solicitacoes-email-patrimonio-interna.ts
//
// Teste manual (mesmo padrão de scripts/test-solicitacoes-post-aguardando-gestor.ts
// e scripts/test-solicitacoes-aprovar-gestor.ts) da Etapa
// email-patrimonio-solicitacao-interna: SOLICITACAO_AGUARDANDO_PATRIMONIO
// (o MESMO evento/template/payload já usado por /aprovar-gestor no fluxo
// externo) agora também é criado em POST /api/solicitacoes quando a
// solicitação é INTERNA — nasce direto em AGUARDANDO_PATRIMONIO, sem gestor
// envolvido — um evento por membro ATIVO da equipe Patrimônio
// (permissao='patrimonio'), nunca para o solicitante ou administradores sem
// essa permissão.
//
// Importa e chama o handler POST REAL da rota — prisma, getSession e
// sendEmail() são mocks em memória; processarEmailEvento(),
// criarValidadorDeEvento() e buildAppUrl() rodam DE VERDADE, exercitando o
// caminho completo criação → build (a partir do payload persistido) →
// envio, igual em produção. Não abre conexão real com o banco nem envia
// e-mail real pelo Resend.
//
// Fora do escopo deste arquivo (já cobertos em outro lugar, não duplicados
// aqui):
// - obsolescência (Patrimônio confirma/rejeita/cancela antes do dispatch):
//   scripts/test-email-validade-evento.ts (cenários L-O), cobre
//   SOLICITACAO_AGUARDANDO_PATRIMONIO genericamente por tipo+status, sem
//   distinguir interno/externo;
// - formato completo do payload/template (texto de abertura interna vs.
//   externa, linha "Gestor responsável" omitida, linha "Ambiente",
//   compatibilidade com payload histórico sem tipoEmprestimo/ambiente):
//   scripts/test-email-aguardando-patrimonio-payload.ts;
// - SOLICITACAO_AGUARDANDO_PATRIMONIO criado em /aprovar-gestor (fluxo
//   externo, após aprovação do gestor) continua exatamente como antes desta
//   etapa: scripts/test-solicitacoes-aprovar-gestor.ts (não alterado por
//   esta etapa, roda sem modificação).
//
// Executar com: npm run test:solicitacoes-email-patrimonio-interna

import type { SendEmailInput, SendEmailResult } from '../src/lib/email/send-email'
import { resetEmailConfigCache, resetEmailPatrimonioRecipientCache } from '../src/lib/email/config'

process.env.APP_URL = 'http://localhost:3000'
process.env.EMAIL_TEST_MODE = 'false'
process.env.EMAIL_PATRIMONIO_RECIPIENT = 'grupopatrimonio@example.com'

const GRUPO_PATRIMONIO = 'grupopatrimonio@example.com'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { prisma } = require('../src/lib/prisma')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const authModule = require('../src/lib/auth')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sendEmailModule = require('../src/lib/email/send-email')

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

// Etapa security/session-revocation: getValidatedMutationSession() faz UMA
// consulta a prisma.user.findUnique() para revalidar o usuário AUTENTICADO
// — como SESSION.id === SOLICITANTE.id aqui, o MESMO registro abaixo já
// atende as duas finalidades (revalidação de sessão + lookup de negócio da
// rota), sem precisar de um fixture separado.
const SOLICITANTE = { id: 'user-solicitante', nome: 'Fulano Solicitante', email: 'fulano@example.com', ativo: true, permissao: 'colaborador' as const, podeSerGestor: false, podeSolicitarParaOutro: false, versaoSessao: 0 }
const GESTOR = { id: 'user-gestor', nome: 'Beltrano Gestor', email: 'beltrano.gestor@example.com', ativo: true, podeSerGestor: true, permissao: 'colaborador' as const, podeSolicitarParaOutro: false, versaoSessao: 0 }
const SESSION = { id: SOLICITANTE.id, nome: SOLICITANTE.nome, email: SOLICITANTE.email, permissao: 'colaborador' as const, versaoSessao: 0 }

interface UserFake {
  id: string
  email: string
  ativo: boolean
  permissao: 'colaborador' | 'patrimonio' | 'administrador'
}

interface EventoFake {
  id: string
  tipo: string
  destinatario: string
  status: 'PENDENTE' | 'PROCESSANDO' | 'ENVIADO' | 'FALHA' | 'OBSOLETO'
  tentativas: number
  erro: string | null
  enviadoEm: Date | null
  payload: unknown
}

let numeroSeq: number
let usuariosFake: UserFake[]
let emailEventoCreateCalls: Array<Record<string, unknown>>
let notificacaoCriada: Array<Record<string, unknown>>
let eventos: Map<string, EventoFake>
let sendEmailCalls: SendEmailInput[]
let ultimaOpcaoTransacao: { maxWait?: number; timeout?: number } | undefined

function resetMocks(usuarios: UserFake[] = []) {
  numeroSeq = 200
  usuariosFake = usuarios
  emailEventoCreateCalls = []
  notificacaoCriada = []
  eventos = new Map()
  sendEmailCalls = []
  ultimaOpcaoTransacao = undefined
}

function instalarMockPrisma() {
  prisma.user = {
    findUnique: async ({ where }: { where: { id: string } }) => {
      if (where.id === SOLICITANTE.id) return { ...SOLICITANTE }
      if (where.id === GESTOR.id) return { ...GESTOR }
      return null
    },
  }

  // aindaValido (criarValidadorDeEvento) relê isto DEPOIS do commit, via o
  // `prisma` de nível superior — não o `tx` da transação abaixo. Sempre
  // AGUARDANDO_PATRIMONIO aqui: obsolescência já é coberta dedicadamente em
  // scripts/test-email-validade-evento.ts, não é o foco deste arquivo.
  prisma.solicitacao = {
    findUnique: async () => ({ status: 'AGUARDANDO_PATRIMONIO' }),
  }

  const tx = {
    solicitacao: {
      create: async ({ data }: { data: Record<string, any> }) => {
        const numero = ++numeroSeq
        const id = `sol-${numero}`
        return {
          id,
          numero,
          tipoEmprestimo: data.tipoEmprestimo,
          ambiente: data.ambiente,
          data: data.data,
          periodos: data.periodos,
          finalidade: data.finalidade,
          atividadeExterna: data.atividadeExterna,
          local: data.local,
          cidade: data.cidade,
          observacoes: data.observacoes,
          notebooksComDominio: data.notebooksComDominio,
          tipoDominio: data.tipoDominio,
          gestorId: data.gestorId,
          solicitanteId: data.solicitanteId,
          solicitante: { id: SOLICITANTE.id, nome: SOLICITANTE.nome, email: SOLICITANTE.email },
          criadoPor: { id: SOLICITANTE.id, nome: SOLICITANTE.nome, email: SOLICITANTE.email },
          gestor: data.gestorId === GESTOR.id ? { id: GESTOR.id, nome: GESTOR.nome, email: GESTOR.email } : null,
          itensPatrimonio: [],
          itensPapelaria: data.itensPapelaria?.create ?? [],
          itensServico: [],
        }
      },
    },
    historicoSolicitacao: { create: async () => ({}) },
    notificacao: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        notificacaoCriada.push(data)
        return { ...data }
      },
    },
    user: {
      findMany: async ({ where }: { where: { ativo: boolean; permissao: string } }) =>
        usuariosFake.filter((u) => u.ativo === where.ativo && u.permissao === where.permissao).map((u) => ({ id: u.id, email: u.email })),
    },
    emailEvento: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        emailEventoCreateCalls.push(data)
        const id = `evento-${emailEventoCreateCalls.length}`
        eventos.set(id, {
          id,
          tipo: data.tipo as string,
          status: 'PENDENTE',
          tentativas: 0,
          erro: null,
          enviadoEm: null,
          destinatario: data.destinatario as string,
          payload: data.payload,
        })
        return { id, ...data }
      },
    },
  }

  // Captura as opções (2º argumento) da chamada real a prisma.$transaction()
  // — correção pós-P2028 em produção: a rota agora passa { maxWait, timeout }
  // explícitos nesta transação especificamente (ver comentário no route.ts),
  // em vez de depender dos defaults do Prisma (maxWait: 2000ms, timeout:
  // 5000ms), insuficientes em serverless para o caminho AGUARDANDO_PATRIMONIO
  // com múltiplos destinatários. O mock não precisa SIMULAR o timeout (nem
  // um sleep real) — só provar que a rota está pedindo a folga certa.
  prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>, opcoes?: { maxWait?: number; timeout?: number }) => {
    ultimaOpcaoTransacao = opcoes
    return fn(tx)
  }

  // processarEmailEvento (real) opera sobre prisma.emailEvento de nível
  // superior DEPOIS do commit — objeto separado do `tx` acima de propósito
  // (mesma distinção real/tx do Prisma verdadeiro).
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
      return { destinatario: ev.destinatario }
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const ev = eventos.get(where.id)
      if (!ev) throw new Error('EmailEvento não encontrado (mock).')
      Object.assign(ev, data)
      return { ...ev }
    },
  }
}

function instalarMockSendEmail(resultado: SendEmailResult | ((input: SendEmailInput) => SendEmailResult)) {
  sendEmailCalls = []
  sendEmailModule.sendEmail = async (input: SendEmailInput): Promise<SendEmailResult> => {
    sendEmailCalls.push(input)
    return typeof resultado === 'function' ? resultado(input) : resultado
  }
}

function instalarMockGetSession() {
  authModule.getSession = async () => ({ ...SESSION })
}

function corpoInterno(overrides: Record<string, unknown> = {}) {
  return {
    tipoEmprestimo: 'interno',
    origem: 'RESERVA',
    solicitanteId: SOLICITANTE.id,
    ambiente: 'Laboratório 3',
    finalidade: 'Aula prática',
    data: '2026-09-01',
    periodos: ['MANHA'],
    patrimonioIds: [],
    itensPapelaria: [{ descricao: 'Caneta', quantidade: 5 }],
    servicos: [],
    ...overrides,
  }
}

function corpoExterno(overrides: Record<string, unknown> = {}) {
  return {
    tipoEmprestimo: 'externo',
    origem: 'RESERVA',
    solicitanteId: SOLICITANTE.id,
    gestorId: GESTOR.id,
    atividadeExterna: 'Feira de tecnologia',
    local: 'Centro de Convenções',
    cidade: 'São Paulo',
    data: '2026-09-01',
    periodos: ['MANHA'],
    patrimonioIds: [],
    itensPapelaria: [{ descricao: 'Caneta', quantidade: 5 }],
    servicos: [],
    ...overrides,
  }
}

async function postar(body: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rota = require('../src/app/api/solicitacoes/route')
  const req = { json: async () => body } as unknown as Parameters<typeof rota.POST>[0]
  return rota.POST(req)
}

async function main() {
  instalarMockPrisma()
  instalarMockGetSession()
  resetEmailPatrimonioRecipientCache()

  const PATRIMONIO_1: UserFake = { id: 'user-patrimonio-1', email: 'patrimonio1@example.com', ativo: true, permissao: 'patrimonio' }
  const PATRIMONIO_2: UserFake = { id: 'user-patrimonio-2', email: 'patrimonio2@example.com', ativo: true, permissao: 'patrimonio' }
  const PATRIMONIO_INATIVO: UserFake = { id: 'user-patrimonio-3', email: 'patrimonio-inativo@example.com', ativo: false, permissao: 'patrimonio' }
  const ADMIN_SEM_PERMISSAO: UserFake = { id: 'user-admin', email: 'admin@example.com', ativo: true, permissao: 'administrador' }

  // --- A) criação INTERNA → status AGUARDANDO_PATRIMONIO -------------------------------
  resetMocks([PATRIMONIO_1])
  instalarMockSendEmail((input) => ({ success: true, providerId: `p-${input.to}`, originalRecipient: input.to, physicalRecipient: input.to, isTest: false }))
  {
    const res = await postar(corpoInterno())
    assert(res.status === 201, 'A) resposta 201 na criação da reserva interna', res.status)
    const body = await res.json()
    assert(body.solicitacao?.tipoEmprestimo === 'interno', 'A) solicitação criada é interna', body.solicitacao?.tipoEmprestimo)

    // A2) correção pós-P2028: a transação de criação passa maxWait/timeout
    // explícitos (não depende dos defaults do Prisma, insuficientes em
    // serverless para este caminho — ver comentário em route.ts).
    assert(ultimaOpcaoTransacao?.maxWait === 5000, 'A2) $transaction recebe maxWait explícito de 5000ms', ultimaOpcaoTransacao)
    assert(ultimaOpcaoTransacao?.timeout === 15000, 'A2) $transaction recebe timeout explícito de 15000ms', ultimaOpcaoTransacao)
  }

  // --- B) equipe Patrimônio ativa → exatamente 1 EmailEvento para a caixa de grupo ----
  resetMocks([PATRIMONIO_1])
  {
    await postar(corpoInterno())
    assert(emailEventoCreateCalls.length === 1, 'B) exatamente 1 EmailEvento (a caixa de grupo, nunca 1 por membro)', emailEventoCreateCalls.length)
    assert(emailEventoCreateCalls[0]?.tipo === 'SOLICITACAO_AGUARDANDO_PATRIMONIO', 'B) tipo do evento é SOLICITACAO_AGUARDANDO_PATRIMONIO', emailEventoCreateCalls[0]?.tipo)
    assert(emailEventoCreateCalls[0]?.destinatario === GRUPO_PATRIMONIO, 'B) destinatário é a caixa de grupo, não o e-mail individual do Patrimônio', emailEventoCreateCalls[0]?.destinatario)
    const ev = Array.from(eventos.values())[0]
    assert(ev?.status === 'ENVIADO', 'B/O) evento termina ENVIADO — dispatcher/build/send funcionam de ponta a ponta', ev?.status)
  }

  // --- C) dois Patrimônios ativos distintos → ainda assim 1 único evento (a caixa de grupo)
  resetMocks([PATRIMONIO_1, PATRIMONIO_2])
  {
    await postar(corpoInterno())
    const destinatarios = emailEventoCreateCalls.map((e) => e.destinatario)
    assert(destinatarios.length === 1, 'C) exatamente 1 evento mesmo com 2 Patrimônios ativos distintos (nunca 1 por membro)', destinatarios)
    assert(destinatarios[0] === GRUPO_PATRIMONIO, 'C) o único evento é para a caixa de grupo', destinatarios)
  }

  // --- D) só Patrimônio inativo → caixa de grupo NÃO recebe -----------------------------
  resetMocks([PATRIMONIO_INATIVO])
  {
    await postar(corpoInterno())
    const destinatarios = emailEventoCreateCalls.map((e) => e.destinatario)
    assert(!destinatarios.includes(GRUPO_PATRIMONIO), 'D) usuário Patrimônio inativo sozinho NÃO ativa a caixa de grupo', destinatarios)
    assert(!destinatarios.includes(PATRIMONIO_INATIVO.email), 'D) o e-mail individual do usuário inativo nunca aparece', destinatarios)
  }

  // --- E) admin sem permissao='patrimonio' não conta como elegível ------------------------
  resetMocks([PATRIMONIO_1, ADMIN_SEM_PERMISSAO])
  {
    await postar(corpoInterno())
    const destinatarios = emailEventoCreateCalls.map((e) => e.destinatario)
    assert(destinatarios.includes(GRUPO_PATRIMONIO), 'E) com 1 membro ativo elegível (mesmo ao lado de um admin sem a permissão), a caixa de grupo recebe', destinatarios)
    assert(!destinatarios.includes(ADMIN_SEM_PERMISSAO.email), 'E) o e-mail do administrador sem permissao=patrimonio nunca aparece', destinatarios)
  }

  // --- F) solicitante não recebe este evento ---------------------------------------------
  resetMocks([PATRIMONIO_1])
  {
    await postar(corpoInterno())
    const destinatarios = emailEventoCreateCalls.map((e) => e.destinatario)
    assert(!destinatarios.includes(SOLICITANTE.email), 'F) solicitante NÃO recebe este evento', destinatarios)
  }

  // --- G) nenhum Patrimônio ativo → solicitação continua criada, zero eventos -----------
  resetMocks([])
  {
    const res = await postar(corpoInterno())
    assert(res.status === 201, 'G) criação continua respondendo 201 mesmo sem Patrimônio ativo', res.status)
    assert(emailEventoCreateCalls.length === 0, 'G) zero EmailEvento criado sem destinatário Patrimônio', emailEventoCreateCalls.length)
  }

  // --- I) payload histórico correto para INTERNA / M) CTA correto -------------------------
  resetMocks([PATRIMONIO_1])
  {
    const res = await postar(corpoInterno({ ambiente: 'Sala 7', finalidade: 'Reunião de equipe' }))
    const body = await res.json()
    const payload = emailEventoCreateCalls[0]?.payload as { tipoEmprestimo?: string; ambiente?: string | null; nomeGestorAprovador?: string | null; finalidade?: string | null }
    assert(payload?.tipoEmprestimo === 'interno', 'I) payload persistido marca tipoEmprestimo=interno', payload?.tipoEmprestimo)
    assert(payload?.ambiente === 'Sala 7', 'I) payload persistido traz o ambiente correto', payload?.ambiente)
    assert(payload?.nomeGestorAprovador === null, 'I) payload persistido não inventa um gestor aprovador', payload?.nomeGestorAprovador)
    assert(payload?.finalidade === 'Reunião de equipe', 'I) payload persistido traz a finalidade correta', payload?.finalidade)

    // M) CTA correto — mesmo botão/rota já homologados, apontando para a
    // solicitação recém-criada (detalhe completo do template em
    // test-email-aguardando-patrimonio-payload.ts, não duplicado aqui).
    const linkEsperado = `http://localhost:3000/solicitacoes/${body.solicitacao.id}`
    assert(
      sendEmailCalls.some((c) => c.html?.includes('ANALISAR SOLICITAÇÃO') && c.html.includes(linkEsperado)),
      'M) e-mail enviado contém o CTA "ANALISAR SOLICITAÇÃO" apontando para /solicitacoes/{id} correto',
      sendEmailCalls.map((c) => c.html)
    )
  }

  // --- EMAIL_TEST_MODE preserva destinatário lógico ---------------------------------------
  resetMocks([PATRIMONIO_1])
  process.env.EMAIL_TEST_MODE = 'true'
  process.env.EMAIL_TEST_RECIPIENT = 'caixa-de-teste@example.com'
  resetEmailConfigCache()
  instalarMockSendEmail({ success: true, providerId: 'p-N', originalRecipient: GRUPO_PATRIMONIO, physicalRecipient: 'caixa-de-teste@example.com', isTest: true })
  {
    await postar(corpoInterno())
    assert(emailEventoCreateCalls[0]?.destinatario === GRUPO_PATRIMONIO, 'N) EmailEvento.destinatario continua sendo a caixa de grupo (destinatário lógico) em EMAIL_TEST_MODE', emailEventoCreateCalls[0]?.destinatario)
  }
  process.env.EMAIL_TEST_MODE = 'false'
  delete process.env.EMAIL_TEST_RECIPIENT
  resetEmailConfigCache()

  // --- R) criação EXTERNA continua SEM criar SOLICITACAO_AGUARDANDO_PATRIMONIO no POST ----
  resetMocks([PATRIMONIO_1])
  instalarMockSendEmail((input) => ({ success: true, providerId: `p-${input.to}`, originalRecipient: input.to, physicalRecipient: input.to, isTest: false }))
  {
    const res = await postar(corpoExterno())
    assert(res.status === 201, 'R) resposta 201 na criação da atividade externa', res.status)
    const tipos = emailEventoCreateCalls.map((e) => e.tipo)
    assert(tipos.length === 1 && tipos[0] === 'SOLICITACAO_AGUARDANDO_GESTOR', 'R) POST externo cria SOMENTE SOLICITACAO_AGUARDANDO_GESTOR — nunca SOLICITACAO_AGUARDANDO_PATRIMONIO nesta etapa', tipos)
    assert(!emailEventoCreateCalls.some((e) => e.tipo === 'SOLICITACAO_AGUARDANDO_PATRIMONIO'), 'R) nenhum SOLICITACAO_AGUARDANDO_PATRIMONIO é criado no POST inicial externo', emailEventoCreateCalls)
  }

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) de SOLICITACAO_AGUARDANDO_PATRIMONIO (solicitação interna) em POST /api/solicitacoes falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes de SOLICITACAO_AGUARDANDO_PATRIMONIO (solicitação interna) em POST /api/solicitacoes passaram. Nenhum e-mail real foi enviado, nenhum banco real foi acessado.')
}

main().catch((err) => {
  console.error('Falha inesperada ao executar os testes de e-mail de Patrimônio (solicitação interna):', err instanceof Error ? err.message : err)
  process.exit(1)
})
