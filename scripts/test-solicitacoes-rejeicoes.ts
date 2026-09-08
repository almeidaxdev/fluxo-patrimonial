// scripts/test-solicitacoes-rejeicoes.ts
//
// Teste manual (mesmo padrão de scripts/test-solicitacoes-assinatura-pendente.ts)
// da Etapa email-rejeicoes: REJEICAO_GESTOR criado em
// POST /api/solicitacoes/[id]/rejeitar-gestor e REJEICAO_PATRIMONIO criado em
// POST /api/solicitacoes/[id]/rejeitar-patrimonio — em ambos os casos
// exclusivo do solicitante, nunca gestor/Patrimônio/administradores.
//
// Importa e chama o handler POST REAL de cada rota — prisma, getSession e
// sendEmail() são mocks em memória; processarEmailEvento(),
// criarValidadorDeEvento() e buildAppUrl() rodam DE VERDADE. Não abre
// conexão real com o banco nem envia e-mail real pelo Resend.
//
// O mock de tx.emailEvento.upsert() abaixo reproduz a semântica ATÔMICA da
// unique [solicitacaoId, tipo, destinatario] (checa-e-grava num único passo
// síncrono, sem `await` entre as duas partes) — necessário para os cenários
// N/Z, que disparam duas chamadas da rota "ao mesmo tempo".
//
// Etapa fix/atomic-request-transitions: o mock de tx.solicitacao.updateMany()
// abaixo reproduz a mesma semântica ATÔMICA (checa `status` esperado e grava
// num único passo síncrono) para a transição da PRÓPRIA solicitação — mesmo
// padrão já usado em scripts/test-solicitacoes-cancelar.ts (cenário M) —
// necessário para os cenários N/Z passarem a exigir vitória/derrota
// explícitas (200/409), não só ausência de duplicidade de e-mail.
//
// Executar com: npm run test:solicitacoes-rejeicoes

import type { SendEmailInput, SendEmailResult } from '../src/lib/email/send-email'

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

// --- Fixtures --------------------------------------------------------------

const SOLICITANTE = { id: 'user-solicitante', nome: 'Fulano Solicitante', email: 'fulano@example.com' }
const GESTOR_SESSION = { id: 'user-gestor', nome: 'Ciclana Gestora', email: 'ciclana@example.com', permissao: 'gestor' as const, versaoSessao: 0 }
const PATRIMONIO_SESSION = { id: 'user-patrimonio', nome: 'Beltrana Patrimônio', email: 'beltrana@example.com', permissao: 'patrimonio' as const, versaoSessao: 0 }
const SOL_ID = 'sol-rejeicao-1'

// Etapa security/session-revocation: getValidatedMutationSession() faz UMA
// consulta a prisma.user.findUnique() (fora da transação) para revalidar a
// sessão ANTES de a rota abrir `prisma.$transaction` — precisa de um
// registro "de banco" por ator de sessão usado neste arquivo, ativo e com a
// MESMA versaoSessao da sessão mockada. `permissao` aqui é sempre um valor
// VÁLIDO do schema ('colaborador'/'patrimonio'/'administrador') — distinto
// do rótulo "gestor" usado só na sessão mockada acima (que nunca é um valor
// real de User.permissao no banco; "gestor" é a capacidade `podeSerGestor`).
// Nas duas rotas destes testes a decisão de permissão é por IDENTIDADE
// (`solicitacao.gestorId === validacao.user.id` / isPatrimonioOuAdmin), não
// por rótulo — por isso os valores de `permissao` abaixo só precisam ser
// coerentes com o schema, não espelhar exatamente o rótulo da sessão.
const USUARIOS_DB_FAKE: Record<string, { id: string; nome: string; email: string; permissao: 'colaborador' | 'patrimonio' | 'administrador'; ativo: boolean; podeSerGestor: boolean; podeSolicitarParaOutro: boolean; versaoSessao: number }> = {
  [GESTOR_SESSION.id]: { id: GESTOR_SESSION.id, nome: GESTOR_SESSION.nome, email: GESTOR_SESSION.email, permissao: 'colaborador', ativo: true, podeSerGestor: true, podeSolicitarParaOutro: false, versaoSessao: GESTOR_SESSION.versaoSessao },
  [PATRIMONIO_SESSION.id]: { id: PATRIMONIO_SESSION.id, nome: PATRIMONIO_SESSION.nome, email: PATRIMONIO_SESSION.email, permissao: 'patrimonio', ativo: true, podeSerGestor: false, podeSolicitarParaOutro: false, versaoSessao: PATRIMONIO_SESSION.versaoSessao },
  'user-outro-gestor': { id: 'user-outro-gestor', nome: 'Outro Gestor', email: 'outro@example.com', permissao: 'colaborador', ativo: true, podeSerGestor: true, podeSolicitarParaOutro: false, versaoSessao: 0 },
}

interface SolicitacaoFake {
  id: string
  numero: number
  tipoEmprestimo: 'interno' | 'externo'
  status: string
  solicitanteId: string
  gestorId: string | null
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
let eventoSeq: number
let eventos: Map<string, EventoFake>
let eventosPorChave: Map<string, string>
let emailEventoCreateCalls: Array<Record<string, unknown>>
let notificacaoCriada: Array<Record<string, unknown>>
let sendEmailCalls: SendEmailInput[]

function resetMocks(statusInicial: string = 'AGUARDANDO_GESTOR') {
  solicitacaoFake = {
    id: SOL_ID,
    numero: 77,
    tipoEmprestimo: 'externo',
    status: statusInicial,
    solicitanteId: SOLICITANTE.id,
    gestorId: GESTOR_SESSION.id,
    data: new Date('2026-09-10'),
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

function instalarMockSendEmail(resultado: SendEmailResult) {
  sendEmailCalls = []
  sendEmailModule.sendEmail = async (input: SendEmailInput): Promise<SendEmailResult> => {
    sendEmailCalls.push(input)
    return resultado
  }
}

function instalarMockGetSession(sessao: typeof GESTOR_SESSION | typeof PATRIMONIO_SESSION) {
  authModule.getSession = async () => ({ ...sessao })
}

async function postarGestor(motivo = 'Documentação incompleta para a atividade externa.') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rota = require('../src/app/api/solicitacoes/[id]/rejeitar-gestor/route')
  const req = { json: async () => ({ motivo }) } as unknown as Parameters<typeof rota.POST>[0]
  return rota.POST(req, { params: Promise.resolve({ id: SOL_ID }) })
}

async function postarPatrimonio(motivo = 'Itens indisponíveis para o período solicitado.') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rota = require('../src/app/api/solicitacoes/[id]/rejeitar-patrimonio/route')
  const req = { json: async () => ({ motivo }) } as unknown as Parameters<typeof rota.POST>[0]
  return rota.POST(req, { params: Promise.resolve({ id: SOL_ID }) })
}

async function main() {
  instalarMockPrisma()

  // ============================== REJEICAO_GESTOR ==============================

  // --- A) exatamente 1 EmailEvento criado -----------------------------------------------
  resetMocks('AGUARDANDO_GESTOR')
  instalarMockGetSession(GESTOR_SESSION)
  instalarMockSendEmail({ success: true, providerId: 'p-A', originalRecipient: SOLICITANTE.email, physicalRecipient: SOLICITANTE.email, isTest: false })
  {
    const res = await postarGestor()
    assert(res.status === 200, 'A) resposta 200 ao rejeitar pelo gestor', res.status)
    assert(solicitacaoFake.status === 'REJEITADA_GESTOR', 'A) solicitação passa para REJEITADA_GESTOR', solicitacaoFake.status)
    assert(emailEventoCreateCalls.length === 1, 'A) exatamente 1 EmailEvento criado', emailEventoCreateCalls.length)
    assert(emailEventoCreateCalls[0]?.tipo === 'REJEICAO_GESTOR', 'A) tipo do evento é REJEICAO_GESTOR', emailEventoCreateCalls[0]?.tipo)
    const ev = Array.from(eventos.values())[0]
    assert(ev?.status === 'ENVIADO', 'A) evento termina ENVIADO', ev?.status)
  }

  // --- B) destinatário = solicitante --- C) gestor não recebe --- D) Patrimônio não recebe ---
  resetMocks('AGUARDANDO_GESTOR')
  instalarMockGetSession(GESTOR_SESSION)
  instalarMockSendEmail({ success: true, providerId: 'p-BCD', originalRecipient: SOLICITANTE.email, physicalRecipient: SOLICITANTE.email, isTest: false })
  {
    await postarGestor()
    const destinatarios = emailEventoCreateCalls.map((e) => e.destinatario)
    assert(destinatarios.length === 1 && destinatarios[0] === SOLICITANTE.email, 'B) destinatário lógico é exatamente o e-mail do solicitante', destinatarios)
    assert(!destinatarios.includes(GESTOR_SESSION.email), 'C) o gestor que rejeitou NÃO recebe este evento', destinatarios)
    assert(!destinatarios.includes(PATRIMONIO_SESSION.email), 'D) Patrimônio NÃO recebe este evento', destinatarios)
  }

  // --- E) motivo aparece no payload/template -----------------------------------------------
  resetMocks('AGUARDANDO_GESTOR')
  instalarMockGetSession(GESTOR_SESSION)
  instalarMockSendEmail({ success: true, providerId: 'p-E', originalRecipient: SOLICITANTE.email, physicalRecipient: SOLICITANTE.email, isTest: false })
  {
    await postarGestor('Motivo específico do cenário E de teste.')
    const payload = emailEventoCreateCalls[0]?.payload as { motivo?: string } | undefined
    assert(payload?.motivo === 'Motivo específico do cenário E de teste.', 'E) motivo persistido no payload do EmailEvento', payload?.motivo)
  }

  // --- F) EMAIL_TEST_MODE preserva destinatário lógico ---------------------------------------
  resetMocks('AGUARDANDO_GESTOR')
  instalarMockGetSession(GESTOR_SESSION)
  process.env.EMAIL_TEST_MODE = 'true'
  process.env.EMAIL_TEST_RECIPIENT = 'caixa-de-teste@example.com'
  resetEmailConfigCache()
  instalarMockSendEmail({ success: true, providerId: 'p-F', originalRecipient: SOLICITANTE.email, physicalRecipient: 'caixa-de-teste@example.com', isTest: true })
  {
    await postarGestor()
    assert(emailEventoCreateCalls[0]?.destinatario === SOLICITANTE.email, 'F) EmailEvento.destinatario continua sendo o e-mail lógico do solicitante em EMAIL_TEST_MODE', emailEventoCreateCalls[0]?.destinatario)
  }
  process.env.EMAIL_TEST_MODE = 'false'
  delete process.env.EMAIL_TEST_RECIPIENT
  resetEmailConfigCache()

  // --- N) duplicidade/concorrência não cria 2 eventos -----------------------------------------
  resetMocks('AGUARDANDO_GESTOR')
  instalarMockGetSession(GESTOR_SESSION)
  instalarMockSendEmail({ success: true, providerId: 'p-N', originalRecipient: SOLICITANTE.email, physicalRecipient: SOLICITANTE.email, isTest: false })
  {
    const [r1, r2] = await Promise.all([postarGestor(), postarGestor()])
    const statuses = [r1.status, r2.status].sort()
    assert(statuses[0] === 200 && statuses[1] === 409, 'N) exatamente uma das duas chamadas concorrentes vence (200), a outra perde (409) — updateMany condicional da própria rota', statuses)
    assert(emailEventoCreateCalls.length === 1, 'N) duas chamadas concorrentes → exatamente 1 EmailEvento (transição atômica evita que a perdedora chegue a criar evento)', emailEventoCreateCalls.length)
    assert(eventos.size === 1, 'N) apenas 1 linha existe para a chave [solicitacaoId, tipo, destinatario]', eventos.size)
    assert(notificacaoCriada.length === 1, 'N) apenas 1 notificação in-app é criada (nunca para a chamada que perdeu a corrida)', notificacaoCriada.length)
  }

  // --- permissão: quem não é o gestor da solicitação não consegue rejeitar (nem gera evento) ---
  resetMocks('AGUARDANDO_GESTOR')
  instalarMockGetSession({ id: 'user-outro-gestor', nome: 'Outro Gestor', email: 'outro@example.com', permissao: 'gestor' as const, versaoSessao: 0 })
  instalarMockSendEmail({ success: true, providerId: 'p-perm', originalRecipient: SOLICITANTE.email, physicalRecipient: SOLICITANTE.email, isTest: false })
  {
    const res = await postarGestor()
    assert(res.status === 403, 'permissão: gestor de outra solicitação recebe 403', res.status)
    assert(emailEventoCreateCalls.length === 0, 'permissão: nenhum EmailEvento é criado quando a rejeição é negada', emailEventoCreateCalls.length)
  }

  // ============================== REJEICAO_PATRIMONIO ==============================

  // --- P) exatamente 1 EmailEvento criado -----------------------------------------------
  resetMocks('AGUARDANDO_PATRIMONIO')
  instalarMockGetSession(PATRIMONIO_SESSION)
  instalarMockSendEmail({ success: true, providerId: 'p-P', originalRecipient: SOLICITANTE.email, physicalRecipient: SOLICITANTE.email, isTest: false })
  {
    const res = await postarPatrimonio()
    assert(res.status === 200, 'P) resposta 200 ao rejeitar pelo Patrimônio', res.status)
    assert(solicitacaoFake.status === 'REJEITADA_PATRIMONIO', 'P) solicitação passa para REJEITADA_PATRIMONIO', solicitacaoFake.status)
    assert(emailEventoCreateCalls.length === 1, 'P) exatamente 1 EmailEvento criado', emailEventoCreateCalls.length)
    assert(emailEventoCreateCalls[0]?.tipo === 'REJEICAO_PATRIMONIO', 'P) tipo do evento é REJEICAO_PATRIMONIO', emailEventoCreateCalls[0]?.tipo)
    const ev = Array.from(eventos.values())[0]
    assert(ev?.status === 'ENVIADO', 'P) evento termina ENVIADO', ev?.status)
  }

  // --- Q) destinatário = solicitante --- R) Patrimônio não recebe --- S) gestor não recebe ---
  resetMocks('AGUARDANDO_PATRIMONIO')
  instalarMockGetSession(PATRIMONIO_SESSION)
  instalarMockSendEmail({ success: true, providerId: 'p-QRS', originalRecipient: SOLICITANTE.email, physicalRecipient: SOLICITANTE.email, isTest: false })
  {
    await postarPatrimonio()
    const destinatarios = emailEventoCreateCalls.map((e) => e.destinatario)
    assert(destinatarios.length === 1 && destinatarios[0] === SOLICITANTE.email, 'Q) destinatário lógico é exatamente o e-mail do solicitante', destinatarios)
    assert(!destinatarios.includes(PATRIMONIO_SESSION.email), 'R) o Patrimônio que rejeitou NÃO recebe cópia deste evento', destinatarios)
    assert(!destinatarios.includes(GESTOR_SESSION.email), 'S) o gestor NÃO recebe cópia deste evento', destinatarios)
  }

  // --- T) motivo correto -------------------------------------------------------------------
  resetMocks('AGUARDANDO_PATRIMONIO')
  instalarMockGetSession(PATRIMONIO_SESSION)
  instalarMockSendEmail({ success: true, providerId: 'p-T', originalRecipient: SOLICITANTE.email, physicalRecipient: SOLICITANTE.email, isTest: false })
  {
    await postarPatrimonio('Motivo específico do cenário T de teste.')
    const payload = emailEventoCreateCalls[0]?.payload as { motivo?: string } | undefined
    assert(payload?.motivo === 'Motivo específico do cenário T de teste.', 'T) motivo persistido no payload do EmailEvento', payload?.motivo)
  }

  // --- U) EMAIL_TEST_MODE preserva destinatário lógico -----------------------------------------
  resetMocks('AGUARDANDO_PATRIMONIO')
  instalarMockGetSession(PATRIMONIO_SESSION)
  process.env.EMAIL_TEST_MODE = 'true'
  process.env.EMAIL_TEST_RECIPIENT = 'caixa-de-teste@example.com'
  resetEmailConfigCache()
  instalarMockSendEmail({ success: true, providerId: 'p-U', originalRecipient: SOLICITANTE.email, physicalRecipient: 'caixa-de-teste@example.com', isTest: true })
  {
    await postarPatrimonio()
    assert(emailEventoCreateCalls[0]?.destinatario === SOLICITANTE.email, 'U) EmailEvento.destinatario continua sendo o e-mail lógico do solicitante em EMAIL_TEST_MODE', emailEventoCreateCalls[0]?.destinatario)
  }
  process.env.EMAIL_TEST_MODE = 'false'
  delete process.env.EMAIL_TEST_RECIPIENT
  resetEmailConfigCache()

  // --- Z) idempotência sob concorrência ---------------------------------------------------
  resetMocks('AGUARDANDO_PATRIMONIO')
  instalarMockGetSession(PATRIMONIO_SESSION)
  instalarMockSendEmail({ success: true, providerId: 'p-Z', originalRecipient: SOLICITANTE.email, physicalRecipient: SOLICITANTE.email, isTest: false })
  {
    const [r1, r2] = await Promise.all([postarPatrimonio(), postarPatrimonio()])
    const statuses = [r1.status, r2.status].sort()
    assert(statuses[0] === 200 && statuses[1] === 409, 'Z) exatamente uma das duas chamadas concorrentes vence (200), a outra perde (409) — updateMany condicional da própria rota', statuses)
    assert(emailEventoCreateCalls.length === 1, 'Z) duas chamadas concorrentes → exatamente 1 EmailEvento (transição atômica evita que a perdedora chegue a criar evento)', emailEventoCreateCalls.length)
    assert(eventos.size === 1, 'Z) apenas 1 linha existe para a chave [solicitacaoId, tipo, destinatario]', eventos.size)
    assert(notificacaoCriada.length === 1, 'Z) apenas 1 notificação in-app é criada (nunca para a chamada que perdeu a corrida)', notificacaoCriada.length)
  }

  // --- permissão: quem não é Patrimônio/admin não consegue rejeitar (nem gera evento) --------
  resetMocks('AGUARDANDO_PATRIMONIO')
  instalarMockGetSession(GESTOR_SESSION)
  instalarMockSendEmail({ success: true, providerId: 'p-perm2', originalRecipient: SOLICITANTE.email, physicalRecipient: SOLICITANTE.email, isTest: false })
  {
    const res = await postarPatrimonio()
    assert(res.status === 403, 'permissão: gestor sem papel Patrimônio/admin recebe 403 ao tentar rejeitar pelo Patrimônio', res.status)
    assert(emailEventoCreateCalls.length === 0, 'permissão: nenhum EmailEvento é criado quando a rejeição é negada', emailEventoCreateCalls.length)
  }

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) de REJEICAO_GESTOR/REJEICAO_PATRIMONIO nas rotas de rejeição falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes de REJEICAO_GESTOR/REJEICAO_PATRIMONIO nas rotas de rejeição passaram. Nenhum e-mail real foi enviado, nenhum banco real foi acessado.')
}

main().catch((err) => {
  console.error('Falha inesperada ao executar os testes de rejeições:', err instanceof Error ? err.message : err)
  process.exit(1)
})
