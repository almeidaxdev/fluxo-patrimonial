// scripts/test-solicitacoes-post-aguardando-gestor.ts
//
// Teste manual (mesmo padrão de scripts/test-confirmar-patrimonio-reserva-confirmada.ts)
// da Etapa email-gestor-pendente: SOLICITACAO_AGUARDANDO_GESTOR criado em
// POST /api/solicitacoes SOMENTE quando tipoEmprestimo='externo' e a
// solicitação nasce com status AGUARDANDO_GESTOR — nunca para interna,
// nunca para o solicitante, Patrimônio ou administradores.
//
// Importa e chama o handler POST REAL da rota — prisma, getSession e
// sendEmail() são mocks em memória; processarEmailEvento(),
// criarValidadorDeEvento(), buildAppUrl() e resolvePhysicalRecipient()
// rodam DE VERDADE, para exercitar o caminho completo criação → claim →
// build (a partir do payload persistido) → envio, exatamente como em
// produção. Não abre conexão real com o banco nem envia e-mail real pelo
// Resend.
//
// Idempotência (item 7 do pedido): para um endpoint de CRIAÇÃO, não existe
// um cenário real de "reenviar a mesma tentativa" — cada POST bem-sucedido
// cria uma Solicitacao NOVA (numero/id próprios), então a garantia
// relevante aqui é estrutural: exatamente UM EmailEvento é criado por
// solicitação/gestor (cenário A/G abaixo), e a unique constraint
// `[solicitacaoId, tipo, destinatario]` (schema.prisma) protege qualquer
// cenário futuro de dupla escrita para o MESMO par. A idempotência de
// processamento (claim PENDENTE → PROCESSANDO, nunca duas entregas físicas
// para o mesmo EmailEvento) já é coberta genericamente por
// scripts/test-email-dispatcher.ts e scripts/test-email-validade-evento.ts
// — não duplicada aqui.
//
// Executar com: npm run test:solicitacoes-post-aguardando-gestor

import type { SendEmailInput, SendEmailResult } from '../src/lib/email/send-email'
import { resetEmailConfigCache } from '../src/lib/email/config'

process.env.APP_URL = 'http://localhost:3000'
process.env.EMAIL_TEST_MODE = 'false'

// require() puro de propósito — mesmo motivo dos demais testes de e-mail
// deste projeto (mocks precisam substituir as propriedades do módulo
// ANTES da rota ler `prisma`/`getSession`/`sendEmail` em runtime).
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

interface EventoFake {
  id: string
  destinatario: string
  status: 'PENDENTE' | 'PROCESSANDO' | 'ENVIADO' | 'FALHA' | 'OBSOLETO'
  tentativas: number
  erro: string | null
  enviadoEm: Date | null
  payload: unknown
}

let numeroSeq: number
let emailEventoCreateCalls: Array<Record<string, unknown>>
let notificacaoCriada: Array<Record<string, unknown>>
let eventos: Map<string, EventoFake>
let sendEmailCalls: SendEmailInput[]

function resetMocks() {
  numeroSeq = 100
  emailEventoCreateCalls = []
  notificacaoCriada = []
  eventos = new Map()
  sendEmailCalls = []
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
  // AGUARDANDO_GESTOR aqui: obsolescência já é coberta dedicadamente em
  // scripts/test-email-validade-evento.ts, não é o foco deste arquivo.
  prisma.solicitacao = {
    findUnique: async () => ({ status: 'AGUARDANDO_GESTOR' }),
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
    // Equipe Patrimônio (branch de reserva interna) — vazia nestes testes,
    // não é o foco deste arquivo.
    user: { findMany: async () => [] },
    emailEvento: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        emailEventoCreateCalls.push(data)
        const id = `evento-${emailEventoCreateCalls.length}`
        eventos.set(id, {
          id,
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

  prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)

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

function instalarMockSendEmail(resultado: SendEmailResult) {
  sendEmailCalls = []
  sendEmailModule.sendEmail = async (input: SendEmailInput): Promise<SendEmailResult> => {
    sendEmailCalls.push(input)
    return resultado
  }
}

function instalarMockGetSession() {
  authModule.getSession = async () => ({ ...SESSION })
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

async function postar(body: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rota = require('../src/app/api/solicitacoes/route')
  const req = { json: async () => body } as unknown as Parameters<typeof rota.POST>[0]
  return rota.POST(req)
}

async function main() {
  instalarMockPrisma()
  instalarMockGetSession()

  // --- A) Externa + gestor: exatamente 1 EmailEvento SOLICITACAO_AGUARDANDO_GESTOR, enviado ---
  resetMocks()
  instalarMockSendEmail({ success: true, providerId: 'p-A', originalRecipient: GESTOR.email, physicalRecipient: GESTOR.email, isTest: false })
  {
    const res = await postar(corpoExterno())
    assert(res.status === 201, 'A) resposta 201 na criação da atividade externa', res.status)
    assert(emailEventoCreateCalls.length === 1, 'A) exatamente 1 EmailEvento criado (nunca 2+ — item G)', emailEventoCreateCalls.length)
    assert(emailEventoCreateCalls[0]?.tipo === 'SOLICITACAO_AGUARDANDO_GESTOR', 'A) tipo do evento é SOLICITACAO_AGUARDANDO_GESTOR', emailEventoCreateCalls[0]?.tipo)
    assert(sendEmailCalls.length === 1, 'A) sendEmail (provider) chamado exatamente 1 vez', sendEmailCalls.length)
    const ev = Array.from(eventos.values())[0]
    assert(ev?.status === 'ENVIADO', 'A) evento termina ENVIADO', ev?.status)
  }

  // --- B) Interna: nenhum EmailEvento criado, nenhum e-mail enviado ------------------------
  resetMocks()
  instalarMockSendEmail({ success: true, providerId: 'p-B', originalRecipient: 'x', physicalRecipient: 'x', isTest: false })
  {
    const res = await postar(corpoInterno())
    assert(res.status === 201, 'B) resposta 201 na criação da reserva interna', res.status)
    assert(emailEventoCreateCalls.length === 0, 'B) nenhum EmailEvento criado para reserva interna', emailEventoCreateCalls.length)
    assert(sendEmailCalls.length === 0, 'B) nenhum e-mail enviado para reserva interna', sendEmailCalls.length)
  }

  // --- C) Destinatário lógico é SOMENTE o gestor — nunca solicitante/Patrimônio/admin ------
  resetMocks()
  instalarMockSendEmail({ success: true, providerId: 'p-C', originalRecipient: GESTOR.email, physicalRecipient: GESTOR.email, isTest: false })
  {
    await postar(corpoExterno())
    const destinatarios = emailEventoCreateCalls.map((e) => e.destinatario)
    assert(destinatarios.length === 1 && destinatarios[0] === GESTOR.email, 'C) destinatário lógico é exatamente o e-mail do gestor', destinatarios)
    assert(!destinatarios.includes(SOLICITANTE.email), 'C) solicitante NÃO recebe este evento', destinatarios)
  }

  // --- D) EMAIL_TEST_MODE=true não altera o destinatário lógico persistido -----------------
  resetMocks()
  process.env.EMAIL_TEST_MODE = 'true'
  process.env.EMAIL_TEST_RECIPIENT = 'caixa-de-teste@example.com'
  resetEmailConfigCache()
  instalarMockSendEmail({ success: true, providerId: 'p-D', originalRecipient: GESTOR.email, physicalRecipient: 'caixa-de-teste@example.com', isTest: true })
  {
    // O destinatário LÓGICO gravado em EmailEvento é decidido pela rota no
    // momento da criação (gestor.email), completamente independente de
    // EMAIL_TEST_MODE — a substituição pelo destinatário físico de teste
    // (EMAIL_TEST_RECIPIENT) só acontece depois, dentro de sendEmail() real,
    // no momento do envio (ver src/lib/email/recipient.ts). Nunca é o valor
    // persistido que muda. O comportamento do próprio redirecionamento
    // físico/banner de teste é infraestrutura genérica já coberta por
    // scripts/test-email-config.ts — não duplicado aqui.
    await postar(corpoExterno())
    assert(emailEventoCreateCalls[0]?.destinatario === GESTOR.email, 'D) EmailEvento.destinatario continua sendo o e-mail lógico do gestor em EMAIL_TEST_MODE', emailEventoCreateCalls[0]?.destinatario)
  }
  process.env.EMAIL_TEST_MODE = 'false'
  delete process.env.EMAIL_TEST_RECIPIENT
  resetEmailConfigCache()

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) de SOLICITACAO_AGUARDANDO_GESTOR em POST /api/solicitacoes falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes de SOLICITACAO_AGUARDANDO_GESTOR em POST /api/solicitacoes passaram. Nenhum e-mail real foi enviado, nenhum banco real foi acessado.')
}

main().catch((err) => {
  console.error('Falha inesperada ao executar os testes de SOLICITACAO_AGUARDANDO_GESTOR:', err instanceof Error ? err.message : err)
  process.exit(1)
})
