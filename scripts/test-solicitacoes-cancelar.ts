// scripts/test-solicitacoes-cancelar.ts
//
// Teste manual (mesmo padrão de scripts/test-solicitacoes-rejeicoes.ts) da
// Etapa email-cancelamento: CANCELAMENTO criado em
// POST /api/solicitacoes/[id]/cancelar — sempre para o solicitante, e
// condicionalmente para toda a equipe Patrimônio ativa quando o status
// ANTERIOR ao cancelamento indica que o Patrimônio já estava
// operacionalmente envolvido (ASSINATURA_CONFIRMADA, EM_SEPARACAO,
// PRONTA_RETIRADA — ver STATUS_ANTERIOR_PATRIMONIO_OPERACIONAL na rota).
//
// Importa e chama o handler POST REAL da rota — prisma, getSession e
// sendEmail() são mocks em memória; processarEmailEvento(),
// criarValidadorDeEvento() e buildAppUrl() rodam DE VERDADE. Não abre
// conexão real com o banco nem envia e-mail real pelo Resend.
//
// O mock de tx.emailEvento.upsert() abaixo reproduz a semântica ATÔMICA da
// unique [solicitacaoId, tipo, destinatario] — necessário para o cenário M.
//
// Executar com: npm run test:solicitacoes-cancelar

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

const SOLICITANTE = { id: 'user-solicitante', nome: 'Fulano Solicitante', email: 'fulano@example.com', permissao: 'colaborador' as const, versaoSessao: 0 }
// Ator "outro usuário" que cancela em nome do solicitante — precisa ter
// isPatrimonioOuAdmin() = true (src/lib/permissions.ts), já que a rota só
// permite cancelamento pelo próprio solicitante OU por Patrimônio/admin
// (nunca por um colaborador/gestor qualquer, sem essa permissão). Distinto
// de qualquer usuário usado nas fixtures de `usuariosFake` (equipe
// Patrimônio elegível a receber e-mail) — este é só quem CLICOU cancelar.
const OUTRO_ATOR_SESSION = { id: 'user-outro-ator', nome: 'Beltrano Administrador', email: 'beltrano-ator@example.com', permissao: 'administrador' as const, versaoSessao: 0 }
const SOL_ID = 'sol-cancelar-1'

// Etapa security/session-revocation: getValidatedMutationSession() faz UMA
// consulta a prisma.user.findUnique() (fora da transação) para revalidar a
// sessão ANTES da rota abrir `prisma.$transaction` — precisa de um registro
// "de banco" por ator de sessão usado neste arquivo, sempre ativo e com a
// MESMA versaoSessao da sessão mockada (ver instalarMockGetSession abaixo).
const USUARIOS_DB_FAKE: Record<string, { id: string; nome: string; email: string; permissao: 'colaborador' | 'patrimonio' | 'administrador'; ativo: boolean; podeSerGestor: boolean; podeSolicitarParaOutro: boolean; versaoSessao: number }> = {
  [SOLICITANTE.id]: { id: SOLICITANTE.id, nome: SOLICITANTE.nome, email: SOLICITANTE.email, permissao: SOLICITANTE.permissao, ativo: true, podeSerGestor: false, podeSolicitarParaOutro: false, versaoSessao: SOLICITANTE.versaoSessao },
  [OUTRO_ATOR_SESSION.id]: { id: OUTRO_ATOR_SESSION.id, nome: OUTRO_ATOR_SESSION.nome, email: OUTRO_ATOR_SESSION.email, permissao: OUTRO_ATOR_SESSION.permissao, ativo: true, podeSerGestor: false, podeSolicitarParaOutro: false, versaoSessao: OUTRO_ATOR_SESSION.versaoSessao },
}

interface SolicitacaoFake {
  id: string
  numero: number
  tipoEmprestimo: 'interno' | 'externo'
  status: string
  solicitanteId: string
  data: Date
  periodos: string[]
  ambiente: string | null
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

function resetMocks(statusInicial: string = 'AGUARDANDO_GESTOR', usuarios: UserFake[] = []) {
  solicitacaoFake = {
    id: SOL_ID,
    numero: 66,
    tipoEmprestimo: 'externo',
    status: statusInicial,
    solicitanteId: SOLICITANTE.id,
    data: new Date('2026-09-20'),
    periodos: ['TARDE'],
    ambiente: null,
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
          solicitante: { nome: SOLICITANTE.nome, email: SOLICITANTE.email },
          itensPatrimonio: [],
          itensPapelaria: [{ descricao: 'Caneta', quantidade: 5 }],
          itensServico: [],
        }
      },
    },
    // tx.user (Etapa email-patrimonio-caixa-grupo): a rota deixou de
    // consultar a equipe Patrimônio para montar destinatários de e-mail —
    // `patrimonioElegivel` (status anterior) é o único gate, e o endereço
    // vem de EMAIL_PATRIMONIO_RECIPIENT, não do banco. Nenhum mock de
    // tx.user é necessário aqui (a rota não o chama mais).
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

  prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)

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

function instalarMockGetSession(sessao: typeof OUTRO_ATOR_SESSION | typeof SOLICITANTE) {
  authModule.getSession = async () => ({ ...sessao })
}

async function postar() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rota = require('../src/app/api/solicitacoes/[id]/cancelar/route')
  const req = {} as unknown as Parameters<typeof rota.POST>[0]
  return rota.POST(req, { params: Promise.resolve({ id: SOL_ID }) })
}

async function main() {
  instalarMockPrisma()
  instalarMockSendEmail((input) => ({ success: true, providerId: `p-${input.to}`, originalRecipient: input.to, physicalRecipient: input.to, isTest: false }))

  // ============================== SOLICITANTE (A-M) ==============================

  // --- A) exatamente 1 EmailEvento CANCELAMENTO para solicitante -----------------------
  resetMocks('AGUARDANDO_GESTOR')
  instalarMockGetSession(OUTRO_ATOR_SESSION)
  {
    const res = await postar()
    assert(res.status === 200, 'A) resposta 200 ao cancelar', res.status)
    assert(solicitacaoFake.status === 'CANCELADA', 'A) solicitação passa para CANCELADA', solicitacaoFake.status)
    assert(emailEventoCreateCalls.length === 1, 'A) exatamente 1 EmailEvento criado (estado inicial, sem Patrimônio elegível)', emailEventoCreateCalls.length)
    assert(emailEventoCreateCalls[0]?.tipo === 'CANCELAMENTO', 'A) tipo do evento é CANCELAMENTO', emailEventoCreateCalls[0]?.tipo)
    const ev = Array.from(eventos.values())[0]
    assert(ev?.status === 'ENVIADO', 'A) evento termina ENVIADO', ev?.status)
  }

  // --- B) destinatário lógico = solicitante -----------------------------------------------
  resetMocks('AGUARDANDO_GESTOR')
  instalarMockGetSession(OUTRO_ATOR_SESSION)
  {
    await postar()
    assert(emailEventoCreateCalls[0]?.destinatario === SOLICITANTE.email, 'B) destinatário lógico é exatamente o e-mail do solicitante', emailEventoCreateCalls[0]?.destinatario)
  }

  // --- solicitante cancela a própria solicitação → ainda assim recebe e-mail (item 5) -----
  resetMocks('AGUARDANDO_GESTOR')
  instalarMockGetSession(SOLICITANTE)
  {
    await postar()
    assert(emailEventoCreateCalls.length === 1, 'solicitante que cancela a própria solicitação ainda recebe e-mail de confirmação', emailEventoCreateCalls.length)
    assert(notificacaoCriada.length === 0, 'notificação IN-APP continua suprimida no autocancelamento (regra existente, não alterada)', notificacaoCriada.length)
  }

  // --- D) EMAIL_TEST_MODE preserva destinatário lógico ---------------------------------------
  resetMocks('AGUARDANDO_GESTOR')
  instalarMockGetSession(OUTRO_ATOR_SESSION)
  process.env.EMAIL_TEST_MODE = 'true'
  process.env.EMAIL_TEST_RECIPIENT = 'caixa-de-teste@example.com'
  resetEmailConfigCache()
  {
    await postar()
    assert(emailEventoCreateCalls[0]?.destinatario === SOLICITANTE.email, 'D) EmailEvento.destinatario continua sendo o e-mail lógico do solicitante em EMAIL_TEST_MODE', emailEventoCreateCalls[0]?.destinatario)
  }
  process.env.EMAIL_TEST_MODE = 'false'
  delete process.env.EMAIL_TEST_RECIPIENT
  resetEmailConfigCache()

  // --- M) duplicidade/concorrência não cria 2 eventos ------------------------------------
  resetMocks('AGUARDANDO_GESTOR')
  instalarMockGetSession(OUTRO_ATOR_SESSION)
  {
    const [r1, r2] = await Promise.all([postar(), postar()])
    const statuses = [r1.status, r2.status].sort()
    assert(statuses[0] === 200 && statuses[1] === 409, 'M) exatamente uma das duas chamadas concorrentes vence (200), a outra perde (409) — updateMany condicional da própria rota', statuses)
    assert(emailEventoCreateCalls.length === 1, 'M) apenas 1 EmailEvento é criado mesmo com duas chamadas concorrentes', emailEventoCreateCalls.length)
    assert(eventos.size === 1, 'M) apenas 1 linha existe para a chave [solicitacaoId, tipo, destinatario]', eventos.size)
  }

  // ============================== REGRA DO PATRIMÔNIO (N-T) ==============================
  //
  // Etapa email-patrimonio-caixa-grupo: a rota deixou de consultar a
  // equipe Patrimônio (tx.user.findMany removido) para decidir se envia
  // e-mail — `patrimonioElegivel` (status ANTERIOR ao cancelamento) é
  // AGORA o único gate, e o destinatário é sempre a caixa de grupo fixa
  // (EMAIL_PATRIMONIO_RECIPIENT). Os cenários abaixo, que antes variavam a
  // composição da equipe (ativo/inativo/admin/duplicata), foram
  // substituídos: essa filtragem por usuário individual já não existe mais
  // nesta rota — está coberta em scripts/test-email-destinatarios.ts, que
  // testa buscarDestinatariosReservaConfirmada()/deduplicarDestinatarios()
  // diretamente.

  // --- N) cancelamento em estado inicial → Patrimônio NÃO recebe -----------------------------
  for (const statusInicial of ['AGUARDANDO_GESTOR', 'AGUARDANDO_PATRIMONIO', 'AGUARDANDO_ENVIO_ASSINATURA', 'AGUARDANDO_ASSINATURA']) {
    resetMocks(statusInicial)
    instalarMockGetSession(OUTRO_ATOR_SESSION)
    await postar()
    const destinatarios = emailEventoCreateCalls.map((e) => e.destinatario)
    assert(
      destinatarios.length === 1 && destinatarios[0] === SOLICITANTE.email,
      `N) cancelamento a partir de ${statusInicial} (estado inicial) → só o solicitante recebe, Patrimônio NÃO recebe`,
      destinatarios
    )
  }

  // --- O) cancelamento em preparação (EM_SEPARACAO) → caixa de grupo recebe --------------------
  resetMocks('EM_SEPARACAO')
  instalarMockGetSession(OUTRO_ATOR_SESSION)
  {
    await postar()
    const destinatarios = emailEventoCreateCalls.map((e) => e.destinatario)
    assert(destinatarios.includes(GRUPO_PATRIMONIO), 'O) cancelamento a partir de EM_SEPARACAO → caixa de grupo recebe', destinatarios)
    assert(destinatarios.includes(SOLICITANTE.email), 'O) solicitante também recebe', destinatarios)
    assert(destinatarios.length === 2, 'O) exatamente 2 eventos (solicitante + caixa de grupo, nunca 1 por usuário individual)', destinatarios)
  }

  // --- ASSINATURA_CONFIRMADA → caixa de grupo recebe (equivalente a EM_SEPARACAO no fluxo externo)
  resetMocks('ASSINATURA_CONFIRMADA')
  instalarMockGetSession(OUTRO_ATOR_SESSION)
  {
    await postar()
    const destinatarios = emailEventoCreateCalls.map((e) => e.destinatario)
    assert(destinatarios.includes(GRUPO_PATRIMONIO), 'cancelamento a partir de ASSINATURA_CONFIRMADA → caixa de grupo recebe (documento já assinado, "pode seguir para separação")', destinatarios)
  }

  // --- P) cancelamento em PRONTA_RETIRADA → caixa de grupo recebe --------------------------------
  resetMocks('PRONTA_RETIRADA')
  instalarMockGetSession(OUTRO_ATOR_SESSION)
  {
    await postar()
    const destinatarios = emailEventoCreateCalls.map((e) => e.destinatario)
    assert(destinatarios.includes(GRUPO_PATRIMONIO), 'P) cancelamento a partir de PRONTA_RETIRADA → caixa de grupo recebe', destinatarios)
    assert(destinatarios.includes(SOLICITANTE.email), 'P) solicitante também recebe', destinatarios)
  }

  // --- Q) solicitante com o MESMO e-mail da caixa de grupo → 1 evento só, papel solicitante ----
  resetMocks('EM_SEPARACAO')
  const solicitanteOriginalEmail = SOLICITANTE.email
  SOLICITANTE.email = GRUPO_PATRIMONIO
  instalarMockGetSession(OUTRO_ATOR_SESSION)
  {
    await postar()
    const destinatarios = emailEventoCreateCalls.map((e) => e.destinatario)
    assert(destinatarios.length === 1 && destinatarios[0] === GRUPO_PATRIMONIO, 'Q) solicitante e caixa de grupo colapsam para 1 único evento', destinatarios)
    const papeis = emailEventoCreateCalls.map((e) => (e.payload as { papel?: string }).papel)
    assert(papeis[0] === 'solicitante', 'Q) o evento colapsado prevalece como "solicitante", não "patrimonio"', papeis)
  }
  SOLICITANTE.email = solicitanteOriginalEmail

  // --- R) EMAIL_PATRIMONIO_RECIPIENT ausente → só o solicitante, nunca lança, negócio intacto --
  resetMocks('EM_SEPARACAO')
  instalarMockGetSession(OUTRO_ATOR_SESSION)
  {
    delete process.env.EMAIL_PATRIMONIO_RECIPIENT
    resetEmailPatrimonioRecipientCache()

    const original = console.error
    console.error = () => {}
    let res!: Awaited<ReturnType<typeof postar>>
    try {
      res = await postar()
    } finally {
      console.error = original
    }

    assert(res.status === 200, 'R) confirmação de cancelamento continua 200 mesmo com EMAIL_PATRIMONIO_RECIPIENT ausente', res.status)
    const destinatarios = emailEventoCreateCalls.map((e) => e.destinatario)
    assert(destinatarios.length === 1 && destinatarios[0] === SOLICITANTE.email, 'R) só o solicitante recebe — nunca cai de volta para e-mails individuais da equipe', destinatarios)

    process.env.EMAIL_PATRIMONIO_RECIPIENT = GRUPO_PATRIMONIO
    resetEmailPatrimonioRecipientCache()
  }

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) de CANCELAMENTO em POST /api/solicitacoes/[id]/cancelar falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes de CANCELAMENTO em POST /api/solicitacoes/[id]/cancelar passaram. Nenhum e-mail real foi enviado, nenhum banco real foi acessado.')
}

main().catch((err) => {
  console.error('Falha inesperada ao executar os testes de cancelamento:', err instanceof Error ? err.message : err)
  process.exit(1)
})
