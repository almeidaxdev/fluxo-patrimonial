// scripts/test-solicitacoes-aprovar-gestor.ts
//
// Teste manual (mesmo padrão de scripts/test-solicitacoes-cancelar.ts) da
// Etapa email-aguardando-patrimonio: SOLICITACAO_AGUARDANDO_PATRIMONIO
// criado em POST /api/solicitacoes/[id]/aprovar-gestor quando o gestor
// aprova uma atividade externa e ela entra em AGUARDANDO_PATRIMONIO — um
// evento por membro ATIVO da equipe Patrimônio (permissao='patrimonio'),
// nunca para o solicitante, o gestor, ou administradores sem essa
// permissão.
//
// Importa e chama o handler POST REAL da rota — prisma, getSession e
// sendEmail() são mocks em memória; processarEmailEvento(),
// criarValidadorDeEvento() e buildAppUrl() rodam DE VERDADE. Não abre
// conexão real com o banco nem envia e-mail real pelo Resend.
//
// Obsolescência (Patrimônio confirma/rejeita/cancela antes do dispatch) é
// coberta genericamente por scripts/test-email-validade-evento.ts
// (cenários L-O) — não duplicada aqui.
//
// Etapa fix/atomic-request-transitions: a rota passou a usar
// `tx.solicitacao.updateMany` condicionado ao status EXATO lido antes —
// mesmo padrão de scripts/test-solicitacoes-cancelar.ts (cenário M) — o
// mock abaixo reproduz essa semântica ATÔMICA (checa `status` esperado e
// grava num único passo síncrono). O cenário J agora exige vitória/derrota
// explícitas (200/409), não só ausência de duplicidade de e-mail.
//
// Executar com: npm run test:solicitacoes-aprovar-gestor

import type { SendEmailInput, SendEmailResult } from '../src/lib/email/send-email'

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
import { resetEmailConfigCache, resetEmailPatrimonioRecipientCache } from '../src/lib/email/config'

let failures = 0

function assert(condition: boolean, label: string, detalhe?: unknown) {
  if (condition) {
    console.log(`OK   - ${label}`)
  } else {
    failures++
    console.error(`FALHA - ${label}${detalhe !== undefined ? ` (${JSON.stringify(detalhe)})` : ''}`)
  }
}

// --- Fixtures --------------------------------------------------------------

const SOLICITANTE = { id: 'user-solicitante', nome: 'Fulano Solicitante', email: 'fulano@example.com' }
const GESTOR_SESSION = { id: 'user-gestor', nome: 'Ciclana Gestora', email: 'ciclana@example.com', permissao: 'colaborador' as const, versaoSessao: 0 }
const SOL_ID = 'sol-aprovar-1'

// Etapa security/session-revocation: getValidatedMutationSession() faz UMA
// consulta a prisma.user.findUnique() (fora da transação) para revalidar a
// sessão ANTES de a rota abrir `prisma.$transaction` — precisa de um
// registro "de banco" por ator de sessão usado neste arquivo, ativo e com a
// MESMA versaoSessao da sessão mockada.
const USUARIOS_DB_FAKE: Record<string, { id: string; nome: string; email: string; permissao: 'colaborador' | 'patrimonio' | 'administrador'; ativo: boolean; podeSerGestor: boolean; podeSolicitarParaOutro: boolean; versaoSessao: number }> = {
  [GESTOR_SESSION.id]: { id: GESTOR_SESSION.id, nome: GESTOR_SESSION.nome, email: GESTOR_SESSION.email, permissao: 'colaborador', ativo: true, podeSerGestor: true, podeSolicitarParaOutro: false, versaoSessao: GESTOR_SESSION.versaoSessao },
  'user-outro-gestor': { id: 'user-outro-gestor', nome: 'Outro Gestor', email: 'outro@example.com', permissao: 'colaborador', ativo: true, podeSerGestor: true, podeSolicitarParaOutro: false, versaoSessao: 0 },
}

interface SolicitacaoFake {
  id: string
  numero: number
  status: string
  solicitanteId: string
  gestorId: string | null
  data: Date
  periodos: string[]
  finalidade: string | null
  atividadeExterna: string | null
  local: string | null
  cidade: string | null
  observacoes: string | null
  notebooksComDominio: boolean | null
  tipoDominio: string | null
}

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

let solicitacaoFake: SolicitacaoFake
let usuariosFake: UserFake[]
let eventoSeq: number
let eventos: Map<string, EventoFake>
let eventosPorChave: Map<string, string>
let emailEventoCreateCalls: Array<Record<string, unknown>>
let notificacaoCriada: Array<Record<string, unknown>>
let sendEmailCalls: SendEmailInput[]
let transactionOptionsCapturadas: Record<string, unknown> | undefined

function resetMocks(usuarios: UserFake[] = []) {
  solicitacaoFake = {
    id: SOL_ID,
    numero: 33,
    status: 'AGUARDANDO_GESTOR',
    solicitanteId: SOLICITANTE.id,
    gestorId: GESTOR_SESSION.id,
    data: new Date('2026-09-30'),
    periodos: ['MANHA'],
    finalidade: null,
    atividadeExterna: 'Feira de tecnologia',
    local: 'Centro de Convenções',
    cidade: 'São Paulo',
    observacoes: null,
    notebooksComDominio: null,
    tipoDominio: null,
  }
  usuariosFake = usuarios
  eventoSeq = 0
  eventos = new Map()
  eventosPorChave = new Map()
  emailEventoCreateCalls = []
  notificacaoCriada = []
  sendEmailCalls = []
}

function instalarMockPrisma() {
  prisma.user = {
    findUnique: async ({ where }: { where: { id: string } }) => (USUARIOS_DB_FAKE[where.id] ? { ...USUARIOS_DB_FAKE[where.id] } : null),
  }

  prisma.solicitacao = {
    findUnique: async () => ({ status: solicitacaoFake.status }),
  }

  const tx = {
    solicitacao: {
      findUnique: async ({ where }: { where: { id: string } }) => (where.id === solicitacaoFake.id ? { ...solicitacaoFake } : null),
      updateMany: async ({ where, data }: { where: { id: string; status: string }; data: Record<string, unknown> }) => {
        if (where.id !== solicitacaoFake.id || where.status !== solicitacaoFake.status) return { count: 0 }
        if (typeof data.status === 'string') solicitacaoFake.status = data.status
        return { count: 1 }
      },
      findUniqueOrThrow: async ({ where, include }: { where: { id: string }; include?: Record<string, unknown> }) => {
        if (where.id !== solicitacaoFake.id) throw new Error('Solicitação não encontrada (mock).')
        if (!include) return { ...solicitacaoFake }
        return {
          ...solicitacaoFake,
          solicitante: { nome: SOLICITANTE.nome },
          itensPatrimonio: [],
          itensPapelaria: [{ descricao: 'Caneta', quantidade: 5 }],
          itensServico: [],
        }
      },
    },
    user: {
      findMany: async ({ where }: { where: { ativo: boolean; permissao: string } }) =>
        usuariosFake.filter((u) => u.ativo === where.ativo && u.permissao === where.permissao).map((u) => ({ id: u.id, email: u.email })),
    },
    historicoSolicitacao: { create: async () => ({}) },
    notificacao: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        notificacaoCriada.push(data)
        return { ...data }
      },
    },
    emailEvento: {
      upsert: (args: { where: { solicitacaoId_tipo_destinatario: { solicitacaoId: string; tipo: string; destinatario: string } }; create: Record<string, unknown> }) => {
        const chaveObj = args.where.solicitacaoId_tipo_destinatario
        const chave = `${chaveObj.solicitacaoId}|${chaveObj.tipo}|${chaveObj.destinatario}`
        const existenteId = eventosPorChave.get(chave)
        if (existenteId) {
          return Promise.resolve({ ...eventos.get(existenteId) })
        }
        emailEventoCreateCalls.push(args.create)
        const id = `evento-${++eventoSeq}`
        const novo: EventoFake = {
          id,
          tipo: args.create.tipo as string,
          destinatario: args.create.destinatario as string,
          status: 'PENDENTE',
          tentativas: 0,
          erro: null,
          enviadoEm: null,
          payload: args.create.payload,
        }
        eventos.set(id, novo)
        eventosPorChave.set(chave, id)
        return Promise.resolve({ ...novo })
      },
    },
  }

  prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>, options?: Record<string, unknown>) => {
    transactionOptionsCapturadas = options
    return fn(tx)
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
  authModule.getSession = async () => ({ ...GESTOR_SESSION })
}

async function postar() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rota = require('../src/app/api/solicitacoes/[id]/aprovar-gestor/route')
  const req = {} as unknown as Parameters<typeof rota.POST>[0]
  return rota.POST(req, { params: Promise.resolve({ id: SOL_ID }) })
}

async function main() {
  instalarMockPrisma()
  instalarMockGetSession()
  instalarMockSendEmail((input) => ({ success: true, providerId: `p-${input.to}`, originalRecipient: input.to, physicalRecipient: input.to, isTest: false }))
  resetEmailPatrimonioRecipientCache()

  const PATRIMONIO_1: UserFake = { id: 'user-patrimonio-1', email: 'patrimonio1@example.com', ativo: true, permissao: 'patrimonio' }
  const PATRIMONIO_2: UserFake = { id: 'user-patrimonio-2', email: 'patrimonio2@example.com', ativo: true, permissao: 'patrimonio' }
  const PATRIMONIO_INATIVO: UserFake = { id: 'user-patrimonio-3', email: 'patrimonio-inativo@example.com', ativo: false, permissao: 'patrimonio' }
  const ADMIN_SEM_PERMISSAO: UserFake = { id: 'user-admin', email: 'admin@example.com', ativo: true, permissao: 'administrador' }

  // --- A) gestor aprova externa → status AGUARDANDO_PATRIMONIO -----------------------
  resetMocks([PATRIMONIO_1])
  {
    const res = await postar()
    assert(res.status === 200, 'A) resposta 200 ao aprovar', res.status)
    assert(solicitacaoFake.status === 'AGUARDANDO_PATRIMONIO', 'A) solicitação passa para AGUARDANDO_PATRIMONIO', solicitacaoFake.status)
    // Correção P2028 confirmado em produção (Runtime Logs Vercel): a rota
    // precisa passar maxWait/timeout explícitos para prisma.$transaction —
    // mesmos valores já homologados em POST /api/solicitacoes.
    assert(transactionOptionsCapturadas?.maxWait === 5000, 'A) $transaction recebe maxWait explícito (5000)', transactionOptionsCapturadas)
    assert(transactionOptionsCapturadas?.timeout === 15000, 'A) $transaction recebe timeout explícito (15000)', transactionOptionsCapturadas)
  }

  // --- B) equipe Patrimônio ativa → exatamente 1 EmailEvento para a caixa de grupo ----
  resetMocks([PATRIMONIO_1])
  {
    await postar()
    assert(emailEventoCreateCalls.length === 1, 'B) exatamente 1 EmailEvento (a caixa de grupo, nunca 1 por membro)', emailEventoCreateCalls.length)
    assert(emailEventoCreateCalls[0]?.tipo === 'SOLICITACAO_AGUARDANDO_PATRIMONIO', 'B) tipo do evento é SOLICITACAO_AGUARDANDO_PATRIMONIO', emailEventoCreateCalls[0]?.tipo)
    assert(emailEventoCreateCalls[0]?.destinatario === GRUPO_PATRIMONIO, 'B) destinatário é a caixa de grupo, não o e-mail individual do Patrimônio', emailEventoCreateCalls[0]?.destinatario)
    const ev = Array.from(eventos.values())[0]
    assert(ev?.status === 'ENVIADO', 'B) evento termina ENVIADO', ev?.status)
  }

  // --- C) solicitante não recebe --- D) gestor não recebe -----------------------------
  resetMocks([PATRIMONIO_1])
  {
    await postar()
    const destinatarios = emailEventoCreateCalls.map((e) => e.destinatario)
    assert(!destinatarios.includes(SOLICITANTE.email), 'C) solicitante NÃO recebe este evento', destinatarios)
    assert(!destinatarios.includes(GESTOR_SESSION.email), 'D) gestor que aprovou NÃO recebe este evento', destinatarios)
  }

  // --- E) admin sem permissao='patrimonio' não conta como elegível ------------------------
  resetMocks([PATRIMONIO_1, ADMIN_SEM_PERMISSAO])
  {
    await postar()
    const destinatarios = emailEventoCreateCalls.map((e) => e.destinatario)
    assert(destinatarios.includes(GRUPO_PATRIMONIO), 'E) com 1 membro ativo elegível (mesmo ao lado de um admin sem a permissão), a caixa de grupo recebe', destinatarios)
    assert(!destinatarios.includes(ADMIN_SEM_PERMISSAO.email), 'E) o e-mail do administrador sem permissao=patrimonio nunca aparece', destinatarios)
  }

  // --- F) só Patrimônio inativo → caixa de grupo NÃO recebe -------------------------------
  resetMocks([PATRIMONIO_INATIVO])
  {
    await postar()
    const destinatarios = emailEventoCreateCalls.map((e) => e.destinatario)
    assert(!destinatarios.includes(GRUPO_PATRIMONIO), 'F) usuário Patrimônio inativo sozinho NÃO ativa a caixa de grupo', destinatarios)
    assert(!destinatarios.includes(PATRIMONIO_INATIVO.email), 'F) o e-mail individual do usuário inativo nunca aparece', destinatarios)
  }

  // --- G) dois Patrimônios ativos distintos → ainda assim 1 único evento (a caixa de grupo)
  resetMocks([PATRIMONIO_1, PATRIMONIO_2])
  {
    await postar()
    const destinatarios = emailEventoCreateCalls.map((e) => e.destinatario)
    assert(destinatarios.length === 1, 'G) exatamente 1 evento mesmo com 2 Patrimônios ativos distintos (nunca 1 por membro)', destinatarios)
    assert(destinatarios[0] === GRUPO_PATRIMONIO, 'G) o único evento é para a caixa de grupo', destinatarios)
  }

  // --- I) nenhum Patrimônio ativo → aprovação continua sem erro, zero eventos -----------
  resetMocks([])
  {
    const res = await postar()
    assert(res.status === 200, 'I) aprovação continua respondendo 200 mesmo sem Patrimônio ativo', res.status)
    assert(solicitacaoFake.status === 'AGUARDANDO_PATRIMONIO', 'I) status ainda transiciona normalmente', solicitacaoFake.status)
    assert(emailEventoCreateCalls.length === 0, 'I) zero EmailEvento criado sem destinatário Patrimônio', emailEventoCreateCalls.length)
  }

  // --- J) concorrência/repetição não duplica ---------------------------------------------
  // Etapa fix/atomic-request-transitions: o `updateMany` condicional só
  // casa o status EXATO lido antes (AGUARDANDO_GESTOR) — das duas chamadas
  // concorrentes, só a que chega primeiro ao update efetivamente muda o
  // status; a segunda casa 0 linhas e recebe 409, sem tocar em
  // histórico/notificação/e-mail (mesmo padrão de /cancelar, cenário M, e
  // de /rejeitar-gestor e /rejeitar-patrimonio, cenários N/Z).
  resetMocks([PATRIMONIO_1])
  {
    const [r1, r2] = await Promise.all([postar(), postar()])
    const statuses = [r1.status, r2.status].sort()
    assert(statuses[0] === 200 && statuses[1] === 409, 'J) exatamente uma das duas chamadas concorrentes vence (200), a outra perde (409) — updateMany condicional da própria rota', statuses)
    assert(emailEventoCreateCalls.length === 1, 'J) apenas 1 EmailEvento é criado (transição atômica evita que a perdedora chegue a criar evento)', emailEventoCreateCalls.length)
    assert(eventos.size === 1, 'J) apenas 1 linha existe para a chave [solicitacaoId, tipo, destinatario]', eventos.size)
  }

  // --- EMAIL_TEST_MODE preserva destinatário lógico -----------------------------------
  resetMocks([PATRIMONIO_1])
  process.env.EMAIL_TEST_MODE = 'true'
  process.env.EMAIL_TEST_RECIPIENT = 'caixa-de-teste@example.com'
  resetEmailConfigCache()
  {
    await postar()
    assert(emailEventoCreateCalls[0]?.destinatario === GRUPO_PATRIMONIO, 'EmailEvento.destinatario continua sendo a caixa de grupo (destinatário lógico) em EMAIL_TEST_MODE', emailEventoCreateCalls[0]?.destinatario)
  }
  process.env.EMAIL_TEST_MODE = 'false'
  delete process.env.EMAIL_TEST_RECIPIENT
  resetEmailConfigCache()

  // --- permissão: gestor de outra solicitação não consegue aprovar (nem gera evento) -----
  resetMocks([PATRIMONIO_1])
  const outroGestor = { id: 'user-outro-gestor', nome: 'Outro Gestor', email: 'outro@example.com', permissao: 'colaborador' as const, versaoSessao: 0 }
  authModule.getSession = async () => ({ ...outroGestor })
  const resPermissao = await postar()
  assert(resPermissao.status === 403, 'permissão: gestor de outra solicitação recebe 403', resPermissao.status)
  assert(emailEventoCreateCalls.length === 0, 'permissão: nenhum EmailEvento é criado quando a aprovação é negada', emailEventoCreateCalls.length)
  instalarMockGetSession()

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) de SOLICITACAO_AGUARDANDO_PATRIMONIO em POST /api/solicitacoes/[id]/aprovar-gestor falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes de SOLICITACAO_AGUARDANDO_PATRIMONIO em POST /api/solicitacoes/[id]/aprovar-gestor passaram. Nenhum e-mail real foi enviado, nenhum banco real foi acessado.')
}

main().catch((err) => {
  console.error('Falha inesperada ao executar os testes de aprovar-gestor:', err instanceof Error ? err.message : err)
  process.exit(1)
})
