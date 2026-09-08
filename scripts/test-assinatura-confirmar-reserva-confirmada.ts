// scripts/test-assinatura-confirmar-reserva-confirmada.ts
//
// Teste manual (mesmo padrão de scripts/test-confirmar-patrimonio-reserva-confirmada.ts,
// Etapa D.3.4) da Etapa D.3.5: RESERVA_CONFIRMADA ligado ao gatilho do
// fluxo EXTERNO em /api/solicitacoes/[id]/assinatura/confirmar
// (AGUARDANDO_ASSINATURA → ASSINATURA_CONFIRMADA).
//
// Importa e chama o handler POST REAL da rota — prisma, getSession e
// sendEmail() são mocks em memória; processarEmailEvento() e buildAppUrl()
// rodam DE VERDADE (não mockados), exercitando o caminho completo claim →
// build (com papel e dados de assinatura corretos por destinatário) →
// envio → persistência, exatamente como em produção. Não abre conexão
// real com o banco nem envia e-mail real pelo Resend.
//
// O mock de prisma.$transaction() abaixo simula rollback de verdade
// (snapshot/restore do estado mutável), serializado por uma fila para não
// corromper o estado sob concorrência real (Promise.all) — mesma técnica
// de test-confirmar-patrimonio-reserva-confirmada.ts, ver os comentários
// lá para a explicação completa.
//
// Executar com: npm run test:assinatura-confirmar-reserva-confirmada

import { resetAppUrlCache } from '../src/lib/email/app-url'
import { resetEmailPatrimonioRecipientCache } from '../src/lib/email/config'
import type { SendEmailInput, SendEmailResult } from '../src/lib/email/send-email'
import { renderReservaConfirmadaFromPayload, type ReservaConfirmadaPayloadV1 } from '../src/lib/email/payloads/reserva-confirmada'

process.env.APP_URL = 'http://localhost:3000'
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

const SOL_ID = 'sol-assinatura-reserva-confirmada-1'

interface SolicitacaoFake {
  id: string
  status: string
  numero: number
  solicitanteId: string
  tipoEmprestimo: 'externo'
  data: Date
  periodos: string[]
  ambiente: string | null
  finalidade: string | null
  atividadeExterna: string | null
  local: string | null
  cidade: string | null
  observacoes: string | null
}

interface AssinaturaFake {
  solicitacaoId: string
  confirmadaPorId: string | null
  confirmadaEm: Date | null
}

interface UsuarioFake {
  id: string
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
let assinatura: AssinaturaFake
let usuarios: UsuarioFake[]
let historicoCriado: Array<Record<string, unknown>>
let notificacaoCriada: Array<Record<string, unknown>>
let eventos: Map<string, EventoFake>
let eventoSeq: number
let emailEventoCreateCalls: Array<Record<string, unknown>>
let sendEmailCalls: SendEmailInput[]
let falharCriacaoNoIndice: number | null

const ITENS_PATRIMONIO_FIXTURE = [{ patrimonio: { numero: 'PAT-9', marca: 'Epson', modelo: 'Projetor X200', categoria: { nome: 'Audiovisual' } } }]
const ITENS_PAPELARIA_FIXTURE: Array<{ descricao: string; quantidade: number }> = []
const ITENS_SERVICO_FIXTURE: Array<{ tipoServico: { nome: string }; quantidade: number | null; ambiente: string | null }> = []

function resetMocks(statusInicial: string) {
  solicitacao = {
    id: SOL_ID,
    status: statusInicial,
    numero: 77,
    solicitanteId: 'user-solicitante-externo',
    tipoEmprestimo: 'externo',
    data: new Date('2026-09-10'),
    periodos: ['TARDE'],
    ambiente: null,
    finalidade: null,
    atividadeExterna: 'Feira de tecnologia',
    local: 'Centro de Convenções',
    cidade: 'São Paulo',
    observacoes: null,
  }
  solicitante = { nome: 'Ciclana Externa', email: 'ciclana@example.com' }
  assinatura = { solicitacaoId: SOL_ID, confirmadaPorId: null, confirmadaEm: null }
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
    assinatura: { ...assinatura },
    historicoCriado: [...historicoCriado],
    notificacaoCriada: [...notificacaoCriada],
    eventos: new Map(Array.from(eventos.entries()).map(([k, v]) => [k, { ...v }])),
    eventoSeq,
    emailEventoCreateCalls: [...emailEventoCreateCalls],
  }
}

function restore(snap: ReturnType<typeof snapshot>) {
  Object.assign(solicitacao, snap.solicitacao)
  Object.assign(assinatura, snap.assinatura)
  historicoCriado = snap.historicoCriado
  notificacaoCriada = snap.notificacaoCriada
  eventos = snap.eventos
  eventoSeq = snap.eventoSeq
  emailEventoCreateCalls = snap.emailEventoCreateCalls
}

function instalarMockPrisma() {
  // Serializada por fila (ver test-confirmar-patrimonio-reserva-confirmada.ts
  // para a explicação completa de por que isso é necessário sob Promise.all).
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
      where.id === solicitacao.id ? { status: solicitacao.status, solicitanteId: solicitacao.solicitanteId } : null,
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

  prisma.assinatura = {
    update: async ({ where, data }: { where: { solicitacaoId: string }; data: Record<string, unknown> }) => {
      if (where.solicitacaoId !== assinatura.solicitacaoId) throw new Error('Assinatura não encontrada (mock).')
      Object.assign(assinatura, data)
      return { ...assinatura }
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

  // select: { id: true } → notificações internas (código já existente);
  // select: { email: true } → buscarDestinatariosReservaConfirmada (D.3.5).
  prisma.user = {
    findMany: async ({ where, select }: { where: { ativo?: boolean; permissao?: string }; select?: { id?: boolean; email?: boolean } }) => {
      const filtrados = usuarios.filter(
        (u) => (where.ativo === undefined || u.ativo === where.ativo) && (where.permissao === undefined || u.permissao === where.permissao)
      )
      return select?.email ? filtrados.map((u) => ({ email: u.email })) : filtrados.map((u) => ({ id: u.id }))
    },
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
  const rota = require('../src/app/api/solicitacoes/[id]/assinatura/confirmar/route')

  // --- A) Externo + solicitante + equipe Patrimônio ativa → 2 EmailEvento --
  // (não mais 1 por membro — ver Etapa email-patrimonio-caixa-grupo; também
  // cobre G, H, I abaixo, reaproveitando esta mesma chamada)
  resetMocks('AGUARDANDO_ASSINATURA')
  usuarios = [
    { id: 'u-pat-1', email: 'patrimonio1@example.com', ativo: true, permissao: 'patrimonio' },
    { id: 'u-pat-2', email: 'patrimonio2@example.com', ativo: true, permissao: 'patrimonio' },
  ]
  {
    const res = await rota.POST(undefined, { params: Promise.resolve({ id: SOL_ID }) })
    const body = await res.json()

    assert(res.status === 200, 'A) resposta 200 na confirmação de assinatura', res.status)
    assert(body.solicitacao?.status === 'ASSINATURA_CONFIRMADA', 'A) status final é ASSINATURA_CONFIRMADA', body.solicitacao?.status)
    assert(eventos.size === 2, 'A) exatamente 2 EmailEvento (solicitante + caixa de grupo — nunca 1 por membro)', Array.from(eventos.values()))
    assert(
      Array.from(eventos.values()).every((e) => e.tipo === 'RESERVA_CONFIRMADA' && e.solicitacaoId === SOL_ID),
      'A) todos os EmailEvento são RESERVA_CONFIRMADA desta solicitação',
      Array.from(eventos.values())
    )
    const destinatarios = Array.from(eventos.values()).map((e) => e.destinatario)
    assert(
      !destinatarios.includes('patrimonio1@example.com') && !destinatarios.includes('patrimonio2@example.com'),
      'A) nenhum e-mail INDIVIDUAL de membro do Patrimônio recebe EmailEvento próprio',
      destinatarios
    )
    assert(sendEmailCalls.length === 2, 'A) processarEmailEvento resultou em envio para os 2 destinatários', sendEmailCalls.length)
    assert(
      Array.from(eventos.values()).every((e) => e.status === 'ENVIADO'),
      'A) os 2 EmailEvento terminam ENVIADO após o processamento pós-commit',
      Array.from(eventos.values())
    )

    // G) solicitante: papel solicitante, assunto correto, menciona assinatura.
    const chamadaSolicitante = sendEmailCalls.find((c) => c.to === solicitante.email)
    assert(
      chamadaSolicitante?.subject === `[Fluxo Patrimonial] Sua reserva foi confirmada — #${solicitacao.numero}`,
      'G) assunto do solicitante é exatamente o esperado para papel solicitante',
      chamadaSolicitante?.subject
    )
    assert(
      !!chamadaSolicitante?.html.includes('Sua reserva foi confirmada após a conclusão da etapa de assinatura.'),
      'G) corpo do solicitante menciona a conclusão da etapa de assinatura',
      chamadaSolicitante?.html
    )

    // H) Caixa de grupo: papel patrimonio, assunto correto, menciona reserva externa + assinatura.
    const chamadaPatrimonio = sendEmailCalls.find((c) => c.to === GRUPO_PATRIMONIO)
    assert(
      chamadaPatrimonio?.subject === `[Fluxo Patrimonial] Reserva confirmada — #${solicitacao.numero} — ${solicitante.nome}`,
      'H) assunto da caixa de grupo é exatamente o esperado para papel patrimonio',
      chamadaPatrimonio?.subject
    )
    assert(
      !!chamadaPatrimonio?.html.includes(`A reserva externa de ${solicitante.nome} foi confirmada após a conclusão da etapa de assinatura.`),
      'H) corpo da caixa de grupo menciona a reserva externa confirmada após a assinatura',
      chamadaPatrimonio?.html
    )

    // I) Dados externos relevantes aparecem (atividade, local, cidade, assinatura confirmada em).
    assert(!!chamadaSolicitante?.html.includes('Feira de tecnologia'), 'I) atividade externa aparece no e-mail', chamadaSolicitante?.html)
    assert(!!chamadaSolicitante?.html.includes('Centro de Convenções'), 'I) local aparece no e-mail', chamadaSolicitante?.html)
    assert(!!chamadaSolicitante?.html.includes('São Paulo'), 'I) cidade aparece no e-mail', chamadaSolicitante?.html)
    assert(!!chamadaSolicitante?.html.includes('Assinatura confirmada em'), 'I) "Assinatura confirmada em" aparece no e-mail', chamadaSolicitante?.html)
  }

  // --- B) e-mail do solicitante coincide com a caixa de grupo → 1 evento, papel solicitante
  resetMocks('AGUARDANDO_ASSINATURA')
  solicitante = { nome: 'Ciclana Externa', email: GRUPO_PATRIMONIO }
  usuarios = [{ id: 'u-outro', email: 'outro-patrimonio@example.com', ativo: true, permissao: 'patrimonio' }]
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
    solicitante = { nome: 'Ciclana Externa', email: 'ciclana@example.com' }
  }

  // --- D/E/F) inativo, admin puro e colaborador (DIG/TI) não ativam a caixa de grupo
  resetMocks('AGUARDANDO_ASSINATURA')
  usuarios = [
    { id: 'u-inativo', email: 'patrimonio-inativo@example.com', ativo: false, permissao: 'patrimonio' },
    { id: 'u-admin', email: 'admin@example.com', ativo: true, permissao: 'administrador' },
    { id: 'u-dig', email: 'dig-ti@example.com', ativo: true, permissao: 'colaborador' },
  ]
  {
    await rota.POST(undefined, { params: Promise.resolve({ id: SOL_ID }) })
    const destinatarios = Array.from(eventos.values()).map((e) => e.destinatario)
    assert(!destinatarios.includes(GRUPO_PATRIMONIO), 'D/E/F) caixa de grupo NÃO recebe e-mail sem nenhum Patrimônio ativo elegível', destinatarios)
    assert(eventos.size === 1, 'D/E/F) só o EmailEvento do solicitante — inativo/admin/colaborador não contam', Array.from(eventos.values()))
  }
  // ...com 1 membro ativo de Patrimônio adicionado, a caixa de grupo passa a ser incluída.
  resetMocks('AGUARDANDO_ASSINATURA')
  usuarios = [
    { id: 'u-ativo', email: 'patrimonio-ativo@example.com', ativo: true, permissao: 'patrimonio' },
    { id: 'u-inativo', email: 'patrimonio-inativo@example.com', ativo: false, permissao: 'patrimonio' },
    { id: 'u-admin', email: 'admin@example.com', ativo: true, permissao: 'administrador' },
    { id: 'u-dig', email: 'dig-ti@example.com', ativo: true, permissao: 'colaborador' },
  ]
  {
    await rota.POST(undefined, { params: Promise.resolve({ id: SOL_ID }) })
    const destinatarios = Array.from(eventos.values()).map((e) => e.destinatario)
    assert(destinatarios.includes(GRUPO_PATRIMONIO), 'D/E/F) com 1 membro ativo elegível, a caixa de grupo recebe o EmailEvento', destinatarios)
    assert(!destinatarios.includes('patrimonio-ativo@example.com'), 'D/E/F) o e-mail INDIVIDUAL do membro ativo nunca recebe EmailEvento próprio', destinatarios)
    assert(!destinatarios.includes('patrimonio-inativo@example.com'), 'D) usuário inativo não conta como elegível', destinatarios)
    assert(!destinatarios.includes('admin@example.com'), 'E) admin puro não conta como elegível', destinatarios)
    assert(!destinatarios.includes('dig-ti@example.com'), 'F) colaborador (DIG/TI) não conta como elegível', destinatarios)
  }

  // --- J) rollback da transaction → nenhum EmailEvento persiste ------------
  // Falha simulada no 2º create (solicitante idx1, caixa de grupo idx2) —
  // uma transação real do Postgres desfaria também o 1º já executado; o
  // mock de $transaction reproduz isso via snapshot/restore.
  resetMocks('AGUARDANDO_ASSINATURA')
  usuarios = [{ id: 'u-pat-1', email: 'patrimonio1@example.com', ativo: true, permissao: 'patrimonio' }]
  falharCriacaoNoIndice = 2
  {
    let res!: Awaited<ReturnType<typeof rota.POST>>
    await silenciado(async () => {
      res = await rota.POST(undefined, { params: Promise.resolve({ id: SOL_ID }) })
    })

    assert(res.status === 500, 'J) a rota responde 500 quando a transaction falha ao criar um EmailEvento', res.status)
    assert(eventos.size === 0, 'J) nenhum EmailEvento persiste — inclusive o 1º, criado antes da falha do 2º', Array.from(eventos.values()))
    assert(historicoCriado.length === 0, 'J) histórico também é desfeito (rollback completo da transaction)', historicoCriado)
    assert(notificacaoCriada.length === 0, 'J) notificação também é desfeita', notificacaoCriada)
    assert(solicitacao.status === 'AGUARDANDO_ASSINATURA', 'J) status da solicitação é revertido para o original', solicitacao.status)
    assert(assinatura.confirmadaEm === null, 'J) assinatura não fica marcada como confirmada (rollback)', assinatura)
    assert(sendEmailCalls.length === 0, 'J) nenhum e-mail é enviado quando a transaction é desfeita', sendEmailCalls.length)
  }

  // --- K) concorrência: só o vencedor cria EmailEvento ----------------------
  resetMocks('AGUARDANDO_ASSINATURA')
  usuarios = []
  {
    const [res1, res2] = await Promise.all([
      rota.POST(undefined, { params: Promise.resolve({ id: SOL_ID }) }),
      rota.POST(undefined, { params: Promise.resolve({ id: SOL_ID }) }),
    ])
    const statuses = [res1.status, res2.status].sort()
    assert(JSON.stringify(statuses) === JSON.stringify([200, 409]), 'K) uma chamada retorna 200 e a outra 409', statuses)
    assert(historicoCriado.length === 1, 'K) só um histórico é criado', historicoCriado)
    assert(eventos.size === 1, 'K) só um EmailEvento é criado (nenhuma duplicação pela corrida)', Array.from(eventos.values()))
  }

  // --- L) status muda entre leitura e update → 409, nenhum EmailEvento -----
  resetMocks('AGUARDANDO_ASSINATURA')
  usuarios = [{ id: 'u-pat-1', email: 'patrimonio1@example.com', ativo: true, permissao: 'patrimonio' }]
  {
    const findUniqueOriginal = prisma.solicitacao.findUnique
    prisma.solicitacao.findUnique = async (args: { where: { id: string } }) => {
      const resultado = await findUniqueOriginal(args)
      // Simula uma transação concorrente que já cancelou a solicitação
      // entre esta rota ler AGUARDANDO_ASSINATURA e o updateMany rodar.
      solicitacao.status = 'CANCELADA'
      return resultado
    }

    const res = await rota.POST(undefined, { params: Promise.resolve({ id: SOL_ID }) })

    assert(res.status === 409, 'L) resposta é 409 quando o status mudou entre leitura e update', res.status)
    assert(eventos.size === 0, 'L) nenhum EmailEvento é criado', Array.from(eventos.values()))
    assert(sendEmailCalls.length === 0, 'L) nenhum e-mail é enviado', sendEmailCalls.length)

    prisma.solicitacao.findUnique = findUniqueOriginal
  }

  // --- M) falha de APP_URL → evento termina FALHA, confirmação continua ----
  resetMocks('AGUARDANDO_ASSINATURA')
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

    assert(res.status === 200, 'M) confirmação continua bem-sucedida (200) mesmo com APP_URL inválido', res.status)
    assert(body.solicitacao?.status === 'ASSINATURA_CONFIRMADA', 'M) reserva continua ASSINATURA_CONFIRMADA apesar da falha de e-mail', body.solicitacao?.status)
    assert(eventos.size === 1, 'M) 1 EmailEvento foi criado (só o solicitante, sem equipe Patrimônio configurada)', Array.from(eventos.values()))
    assert(
      Array.from(eventos.values())[0]?.status === 'FALHA',
      'M) o EmailEvento termina FALHA (nunca fica PENDENTE preso) quando APP_URL é inválido',
      Array.from(eventos.values())
    )
    assert(sendEmailCalls.length === 0, 'M) o provedor nunca é chamado quando o build falha por APP_URL inválido', sendEmailCalls.length)

    process.env.APP_URL = appUrlOriginal
    resetAppUrlCache()
  }

  // --- N) falha do provedor → evento FALHA, confirmação continua sucesso ---
  resetMocks('AGUARDANDO_ASSINATURA')
  usuarios = []
  {
    sendEmailModule.sendEmail = async (input: SendEmailInput): Promise<SendEmailResult> => {
      sendEmailCalls.push(input)
      return { success: false, originalRecipient: input.to, physicalRecipient: input.to, isTest: false, error: 'Falha simulada do provedor.' }
    }

    const res = await rota.POST(undefined, { params: Promise.resolve({ id: SOL_ID }) })
    const body = await res.json()

    assert(res.status === 200, 'N) confirmação continua bem-sucedida (200) mesmo com falha do provedor', res.status)
    assert(body.solicitacao?.status === 'ASSINATURA_CONFIRMADA', 'N) reserva continua ASSINATURA_CONFIRMADA apesar da falha de envio', body.solicitacao?.status)
    assert(
      Array.from(eventos.values())[0]?.status === 'FALHA',
      'N) o EmailEvento termina FALHA quando o provedor falha',
      Array.from(eventos.values())
    )

    instalarMockSendEmailSucesso()
  }

  // --- O) um destinatário falha e outro envia → isolamento -----------------
  resetMocks('AGUARDANDO_ASSINATURA')
  usuarios = [{ id: 'u-pat-1', email: 'patrimonio1@example.com', ativo: true, permissao: 'patrimonio' }]
  {
    sendEmailModule.sendEmail = async (input: SendEmailInput): Promise<SendEmailResult> => {
      sendEmailCalls.push(input)
      if (input.to === GRUPO_PATRIMONIO) {
        return { success: false, originalRecipient: input.to, physicalRecipient: input.to, isTest: false, error: 'Falha simulada do provedor.' }
      }
      return { success: true, providerId: `p-${sendEmailCalls.length}`, originalRecipient: input.to, physicalRecipient: input.to, isTest: false }
    }

    const res = await rota.POST(undefined, { params: Promise.resolve({ id: SOL_ID }) })

    assert(res.status === 200, 'O) confirmação continua bem-sucedida mesmo com 1 dos 2 destinatários falhando', res.status)
    assert(sendEmailCalls.length === 2, 'O) ambos os destinatários foram processados (nenhum bloqueou o outro)', sendEmailCalls.length)
    const eventoSolicitante = Array.from(eventos.values()).find((e) => e.destinatario === solicitante.email)
    const eventoPatrimonio = Array.from(eventos.values()).find((e) => e.destinatario === GRUPO_PATRIMONIO)
    assert(eventoSolicitante?.status === 'ENVIADO', 'O) EmailEvento do solicitante termina ENVIADO', eventoSolicitante)
    assert(eventoPatrimonio?.status === 'FALHA', 'O) EmailEvento da caixa de grupo (que falhou) termina FALHA, isolado do outro', eventoPatrimonio)

    instalarMockSendEmailSucesso()
  }

  // --- P) snapshot histórico imune a mutação do catálogo depois da criação -
  // Etapa D.3.6.4 — prova diretamente o achado do Codex Review na Etapa
  // D.3: uma vez persistido, o payload de RESERVA_CONFIRMADA nunca reflete
  // uma edição posterior do catálogo (Patrimonio/CategoriaPatrimonio).
  // Também prova que assinaturaConfirmadaEmIso usa o MESMO instante já
  // persistido em Assinatura.confirmadaEm (nunca um novo Date() paralelo).
  resetMocks('AGUARDANDO_ASSINATURA')
  usuarios = []
  {
    const res = await rota.POST(undefined, { params: Promise.resolve({ id: SOL_ID }) })
    assert(res.status === 200, 'P) resposta 200', res.status)

    const payloadPersistido = emailEventoCreateCalls[0]?.payload as ReservaConfirmadaPayloadV1 | undefined
    assert(
      payloadPersistido?.itensPatrimonio[0]?.numero === 'PAT-9' &&
        payloadPersistido?.itensPatrimonio[0]?.marca === 'Epson' &&
        payloadPersistido?.itensPatrimonio[0]?.modelo === 'Projetor X200' &&
        payloadPersistido?.itensPatrimonio[0]?.categoria === 'Audiovisual',
      'P) EmailEvento.payload persistido contém os valores históricos do catálogo (PAT-9/Epson/Projetor X200/Audiovisual)',
      payloadPersistido
    )
    assert(
      payloadPersistido?.assinaturaConfirmadaEmIso === assinatura.confirmadaEm?.toISOString(),
      'P) assinaturaConfirmadaEmIso do payload é EXATAMENTE o mesmo instante persistido em Assinatura.confirmadaEm',
      { payload: payloadPersistido?.assinaturaConfirmadaEmIso, assinatura: assinatura.confirmadaEm }
    )
    assert(
      !!sendEmailCalls[0]?.html.includes('PAT-9') && !!sendEmailCalls[0]?.html.includes('Epson'),
      'P) e-mail inline (enviado antes de qualquer mutação) já usa os valores históricos corretos',
      sendEmailCalls[0]?.html
    )

    // Muta o "catálogo" (o mock compartilhado por todos os cenários deste
    // arquivo) DEPOIS que o payload já foi persistido e o e-mail inline já
    // foi enviado — simula um administrador editando o bem/categoria antes
    // de um reprocessamento futuro (ex.: dispatcher).
    const original = { ...ITENS_PATRIMONIO_FIXTURE[0].patrimonio, categoria: { ...ITENS_PATRIMONIO_FIXTURE[0].patrimonio.categoria } }
    ITENS_PATRIMONIO_FIXTURE[0].patrimonio.numero = 'PAT-000'
    ITENS_PATRIMONIO_FIXTURE[0].patrimonio.marca = 'Marca Nova'
    ITENS_PATRIMONIO_FIXTURE[0].patrimonio.modelo = 'Modelo Novo'
    ITENS_PATRIMONIO_FIXTURE[0].patrimonio.categoria.nome = 'Categoria Nova'

    assert(
      payloadPersistido?.itensPatrimonio[0]?.numero === 'PAT-9' && payloadPersistido?.itensPatrimonio[0]?.marca === 'Epson',
      'P) payload já persistido continua com os valores históricos mesmo após o "catálogo" (mock) ser mutado depois',
      payloadPersistido
    )

    // Simula um reprocessamento futuro (ex.: dispatcher) a partir do MESMO
    // payload já persistido — nunca relendo o catálogo mutado.
    const reenvio = payloadPersistido && renderReservaConfirmadaFromPayload(payloadPersistido, 'https://app.example.com/x', null)
    assert(
      !!reenvio?.html.includes('PAT-9') && !!reenvio?.html.includes('Epson') && !!reenvio?.html.includes('Projetor X200'),
      'P) reprocessamento a partir do payload persistido usa SOMENTE os valores históricos',
      reenvio?.html
    )
    assert(
      !reenvio?.html.includes('PAT-000') && !reenvio?.html.includes('Marca Nova') && !reenvio?.html.includes('Modelo Novo') && !reenvio?.html.includes('Categoria Nova'),
      'P) reprocessamento NÃO reflete a mutação do catálogo feita depois',
      reenvio?.html
    )

    // Restaura o fixture compartilhado para não vazar estado para o resto do arquivo.
    Object.assign(ITENS_PATRIMONIO_FIXTURE[0].patrimonio, original)
  }

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) de RESERVA_CONFIRMADA em /assinatura/confirmar (fluxo externo) falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes de RESERVA_CONFIRMADA em /assinatura/confirmar (fluxo externo) passaram. Nenhum e-mail real foi enviado, nenhum banco real foi acessado.')
}

main().catch((err) => {
  console.error('Falha inesperada ao executar os testes de RESERVA_CONFIRMADA em /assinatura/confirmar:', err instanceof Error ? err.message : err)
  process.exit(1)
})
