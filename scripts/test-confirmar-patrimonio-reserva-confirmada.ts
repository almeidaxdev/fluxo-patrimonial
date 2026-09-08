// scripts/test-confirmar-patrimonio-reserva-confirmada.ts
//
// Teste manual (mesmo padrão de scripts/test-email-dispatcher.ts e
// scripts/test-confirmar-patrimonio-concorrencia.ts) da Etapa D.3.4:
// RESERVA_CONFIRMADA ligado SOMENTE ao fluxo INTERNO de
// /api/solicitacoes/[id]/confirmar-patrimonio.
//
// Etapa email-patrimonio-caixa-grupo (reescrito por completo): o Patrimônio
// deixou de receber um EmailEvento POR USUÁRIO ativo com permissao=
// 'patrimonio' — agora recebe UM ÚNICO EmailEvento, sempre para a caixa de
// grupo (EMAIL_PATRIMONIO_RECIPIENT), independente de quantos usuários
// individuais existirem. `buscarDestinatariosReservaConfirmada()` só
// consulta o banco para saber SE existe algum membro ativo (gate via
// `tx.user.findFirst`) — nunca mais para buscar e-mails individuais.
//
// Importa e chama o handler POST REAL da rota — prisma, getSession e
// sendEmail() são mocks em memória; processarEmailEvento() e buildAppUrl()
// rodam DE VERDADE (não mockados), para exercitar o caminho completo
// claim → build (com papel correto por destinatário) → envio → persistência,
// exatamente como em produção. Não abre conexão real com o banco nem envia
// e-mail real pelo Resend.
//
// O mock de prisma.$transaction() abaixo simula rollback de verdade
// (snapshot/restore do estado mutável) — necessário para o cenário O, que
// prova que uma falha DENTRO da transação desfaz também os EmailEvento já
// criados nela, não só o histórico/notificação.
//
// Executar com: npm run test:confirmar-patrimonio-reserva-confirmada

import { resetAppUrlCache } from '../src/lib/email/app-url'
import { resetEmailPatrimonioRecipientCache } from '../src/lib/email/config'
import type { SendEmailInput, SendEmailResult } from '../src/lib/email/send-email'
import { renderReservaConfirmadaFromPayload, type ReservaConfirmadaPayloadV1 } from '../src/lib/email/payloads/reserva-confirmada'

process.env.APP_URL = 'http://localhost:3000'
process.env.EMAIL_PATRIMONIO_RECIPIENT = 'grupopatrimonio@example.com'

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

// --- Fixtures ----------------------------------------------------------

const SOL_ID = 'sol-reserva-confirmada-1'
const GRUPO_PATRIMONIO = 'grupopatrimonio@example.com'

interface SolicitacaoFake {
  id: string
  status: string
  numero: number
  solicitanteId: string
  tipoEmprestimo: 'interno' | 'externo'
  data: Date
  periodos: string[]
  ambiente: string | null
  finalidade: string | null
  atividadeExterna: string | null
  local: string | null
  cidade: string | null
  observacoes: string | null
  patrimonioDecisaoEm: Date | null
  patrimonioDecisorId: string | null
}

interface UsuarioFake {
  email: string
  ativo: boolean
  permissao: 'colaborador' | 'patrimonio' | 'administrador'
}

interface EventoFake {
  id: string
  solicitacaoId: string
  tipo: string
  destinatario: string
  status: 'PENDENTE' | 'PROCESSANDO' | 'ENVIADO' | 'FALHA' | 'OBSOLETO'
  tentativas: number
  erro: string | null
  enviadoEm: Date | null
}

let solicitacao: SolicitacaoFake
let solicitante: { nome: string; email: string }
let usuarios: UsuarioFake[]
let historicoCriado: Array<Record<string, unknown>>
let notificacaoCriada: Array<Record<string, unknown>>
let eventos: Map<string, EventoFake>
let eventoSeq: number
let emailEventoCreateCalls: Array<Record<string, unknown>>
let sendEmailCalls: SendEmailInput[]
let falharCriacaoNoIndice: number | null

const ITENS_PATRIMONIO_FIXTURE = [{ patrimonio: { numero: 'PAT-1', marca: 'Dell', modelo: 'Latitude', categoria: { nome: 'Notebook' } } }]
const ITENS_PAPELARIA_FIXTURE: Array<{ descricao: string; quantidade: number }> = []
const ITENS_SERVICO_FIXTURE: Array<{ tipoServico: { nome: string }; quantidade: number | null; ambiente: string | null }> = []

function resetMocks(statusInicial: string, tipoEmprestimo: 'interno' | 'externo' = 'interno') {
  solicitacao = {
    id: SOL_ID,
    status: statusInicial,
    numero: 42,
    solicitanteId: 'user-solicitante',
    tipoEmprestimo,
    data: new Date('2026-08-25'),
    periodos: ['MANHA'],
    ambiente: 'Laboratório 3',
    finalidade: 'Aula prática',
    atividadeExterna: null,
    local: null,
    cidade: null,
    observacoes: null,
    patrimonioDecisaoEm: null,
    patrimonioDecisorId: null,
  }
  solicitante = { nome: 'Fulano de Tal', email: 'fulano@example.com' }
  usuarios = []
  historicoCriado = []
  notificacaoCriada = []
  eventos = new Map()
  eventoSeq = 0
  emailEventoCreateCalls = []
  sendEmailCalls = []
  falharCriacaoNoIndice = null
}

function snapshot() {
  return {
    solicitacao: { ...solicitacao },
    historicoCriado: [...historicoCriado],
    notificacaoCriada: [...notificacaoCriada],
    eventos: new Map(Array.from(eventos.entries()).map(([k, v]) => [k, { ...v }])),
    eventoSeq,
    emailEventoCreateCalls: [...emailEventoCreateCalls],
  }
}

function restore(snap: ReturnType<typeof snapshot>) {
  Object.assign(solicitacao, snap.solicitacao)
  historicoCriado = snap.historicoCriado
  notificacaoCriada = snap.notificacaoCriada
  eventos = snap.eventos
  eventoSeq = snap.eventoSeq
  emailEventoCreateCalls = snap.emailEventoCreateCalls
}

function instalarMockPrisma() {
  // Simula rollback de verdade: se a callback da transação lançar, todo o
  // estado mutável (solicitacao, histórico, notificação, EmailEvento) volta
  // exatamente ao que era antes dela começar — ver cenário O.
  //
  // Serializada por uma fila (Etapa D.3.4): diferente dos demais mocks de
  // $transaction deste projeto (que só aplicam mutações diretas, sem
  // rollback), este aqui faz snapshot/restore — sem serialização, duas
  // "transações" rodando de verdade em paralelo (cenário N) poderiam
  // entrelaçar suas leituras/escritas do estado compartilhado de um jeito
  // que uma restauração tardia apaga o resultado já commitado da outra.
  // Uma transação real do Postgres serializa pela trava de linha; aqui a
  // fila reproduz esse mesmo efeito prático, sem precisar simular locks.
  let filaTransacoes: Promise<unknown> = Promise.resolve()
  prisma.$transaction = (fn: (tx: unknown) => Promise<unknown>) => {
    const execucao = filaTransacoes.then(async () => {
      const snap = snapshot()
      try {
        return await fn(prisma)
      } catch (err) {
        restore(snap)
        throw err
      }
    })
    filaTransacoes = execucao.catch(() => {})
    return execucao
  }

  prisma.solicitacao = {
    findUnique: async ({ where }: { where: { id: string } }) =>
      where.id === solicitacao.id ? { status: solicitacao.status, tipoEmprestimo: solicitacao.tipoEmprestimo } : null,
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if (where.id !== solicitacao.id) return { count: 0 }
      if ('status' in where && where.status !== solicitacao.status) return { count: 0 }
      Object.assign(solicitacao, data)
      return { count: 1 }
    },
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
      if (where.id !== solicitacao.id) throw new Error('Solicitação não encontrada (mock).')
      return {
        ...solicitacao,
        solicitante: { ...solicitante },
        itensPatrimonio: ITENS_PATRIMONIO_FIXTURE,
        itensPapelaria: ITENS_PAPELARIA_FIXTURE,
        itensServico: ITENS_SERVICO_FIXTURE,
      }
    },
  }

  prisma.historicoSolicitacao = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      historicoCriado.push(data)
      return data
    },
  }

  prisma.notificacao = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      notificacaoCriada.push(data)
      return data
    },
  }

  // findFirst (Etapa email-patrimonio-caixa-grupo): buscarDestinatariosReservaConfirmada()
  // usa isto SOMENTE como gate de existência (existe algum membro ativo com
  // permissao='patrimonio'?) — nunca mais para buscar e-mails individuais.
  prisma.user = {
    findFirst: async ({ where }: { where: { ativo?: boolean; permissao?: string } }) =>
      usuarios.find((u) => (where.ativo === undefined || u.ativo === where.ativo) && (where.permissao === undefined || u.permissao === where.permissao)) ?? null,
    // Etapa security/session-revocation: getValidatedMutationSession() faz
    // prisma.user.findUnique() para revalidar o usuário AUTENTICADO — nunca
    // um membro de `usuarios` (equipe Patrimônio elegível a receber
    // e-mail, fixture separada), sempre o ator da sessão mockada abaixo.
    findUnique: async ({ where }: { where: { id: string } }) =>
      where.id === 'user-patrimonio'
        ? { id: 'user-patrimonio', nome: 'Equipe Patrimônio', email: 'patrimonio-ator@example.com', permissao: 'patrimonio', ativo: true, podeSerGestor: false, podeSolicitarParaOutro: false, versaoSessao: 0 }
        : null,
  }

  prisma.emailEvento = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      emailEventoCreateCalls.push({ ...data })
      eventoSeq += 1
      if (falharCriacaoNoIndice !== null && eventoSeq === falharCriacaoNoIndice) {
        throw new Error('Falha simulada de banco ao criar EmailEvento.')
      }
      const id = `evt-${eventoSeq}`
      const evento: EventoFake = {
        id,
        solicitacaoId: data.solicitacaoId as string,
        tipo: data.tipo as string,
        destinatario: data.destinatario as string,
        status: (data.status as EventoFake['status']) ?? 'PENDENTE',
        tentativas: (data.tentativas as number) ?? 0,
        erro: null,
        enviadoEm: null,
      }
      eventos.set(id, evento)
      return { ...evento }
    },
    updateMany: async ({ where, data }: { where: { id: string; status?: string }; data: Record<string, unknown> }) => {
      const evento = eventos.get(where.id)
      if (!evento) return { count: 0 }
      if (where.status !== undefined && evento.status !== where.status) return { count: 0 }
      if (typeof data.status === 'string') evento.status = data.status as EventoFake['status']
      const inc = (data.tentativas as { increment?: number } | undefined)?.increment
      if (inc) evento.tentativas += inc
      return { count: 1 }
    },
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
      const evento = eventos.get(where.id)
      if (!evento) throw new Error('EmailEvento não encontrado (mock).')
      return { destinatario: evento.destinatario }
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const evento = eventos.get(where.id)
      if (!evento) throw new Error('EmailEvento não encontrado (mock).')
      if (typeof data.status === 'string') evento.status = data.status as EventoFake['status']
      if ('erro' in data) evento.erro = data.erro as string | null
      if ('enviadoEm' in data) evento.enviadoEm = data.enviadoEm as Date | null
      return { ...evento }
    },
  }
}

function instalarMockAuth() {
  authModule.getSession = async () => ({ id: 'user-patrimonio', nome: 'Equipe Patrimônio', permissao: 'patrimonio', versaoSessao: 0 })
}

function instalarMockSendEmailSucesso() {
  sendEmailModule.sendEmail = async (input: SendEmailInput): Promise<SendEmailResult> => {
    sendEmailCalls.push(input)
    return { success: true, providerId: `p-${sendEmailCalls.length}`, originalRecipient: input.to, physicalRecipient: input.to, isTest: false }
  }
}

async function silenciado(fn: () => Promise<void>): Promise<void> {
  const original = console.error
  console.error = () => {}
  try {
    await fn()
  } finally {
    console.error = original
  }
}

async function main() {
  instalarMockPrisma()
  instalarMockAuth()
  instalarMockSendEmailSucesso()
  resetEmailPatrimonioRecipientCache()

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rota = require('../src/app/api/solicitacoes/[id]/confirmar-patrimonio/route')

  // --- A) solicitante + equipe Patrimônio ativa → 2 EmailEvento (não N) ----
  // (também cobre G, H, I, J, K abaixo, reaproveitando esta mesma chamada)
  resetMocks('AGUARDANDO_PATRIMONIO', 'interno')
  usuarios = [
    { email: 'patrimonio1@example.com', ativo: true, permissao: 'patrimonio' },
    { email: 'patrimonio2@example.com', ativo: true, permissao: 'patrimonio' },
  ]
  {
    const res = await rota.POST(undefined, { params: Promise.resolve({ id: SOL_ID }) })
    assert(res.status === 200, 'A) resposta 200 na transição interna', res.status)
    assert(eventos.size === 2, 'A) exatamente 2 EmailEvento (solicitante + caixa de grupo — nunca 1 por membro)', Array.from(eventos.values()))
    assert(
      Array.from(eventos.values()).every((e) => e.tipo === 'RESERVA_CONFIRMADA' && e.solicitacaoId === SOL_ID),
      'A) todos os EmailEvento são RESERVA_CONFIRMADA desta solicitação',
      Array.from(eventos.values())
    )
    const destinatarios = Array.from(eventos.values()).map((e) => e.destinatario)
    assert(destinatarios.includes(solicitante.email), 'A) solicitante recebe seu próprio EmailEvento', destinatarios)
    assert(destinatarios.includes(GRUPO_PATRIMONIO), 'A) a caixa de grupo recebe o EmailEvento (não os e-mails individuais)', destinatarios)
    assert(
      !destinatarios.includes('patrimonio1@example.com') && !destinatarios.includes('patrimonio2@example.com'),
      'A) nenhum e-mail INDIVIDUAL de membro do Patrimônio recebe EmailEvento próprio',
      destinatarios
    )

    // G) EmailEvento criado PENDENTE dentro da transaction (payload capturado
    // no momento do create, antes de qualquer claim/processamento).
    assert(
      emailEventoCreateCalls.length === 2 && emailEventoCreateCalls.every((c) => c.status === 'PENDENTE'),
      'G) os 2 EmailEvento foram criados com status PENDENTE dentro da transaction',
      emailEventoCreateCalls
    )

    // H) processarEmailEvento foi chamado (via sendEmail real) para os 2 destinatários.
    assert(sendEmailCalls.length === 2, 'H) processarEmailEvento resultou em envio para os 2 destinatários', sendEmailCalls.length)
    assert(
      Array.from(eventos.values()).every((e) => e.status === 'ENVIADO'),
      'H) os 2 EmailEvento terminam ENVIADO após o processamento pós-commit',
      Array.from(eventos.values())
    )

    // I/K) template do solicitante usa papel solicitante (assunto "Sua reserva foi confirmada").
    const chamadaSolicitante = sendEmailCalls.find((c) => c.to === solicitante.email)
    assert(!!chamadaSolicitante?.subject.startsWith('[Fluxo Patrimonial] Sua reserva foi confirmada'), 'I) K) assunto do solicitante usa o papel solicitante', chamadaSolicitante?.subject)

    // J/K) template da caixa de grupo usa papel patrimonio (assunto "Reserva confirmada — # — Nome").
    const chamadaPatrimonio = sendEmailCalls.find((c) => c.to === GRUPO_PATRIMONIO)
    assert(
      !!chamadaPatrimonio?.subject.startsWith('[Fluxo Patrimonial] Reserva confirmada —') && chamadaPatrimonio.subject.includes(solicitante.nome),
      'J) K) assunto da caixa de grupo usa o papel patrimonio e inclui o nome do solicitante',
      chamadaPatrimonio?.subject
    )
  }

  // --- B) e-mail do solicitante coincide com a caixa de grupo → 1 evento, papel solicitante
  resetMocks('AGUARDANDO_PATRIMONIO', 'interno')
  solicitante = { nome: 'Fulano de Tal', email: GRUPO_PATRIMONIO }
  usuarios = [{ email: 'patrimonio1@example.com', ativo: true, permissao: 'patrimonio' }]
  {
    const res = await rota.POST(undefined, { params: Promise.resolve({ id: SOL_ID }) })
    assert(res.status === 200, 'B) resposta 200', res.status)
    assert(eventos.size === 1, 'B) apenas 1 EmailEvento (solicitante e caixa de grupo colapsam por serem o mesmo endereço)', Array.from(eventos.values()))
    const chamadaCompartilhada = sendEmailCalls.find((c) => c.to === GRUPO_PATRIMONIO)
    assert(
      !!chamadaCompartilhada?.subject.startsWith('[Fluxo Patrimonial] Sua reserva foi confirmada'),
      'B) e-mail compartilhado (solicitante com o mesmo endereço da caixa de grupo) usa o papel solicitante, não patrimonio',
      chamadaCompartilhada?.subject
    )
    solicitante = { nome: 'Fulano de Tal', email: 'fulano@example.com' }
  }

  // --- D/E/F) inativo, admin puro e colaborador (DIG/TI) não contam como Patrimônio ativo
  resetMocks('AGUARDANDO_PATRIMONIO', 'interno')
  usuarios = [
    { email: 'patrimonio-inativo@example.com', ativo: false, permissao: 'patrimonio' },
    { email: 'admin@example.com', ativo: true, permissao: 'administrador' },
    { email: 'dig-ti@example.com', ativo: true, permissao: 'colaborador' },
  ]
  {
    const res = await rota.POST(undefined, { params: Promise.resolve({ id: SOL_ID }) })
    assert(res.status === 200, 'D/E/F) resposta 200 mesmo sem nenhum Patrimônio ativo elegível', res.status)
    assert(eventos.size === 1, 'D/E/F) só o EmailEvento do solicitante — inativo/admin/colaborador não ativam a caixa de grupo', Array.from(eventos.values()))
    const destinatarios = Array.from(eventos.values()).map((e) => e.destinatario)
    assert(!destinatarios.includes(GRUPO_PATRIMONIO), 'D/E/F) caixa de grupo NÃO recebe e-mail sem nenhum Patrimônio ativo elegível', destinatarios)
  }
  // ...com 1 membro ativo de Patrimônio adicionado, a caixa de grupo passa a ser incluída.
  resetMocks('AGUARDANDO_PATRIMONIO', 'interno')
  usuarios = [
    { email: 'patrimonio-inativo@example.com', ativo: false, permissao: 'patrimonio' },
    { email: 'admin@example.com', ativo: true, permissao: 'administrador' },
    { email: 'dig-ti@example.com', ativo: true, permissao: 'colaborador' },
    { email: 'patrimonio-ativo@example.com', ativo: true, permissao: 'patrimonio' },
  ]
  {
    await rota.POST(undefined, { params: Promise.resolve({ id: SOL_ID }) })
    const destinatarios = Array.from(eventos.values()).map((e) => e.destinatario)
    assert(destinatarios.includes(GRUPO_PATRIMONIO), 'D/E/F) com 1 membro ativo elegível, a caixa de grupo recebe o EmailEvento', destinatarios)
    assert(!destinatarios.includes('patrimonio-ativo@example.com'), 'D/E/F) o e-mail INDIVIDUAL do membro ativo nunca recebe EmailEvento próprio', destinatarios)
  }

  // --- 14) Fluxo externo NÃO cria RESERVA_CONFIRMADA nesta rodada ----------
  resetMocks('AGUARDANDO_PATRIMONIO', 'externo')
  usuarios = [{ email: 'patrimonio1@example.com', ativo: true, permissao: 'patrimonio' }]
  {
    const res = await rota.POST(undefined, { params: Promise.resolve({ id: SOL_ID }) })
    const body = await res.json()
    assert(res.status === 200, '14) resposta 200 no fluxo externo', res.status)
    assert(body.solicitacao?.status === 'AGUARDANDO_ENVIO_ASSINATURA', '14) status final é AGUARDANDO_ENVIO_ASSINATURA', body.solicitacao?.status)
    assert(eventos.size === 0, '14) nenhum EmailEvento RESERVA_CONFIRMADA é criado para o fluxo externo', Array.from(eventos.values()))
    assert(sendEmailCalls.length === 0, '14) nenhum e-mail é enviado para o fluxo externo', sendEmailCalls.length)
  }

  // --- L) falha de APP_URL → evento termina FALHA, confirmação continua ----
  resetMocks('AGUARDANDO_PATRIMONIO', 'interno')
  usuarios = []
  {
    const appUrlOriginal = process.env.APP_URL
    process.env.APP_URL = ''
    resetAppUrlCache()

    let res!: Awaited<ReturnType<typeof rota.POST>>
    await silenciado(async () => {
      res = await rota.POST(undefined, { params: Promise.resolve({ id: SOL_ID }) })
    })
    const body = await res.json()

    assert(res.status === 200, 'L) confirmação continua bem-sucedida (200) mesmo com APP_URL inválido', res.status)
    assert(body.solicitacao?.status === 'EM_SEPARACAO', 'L) reserva continua EM_SEPARACAO apesar da falha de e-mail', body.solicitacao?.status)
    assert(eventos.size === 1, 'L) 1 EmailEvento foi criado (só o solicitante, sem equipe Patrimônio configurada)', Array.from(eventos.values()))
    assert(
      Array.from(eventos.values())[0]?.status === 'FALHA',
      'L) o EmailEvento termina FALHA (nunca fica PENDENTE preso) quando APP_URL é inválido',
      Array.from(eventos.values())
    )
    assert(sendEmailCalls.length === 0, 'L) o provedor nunca é chamado quando o build falha por APP_URL inválido', sendEmailCalls.length)

    process.env.APP_URL = appUrlOriginal
    resetAppUrlCache()
  }

  // --- M) falha do provedor → evento FALHA, confirmação continua sucesso ---
  resetMocks('AGUARDANDO_PATRIMONIO', 'interno')
  usuarios = []
  {
    sendEmailModule.sendEmail = async (input: SendEmailInput): Promise<SendEmailResult> => {
      sendEmailCalls.push(input)
      return { success: false, originalRecipient: input.to, physicalRecipient: input.to, isTest: false, error: 'Falha simulada do provedor.' }
    }

    const res = await rota.POST(undefined, { params: Promise.resolve({ id: SOL_ID }) })
    const body = await res.json()

    assert(res.status === 200, 'M) confirmação continua bem-sucedida (200) mesmo com falha do provedor', res.status)
    assert(body.solicitacao?.status === 'EM_SEPARACAO', 'M) reserva continua EM_SEPARACAO apesar da falha de envio', body.solicitacao?.status)
    assert(
      Array.from(eventos.values())[0]?.status === 'FALHA',
      'M) o EmailEvento termina FALHA quando o provedor falha',
      Array.from(eventos.values())
    )
    assert(sendEmailCalls.length === 1, 'M) o provedor foi chamado (e falhou) exatamente uma vez', sendEmailCalls.length)

    instalarMockSendEmailSucesso()
  }

  // --- Q) e-mail 1 sucesso, e-mail 2 falha → confirmação continua sucesso --
  // Correção pós-auditoria: prova que Promise.allSettled isola cada
  // destinatário — um falhar não impede nem desfaz o outro, e a resposta da
  // rota continua 200 porque a regra de negócio (transação) já commitou.
  resetMocks('AGUARDANDO_PATRIMONIO', 'interno')
  usuarios = [{ email: 'patrimonio1@example.com', ativo: true, permissao: 'patrimonio' }]
  {
    sendEmailModule.sendEmail = async (input: SendEmailInput): Promise<SendEmailResult> => {
      sendEmailCalls.push(input)
      if (input.to === solicitante.email) {
        return { success: true, providerId: 'p-q-1', originalRecipient: input.to, physicalRecipient: input.to, isTest: false }
      }
      return { success: false, originalRecipient: input.to, physicalRecipient: input.to, isTest: false, error: 'Falha simulada do provedor (destinatário 2).' }
    }

    const res = await rota.POST(undefined, { params: Promise.resolve({ id: SOL_ID }) })
    const body = await res.json()

    assert(res.status === 200, 'Q) resposta 200 quando um dos 2 e-mails falha', res.status)
    assert(body.solicitacao?.status === 'EM_SEPARACAO', 'Q) status correto mesmo com falha parcial de e-mail', body.solicitacao?.status)
    assert(historicoCriado.length === 1, 'Q) histórico registrado normalmente', historicoCriado)
    assert(notificacaoCriada.length === 1, 'Q) notificação registrada normalmente', notificacaoCriada)
    const porDestinatario = new Map(Array.from(eventos.values()).map((e) => [e.destinatario, e.status]))
    assert(porDestinatario.get(solicitante.email) === 'ENVIADO', 'Q) EmailEvento do solicitante (sucesso) termina ENVIADO', Array.from(eventos.values()))
    assert(porDestinatario.get(GRUPO_PATRIMONIO) === 'FALHA', 'Q) EmailEvento da caixa de grupo (falha) termina FALHA', Array.from(eventos.values()))

    instalarMockSendEmailSucesso()
  }

  // --- R) e-mail 1 falha, e-mail 2 sucesso → mesma garantia, ordem inversa -
  resetMocks('AGUARDANDO_PATRIMONIO', 'interno')
  usuarios = [{ email: 'patrimonio1@example.com', ativo: true, permissao: 'patrimonio' }]
  {
    sendEmailModule.sendEmail = async (input: SendEmailInput): Promise<SendEmailResult> => {
      sendEmailCalls.push(input)
      if (input.to === solicitante.email) {
        return { success: false, originalRecipient: input.to, physicalRecipient: input.to, isTest: false, error: 'Falha simulada do provedor (destinatário 1).' }
      }
      return { success: true, providerId: 'p-r-2', originalRecipient: input.to, physicalRecipient: input.to, isTest: false }
    }

    const res = await rota.POST(undefined, { params: Promise.resolve({ id: SOL_ID }) })
    const body = await res.json()

    assert(res.status === 200, 'R) resposta 200 quando o e-mail 1 falha e o 2 tem sucesso', res.status)
    assert(body.solicitacao?.status === 'EM_SEPARACAO', 'R) status correto mesmo com falha parcial de e-mail (ordem inversa)', body.solicitacao?.status)
    const porDestinatario = new Map(Array.from(eventos.values()).map((e) => [e.destinatario, e.status]))
    assert(porDestinatario.get(solicitante.email) === 'FALHA', 'R) EmailEvento do solicitante (falha) termina FALHA', Array.from(eventos.values()))
    assert(porDestinatario.get(GRUPO_PATRIMONIO) === 'ENVIADO', 'R) EmailEvento da caixa de grupo (sucesso) termina ENVIADO', Array.from(eventos.values()))

    instalarMockSendEmailSucesso()
  }

  // --- S) todos os e-mails pós-commit falham → confirmação continua sucesso
  resetMocks('AGUARDANDO_PATRIMONIO', 'interno')
  usuarios = [{ email: 'patrimonio1@example.com', ativo: true, permissao: 'patrimonio' }]
  {
    sendEmailModule.sendEmail = async (input: SendEmailInput): Promise<SendEmailResult> => {
      sendEmailCalls.push(input)
      return { success: false, originalRecipient: input.to, physicalRecipient: input.to, isTest: false, error: 'Falha simulada do provedor (todos).' }
    }

    const res = await rota.POST(undefined, { params: Promise.resolve({ id: SOL_ID }) })
    const body = await res.json()

    assert(res.status === 200, 'S) resposta 200 mesmo quando TODOS os e-mails pós-commit falham', res.status)
    assert(body.solicitacao?.status === 'EM_SEPARACAO', 'S) status permanece EM_SEPARACAO quando todos os e-mails falham', body.solicitacao?.status)
    assert(historicoCriado.length === 1, 'S) histórico não é desfeito quando todos os e-mails falham', historicoCriado)
    assert(notificacaoCriada.length === 1, 'S) notificação não é desfeita quando todos os e-mails falham', notificacaoCriada)
    assert(eventos.size === 2, 'S) os 2 EmailEvento continuam persistidos (nenhum é apagado/desfeito)', Array.from(eventos.values()))
    assert(
      Array.from(eventos.values()).every((e) => e.status === 'FALHA'),
      'S) todos os EmailEvento terminam FALHA, nenhum fica PENDENTE ou é revertido',
      Array.from(eventos.values())
    )

    instalarMockSendEmailSucesso()
  }

  // --- N) concorrência: só o vencedor cria EmailEvento ----------------------
  resetMocks('AGUARDANDO_PATRIMONIO', 'interno')
  usuarios = []
  {
    const [res1, res2] = await Promise.all([
      rota.POST(undefined, { params: Promise.resolve({ id: SOL_ID }) }),
      rota.POST(undefined, { params: Promise.resolve({ id: SOL_ID }) }),
    ])
    const statuses = [res1.status, res2.status].sort()
    assert(JSON.stringify(statuses) === JSON.stringify([200, 409]), 'N) uma chamada retorna 200 e a outra 409', statuses)
    assert(historicoCriado.length === 1, 'N) só um histórico é criado', historicoCriado)
    assert(notificacaoCriada.length === 1, 'N) só uma notificação é criada', notificacaoCriada)
    assert(eventos.size === 1, 'N) só um EmailEvento é criado (nenhuma duplicação pela corrida)', Array.from(eventos.values()))
  }

  // --- O) rollback da transaction → nenhum EmailEvento persiste ------------
  resetMocks('AGUARDANDO_PATRIMONIO', 'interno')
  usuarios = [{ email: 'patrimonio1@example.com', ativo: true, permissao: 'patrimonio' }]
  // Falha simulada de banco na criação do 2º EmailEvento (dentro do loop, na
  // mesma transaction, ainda hoje até 2 EmailEvento — solicitante + grupo)
  // — uma transação real do Postgres desfaria também o 1º create já
  // executado; o mock de $transaction acima reproduz esse comportamento via
  // snapshot/restore.
  falharCriacaoNoIndice = 2
  {
    let res!: Awaited<ReturnType<typeof rota.POST>>
    await silenciado(async () => {
      res = await rota.POST(undefined, { params: Promise.resolve({ id: SOL_ID }) })
    })

    assert(res.status === 500, 'O) a rota responde 500 quando a transaction falha ao criar um EmailEvento', res.status)
    assert(eventos.size === 0, 'O) nenhum EmailEvento persiste — inclusive o 1º, criado antes da falha do 2º', Array.from(eventos.values()))
    assert(historicoCriado.length === 0, 'O) histórico também é desfeito (rollback completo da transaction)', historicoCriado)
    assert(notificacaoCriada.length === 0, 'O) notificação também é desfeita', notificacaoCriada)
    assert(solicitacao.status === 'AGUARDANDO_PATRIMONIO', 'O) status da solicitação é revertido para o original', solicitacao.status)
    assert(sendEmailCalls.length === 0, 'O) nenhum e-mail é enviado quando a transaction é desfeita', sendEmailCalls.length)
  }

  // --- P) snapshot histórico imune a mutação do catálogo depois da criação -
  // Etapa D.3.6.4 — prova diretamente o achado do Codex Review na Etapa
  // D.3: uma vez persistido, o payload de RESERVA_CONFIRMADA nunca reflete
  // uma edição posterior do catálogo (Patrimonio/CategoriaPatrimonio).
  resetMocks('AGUARDANDO_PATRIMONIO', 'interno')
  usuarios = []
  {
    const res = await rota.POST(undefined, { params: Promise.resolve({ id: SOL_ID }) })
    assert(res.status === 200, 'P) resposta 200', res.status)

    const payloadPersistido = emailEventoCreateCalls[0]?.payload as ReservaConfirmadaPayloadV1 | undefined
    assert(
      payloadPersistido?.itensPatrimonio[0]?.numero === 'PAT-1' &&
        payloadPersistido?.itensPatrimonio[0]?.marca === 'Dell' &&
        payloadPersistido?.itensPatrimonio[0]?.modelo === 'Latitude' &&
        payloadPersistido?.itensPatrimonio[0]?.categoria === 'Notebook',
      'P) EmailEvento.payload persistido contém os valores históricos do catálogo (PAT-1/Dell/Latitude/Notebook)',
      payloadPersistido
    )
    assert(
      !!sendEmailCalls[0]?.html.includes('PAT-1') && !!sendEmailCalls[0]?.html.includes('Dell'),
      'P) e-mail inline (enviado antes de qualquer mutação) já usa os valores históricos corretos',
      sendEmailCalls[0]?.html
    )

    // Muta o "catálogo" (o mock compartilhado por todos os cenários deste
    // arquivo) DEPOIS que o payload já foi persistido e o e-mail inline já
    // foi enviado — simula um administrador editando o bem/categoria antes
    // de um reprocessamento futuro (ex.: dispatcher).
    const original = { ...ITENS_PATRIMONIO_FIXTURE[0].patrimonio, categoria: { ...ITENS_PATRIMONIO_FIXTURE[0].patrimonio.categoria } }
    ITENS_PATRIMONIO_FIXTURE[0].patrimonio.numero = 'PAT-999'
    ITENS_PATRIMONIO_FIXTURE[0].patrimonio.marca = 'Lenovo'
    ITENS_PATRIMONIO_FIXTURE[0].patrimonio.modelo = 'ThinkCentre'
    ITENS_PATRIMONIO_FIXTURE[0].patrimonio.categoria.nome = 'Equipamento'

    assert(
      payloadPersistido?.itensPatrimonio[0]?.numero === 'PAT-1' && payloadPersistido?.itensPatrimonio[0]?.marca === 'Dell',
      'P) payload já persistido continua com os valores históricos mesmo após o "catálogo" (mock) ser mutado depois',
      payloadPersistido
    )

    // Simula um reprocessamento futuro (ex.: dispatcher) a partir do MESMO
    // payload já persistido — nunca relendo o catálogo mutado.
    const reenvio = payloadPersistido && renderReservaConfirmadaFromPayload(payloadPersistido, 'https://app.example.com/x', null)
    assert(
      !!reenvio?.html.includes('PAT-1') && !!reenvio?.html.includes('Dell') && !!reenvio?.html.includes('Latitude'),
      'P) reprocessamento a partir do payload persistido usa SOMENTE os valores históricos',
      reenvio?.html
    )
    assert(
      !reenvio?.html.includes('PAT-999') && !reenvio?.html.includes('Lenovo') && !reenvio?.html.includes('ThinkCentre') && !reenvio?.html.includes('Equipamento'),
      'P) reprocessamento NÃO reflete a mutação do catálogo feita depois',
      reenvio?.html
    )

    // Restaura o fixture compartilhado para não vazar estado para o resto do arquivo.
    Object.assign(ITENS_PATRIMONIO_FIXTURE[0].patrimonio, original)
  }

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) de RESERVA_CONFIRMADA em /confirmar-patrimonio (fluxo interno) falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes de RESERVA_CONFIRMADA em /confirmar-patrimonio (fluxo interno) passaram. Nenhum e-mail real foi enviado, nenhum banco real foi acessado.')
}

main().catch((err) => {
  console.error('Falha inesperada ao executar os testes de RESERVA_CONFIRMADA em /confirmar-patrimonio:', err instanceof Error ? err.message : err)
  process.exit(1)
})
