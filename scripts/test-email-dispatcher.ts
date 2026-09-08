// scripts/test-email-dispatcher.ts
//
// Teste manual (mesmo padrão de scripts/test-email-config.ts) de
// src/lib/email/dispatcher.ts — cobre a recuperação de EmailEvento PENDENTE
// abandonado (Etapa D.2), o isolamento de falhas dentro de um lote, e a
// detecção de eventos OBSOLETOS (correção pós-Codex-Review): um EmailEvento
// PRONTA_RETIRADA/NAO_RETIRADA recuperado pelo dispatcher só é enviado se a
// Solicitacao ainda estiver no status esperado NO MOMENTO do envio — nunca
// com base no status de quando o evento foi criado.
//
// Exercita processarEmailsPendentes() e processarEmailEvento() DE VERDADE
// (não mockados) — só prisma.emailEvento, prisma.solicitacao e sendEmail()
// são mocks em memória. Não abre conexão real com o banco nem envia e-mail
// real pelo Resend.
//
// Executar com: npm run test:email-dispatcher

import { processarEmailsPendentes } from '../src/lib/email/dispatcher'
import { resetAppUrlCache } from '../src/lib/email/app-url'
import type { SendEmailInput, SendEmailResult } from '../src/lib/email/send-email'
import type { ReservaConfirmadaPayloadV1 } from '../src/lib/email/payloads/reserva-confirmada'

// buildAppUrl() (chamado por dispatcher.ts, não mockado) exige APP_URL
// configurado — nenhum segredo aqui, só a URL base usada para montar o
// link "VER SOLICITAÇÃO" dos templates.
process.env.APP_URL = 'http://localhost:3000'

// require() puro de propósito — ver scripts/test-email-processar-evento.ts
// para a explicação completa de por que `import` não serve aqui.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { prisma } = require('../src/lib/prisma')
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

// --- Fixtures --------------------------------------------------------------

type StatusEventoFake = 'PENDENTE' | 'PROCESSANDO' | 'ENVIADO' | 'FALHA' | 'OBSOLETO'
type StatusSolicitacaoFake = string

type TipoEventoFake =
  | 'PRONTA_RETIRADA'
  | 'NAO_RETIRADA'
  | 'RESERVA_CONFIRMADA'
  | 'CANCELAMENTO'
  | 'REJEICAO_GESTOR'
  | 'REJEICAO_PATRIMONIO'
  | 'SOLICITACAO_AGUARDANDO_PATRIMONIO'
  // Etapa email-aguardando-patrimonio: com SOLICITACAO_AGUARDANDO_PATRIMONIO
  // ganhando suporte nesta etapa, TODOS os valores reais de TipoEmailEvento
  // passam a estar em TIPOS_EMAIL_SUPORTADOS — não sobra nenhum valor real
  // para servir de exemplo "genuinamente não suportado" (mesma classe de
  // ajuste já feita 3x: ASSINATURA_PENDENTE, depois REJEICAO_*, depois
  // CANCELAMENTO). Este valor sintético (nunca existirá no enum real)
  // substitui os valores reais nesse papel — mais robusto a longo prazo,
  // já que não "expira" quando um novo tipo ganhar suporte.
  | 'TIPO_INEXISTENTE_TESTE'

interface EventoFake {
  id: string
  tipo: TipoEventoFake
  solicitacaoId: string
  destinatario: string
  status: StatusEventoFake
  tentativas: number
  erro: string | null
  enviadoEm: Date | null
  createdAt: Date
  /**
   * Etapa D.3.6.5 — só relevante para RESERVA_CONFIRMADA; `null`/`undefined`
   * para os demais tipos (nunca lido por eles). O que o mock de
   * `prisma.emailEvento.findMany` abaixo devolve para o dispatcher — o
   * MESMO valor bruto (`unknown`) que `EmailEvento.payload` (Prisma Json)
   * devolveria em runtime, nunca um objeto já tipado/validado.
   */
  payload?: unknown
}

interface SolicitacaoFake {
  id: string
  numero: number
  status: StatusSolicitacaoFake
  data: Date
  periodos: string[]
  naoRetiradaEm: Date | null
  solicitante: { nome: string; email?: string }
  itensPatrimonio: Array<{ patrimonio: { numero: string; marca: string; modelo: string; categoria?: { nome: string } } }>
  itensPapelaria: Array<{ descricao: string; quantidade: number }>
  // Campos abaixo (Etapa D.3.6.5): o dispatcher NUNCA mais lê Solicitacao
  // para RESERVA_CONFIRMADA (fonte exclusiva é EmailEvento.payload — ver
  // dispatcher.ts) — mantidos aqui só para simular "o catálogo/estado atual,
  // possivelmente divergente" nos poucos testes que registram uma
  // Solicitacao junto de um evento RESERVA_CONFIRMADA de propósito, para
  // provar que o conteúdo desses campos nunca vaza para o e-mail (ver teste
  // AF). Não são mais lidos por nenhum outro tipo suportado.
  tipoEmprestimo?: 'interno' | 'externo'
  ambiente?: string | null
  finalidade?: string | null
  atividadeExterna?: string | null
  local?: string | null
  cidade?: string | null
  observacoes?: string | null
  itensServico?: Array<{ tipoServico: { nome: string }; quantidade: number | null; ambiente: string | null }>
  assinatura?: { confirmadaEm: Date | null } | null
}

let eventos: Map<string, EventoFake>
let solicitacoes: Map<string, SolicitacaoFake>
let solicitacaoDeveFalhar: Set<string>

function resetMocks() {
  eventos = new Map()
  solicitacoes = new Map()
  solicitacaoDeveFalhar = new Set()
}

function instalarMockPrisma() {
  prisma.emailEvento = {
    findMany: async ({
      where,
      take,
    }: {
      where: { status: StatusEventoFake; tipo?: { in: TipoEventoFake[] } }
      take: number
    }) => {
      return Array.from(eventos.values())
        .filter((e) => e.status === where.status)
        .filter((e) => !where.tipo || where.tipo.in.includes(e.tipo))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, take)
        .map((e) => ({ id: e.id, tipo: e.tipo, solicitacaoId: e.solicitacaoId, destinatario: e.destinatario, payload: e.payload ?? null }))
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { id: string; status?: StatusEventoFake }
      data: Record<string, unknown>
    }) => {
      const evento = eventos.get(where.id)
      if (!evento) return { count: 0 }
      if (where.status !== undefined && evento.status !== where.status) return { count: 0 }
      if (typeof data.status === 'string') evento.status = data.status as StatusEventoFake
      const tentativasOp = data.tentativas as { increment?: number } | undefined
      if (tentativasOp?.increment) evento.tentativas += tentativasOp.increment
      return { count: 1 }
    },
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
      const evento = eventos.get(where.id)
      if (!evento) throw new Error(`EmailEvento ${where.id} não encontrado (mock).`)
      return { destinatario: evento.destinatario }
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const evento = eventos.get(where.id)
      if (!evento) throw new Error(`EmailEvento ${where.id} não encontrado (mock).`)
      if (typeof data.status === 'string') evento.status = data.status as StatusEventoFake
      if ('erro' in data) evento.erro = data.erro as string | null
      if ('enviadoEm' in data) evento.enviadoEm = data.enviadoEm as Date | null
      return { ...evento }
    },
  }

  prisma.solicitacao = {
    findUnique: async ({ where }: { where: { id: string } }) => {
      if (solicitacaoDeveFalhar.has(where.id)) {
        throw new Error(`Falha simulada de banco ao buscar solicitação ${where.id}.`)
      }
      return solicitacoes.get(where.id) ?? null
    },
  }
}

let sendEmailCalls: SendEmailInput[] = []

function instalarMockSendEmail(resolver: (input: SendEmailInput) => SendEmailResult) {
  sendEmailCalls = []
  sendEmailModule.sendEmail = async (input: SendEmailInput): Promise<SendEmailResult> => {
    sendEmailCalls.push(input)
    return resolver(input)
  }
}

function solicitacaoFixture(id: string, status: StatusSolicitacaoFake, destinatarioNome: string): SolicitacaoFake {
  return {
    id,
    numero: 42,
    status,
    data: new Date('2026-08-20T00:00:00.000Z'),
    periodos: ['TARDE'],
    naoRetiradaEm: status === 'NAO_RETIRADA' ? new Date('2026-08-21T12:00:00.000Z') : null,
    solicitante: { nome: destinatarioNome },
    itensPatrimonio: [{ patrimonio: { numero: 'PAT-1', marca: 'HP', modelo: 'ProBook 440' } }],
    itensPapelaria: [],
  }
}

/**
 * Etapa D.3.6.5: NÃO é mais usada para dirigir o branch RESERVA_CONFIRMADA
 * do dispatcher (ele não lê Solicitacao para esse tipo — ver
 * dispatcher.ts). Mantida só para representar "o catálogo/estado atual,
 * deliberadamente divergente do snapshot" nos testes que provam que esse
 * conteúdo nunca vaza para o e-mail mesmo que a Solicitacao exista com
 * dados diferentes (ver teste AF, "snapshot antigo vs catálogo novo").
 */
function solicitacaoReservaConfirmadaFixture(
  id: string,
  opts: {
    tipoEmprestimo: 'interno' | 'externo'
    solicitanteEmail: string
    solicitanteNome?: string
    status?: StatusSolicitacaoFake
    assinaturaConfirmadaEm?: Date | null
    atividadeExterna?: string | null
    local?: string | null
    cidade?: string | null
  }
): SolicitacaoFake {
  return {
    id,
    numero: 77,
    status: opts.status ?? 'EM_SEPARACAO',
    data: new Date('2026-08-20T00:00:00.000Z'),
    periodos: ['TARDE'],
    naoRetiradaEm: null,
    solicitante: { nome: opts.solicitanteNome ?? 'Fulano', email: opts.solicitanteEmail },
    itensPatrimonio: [{ patrimonio: { numero: 'PAT-9', marca: 'Dell', modelo: 'Latitude', categoria: { nome: 'Notebook' } } }],
    itensPapelaria: [],
    tipoEmprestimo: opts.tipoEmprestimo,
    ambiente: opts.tipoEmprestimo === 'interno' ? 'Lab 1' : null,
    finalidade: opts.tipoEmprestimo === 'interno' ? 'Aula prática' : null,
    atividadeExterna: opts.atividadeExterna ?? (opts.tipoEmprestimo === 'externo' ? 'Feira de tecnologia' : null),
    local: opts.local ?? (opts.tipoEmprestimo === 'externo' ? 'Centro de Convenções' : null),
    cidade: opts.cidade ?? (opts.tipoEmprestimo === 'externo' ? 'São Paulo' : null),
    observacoes: null,
    itensServico: [],
    assinatura:
      opts.tipoEmprestimo === 'externo'
        ? { confirmadaEm: opts.assinaturaConfirmadaEm === undefined ? new Date('2026-08-19T10:00:00.000Z') : opts.assinaturaConfirmadaEm }
        : null,
  }
}

/**
 * Payload histórico de RESERVA_CONFIRMADA (Etapa D.3.6.5) — o formato que
 * `EmailEvento.payload` devolveria já validado (mesmo shape produzido por
 * construirPayloadReservaConfirmada()/aceito por parseReservaConfirmadaPayload()
 * em src/lib/email/payloads/reserva-confirmada.ts). Deliberadamente COM
 * valores diferentes dos usados em solicitacaoFixture/solicitacaoReservaConfirmadaFixture
 * acima (numero 77 vs 42, item PAT-9/Dell/Latitude/Notebook vs PAT-1/HP/ProBook)
 * — se o dispatcher algum dia voltar a ler o catálogo por engano para este
 * tipo, os testes abaixo (que comparam o e-mail renderizado) pegam a
 * divergência.
 */
function reservaConfirmadaPayloadFixture(overrides: Partial<ReservaConfirmadaPayloadV1> = {}): ReservaConfirmadaPayloadV1 {
  return {
    versao: 1,
    papel: 'solicitante',
    numero: 77,
    nomeSolicitante: 'Fulano',
    tipoEmprestimo: 'interno',
    dataIso: '2026-08-20T00:00:00.000Z',
    periodos: ['TARDE'],
    ambiente: 'Lab 1',
    finalidade: 'Aula prática',
    atividadeExterna: null,
    local: null,
    cidade: null,
    observacoes: null,
    itensPatrimonio: [{ numero: 'PAT-9', marca: 'Dell', modelo: 'Latitude', categoria: 'Notebook' }],
    itensPapelaria: [],
    itensServico: [],
    notebooksComDominio: null,
    tipoDominio: null,
    assinaturaConfirmadaEmIso: null,
    ...overrides,
  }
}

function eventoFixture(
  id: string,
  tipo: EventoFake['tipo'],
  solicitacaoId: string,
  destinatario: string,
  createdAt = new Date('2026-08-20T09:00:00.000Z'),
  payload: unknown = null
): EventoFake {
  return {
    id,
    tipo,
    solicitacaoId,
    destinatario,
    status: 'PENDENTE',
    tentativas: 0,
    erro: null,
    payload,
    enviadoEm: null,
    createdAt,
  }
}

const originalConsoleError = console.error
async function silenciado(fn: () => Promise<void>): Promise<void> {
  console.error = () => {}
  try {
    await fn()
  } finally {
    console.error = originalConsoleError
  }
}

async function main() {
  instalarMockPrisma()

  // --- A) PENDENTE abandonado, status ainda PRONTA_RETIRADA → envia --------
  resetMocks()
  eventos.set('evt-A', eventoFixture('evt-A', 'PRONTA_RETIRADA', 'sol-A', 'solicitante-a@example.com'))
  solicitacoes.set('sol-A', solicitacaoFixture('sol-A', 'PRONTA_RETIRADA', 'Fulano'))
  instalarMockSendEmail(() => ({ success: true, providerId: 'p-A', originalRecipient: 'x', physicalRecipient: 'x', isTest: false }))
  {
    const resumo = await processarEmailsPendentes(10)
    assert(resumo.encontrados === 1, 'A) dispatcher encontra o evento PENDENTE abandonado', resumo)
    assert(resumo.processados === 1 && resumo.enviados === 1 && resumo.falhas === 0 && resumo.ignorados === 0, 'A) evento é processado e enviado', resumo)
    assert(eventos.get('evt-A')?.status === 'ENVIADO', 'A) estado final do evento é ENVIADO', eventos.get('evt-A')?.status)
    assert(sendEmailCalls.length === 1, 'A) sendEmail foi chamado exatamente uma vez', sendEmailCalls.length)
  }

  // --- B) PRONTA_RETIRADA PENDENTE, status atual EM_UTILIZACAO → OBSOLETO --
  resetMocks()
  eventos.set('evt-B', eventoFixture('evt-B', 'PRONTA_RETIRADA', 'sol-B', 'x@example.com'))
  solicitacoes.set('sol-B', solicitacaoFixture('sol-B', 'EM_UTILIZACAO', 'Fulano'))
  instalarMockSendEmail(() => ({ success: true, providerId: 'p-B', originalRecipient: 'x', physicalRecipient: 'x', isTest: false }))
  {
    const resumo = await processarEmailsPendentes(10)
    assert(resumo.processados === 1, 'B) evento é reivindicado (claim efetivo)', resumo)
    assert(resumo.enviados === 0 && resumo.falhas === 0, 'B) não é contado como enviado nem como falha técnica', resumo)
    assert(resumo.obsoletos === 1, 'B) é contado em obsoletos (contador dedicado)', resumo)
  }
  assert(eventos.get('evt-B')?.status === 'OBSOLETO', 'B) evento é persistido como OBSOLETO, não ENVIADO', eventos.get('evt-B')?.status)
  assert(sendEmailCalls.length === 0, 'B) provider/sendEmail nunca é chamado — reserva não está mais pronta para retirada', sendEmailCalls.length)

  // --- C) PRONTA_RETIRADA PENDENTE, status atual NAO_RETIRADA → OBSOLETO ---
  resetMocks()
  eventos.set('evt-C', eventoFixture('evt-C', 'PRONTA_RETIRADA', 'sol-C', 'x@example.com'))
  solicitacoes.set('sol-C', solicitacaoFixture('sol-C', 'NAO_RETIRADA', 'Fulano'))
  instalarMockSendEmail(() => ({ success: true, providerId: 'p-C', originalRecipient: 'x', physicalRecipient: 'x', isTest: false }))
  {
    const resumo = await processarEmailsPendentes(10)
    assert(resumo.obsoletos === 1, 'C) contado em obsoletos', resumo)
  }
  assert(eventos.get('evt-C')?.status === 'OBSOLETO', 'C) evento PRONTA_RETIRADA vira OBSOLETO quando status atual é NAO_RETIRADA', eventos.get('evt-C')?.status)
  assert(sendEmailCalls.length === 0, 'C) sendEmail nunca é chamado', sendEmailCalls.length)

  // --- D) PRONTA_RETIRADA PENDENTE, status atual CANCELADA → OBSOLETO ------
  resetMocks()
  eventos.set('evt-D', eventoFixture('evt-D', 'PRONTA_RETIRADA', 'sol-D', 'x@example.com'))
  solicitacoes.set('sol-D', solicitacaoFixture('sol-D', 'CANCELADA', 'Fulano'))
  instalarMockSendEmail(() => ({ success: true, providerId: 'p-D', originalRecipient: 'x', physicalRecipient: 'x', isTest: false }))
  {
    const resumo = await processarEmailsPendentes(10)
    assert(resumo.obsoletos === 1, 'D) contado em obsoletos', resumo)
  }
  assert(eventos.get('evt-D')?.status === 'OBSOLETO', 'D) evento PRONTA_RETIRADA vira OBSOLETO quando status atual é CANCELADA', eventos.get('evt-D')?.status)
  assert(sendEmailCalls.length === 0, 'D) sendEmail nunca é chamado', sendEmailCalls.length)

  // --- E) NAO_RETIRADA + status atual NAO_RETIRADA → envia -----------------
  resetMocks()
  eventos.set('evt-E', eventoFixture('evt-E', 'NAO_RETIRADA', 'sol-E', 'x@example.com'))
  solicitacoes.set('sol-E', solicitacaoFixture('sol-E', 'NAO_RETIRADA', 'Fulano'))
  instalarMockSendEmail(() => ({ success: true, providerId: 'p-E', originalRecipient: 'x', physicalRecipient: 'x', isTest: false }))
  {
    const resumo = await processarEmailsPendentes(10)
    assert(resumo.enviados === 1, 'E) evento NAO_RETIRADA com status ainda compatível é enviado', resumo)
    assert(eventos.get('evt-E')?.status === 'ENVIADO', 'E) estado final é ENVIADO', eventos.get('evt-E')?.status)
    assert(sendEmailCalls.length === 1, 'E) sendEmail foi chamado', sendEmailCalls.length)
  }

  // --- F) NAO_RETIRADA + status atual incompatível → OBSOLETO --------------
  resetMocks()
  eventos.set('evt-F', eventoFixture('evt-F', 'NAO_RETIRADA', 'sol-F', 'x@example.com'))
  solicitacoes.set('sol-F', solicitacaoFixture('sol-F', 'EM_UTILIZACAO', 'Fulano'))
  instalarMockSendEmail(() => ({ success: true, providerId: 'p-F', originalRecipient: 'x', physicalRecipient: 'x', isTest: false }))
  {
    const resumo = await processarEmailsPendentes(10)
    assert(resumo.obsoletos === 1, 'F) contado em obsoletos', resumo)
  }
  assert(eventos.get('evt-F')?.status === 'OBSOLETO', 'F) evento NAO_RETIRADA vira OBSOLETO quando status atual não bate mais', eventos.get('evt-F')?.status)
  assert(sendEmailCalls.length === 0, 'F) sendEmail nunca é chamado', sendEmailCalls.length)

  // --- G) OBSOLETO nunca é selecionado pelo dispatcher ----------------------
  resetMocks()
  eventos.set('evt-G-obsoleto', { ...eventoFixture('evt-G-obsoleto', 'PRONTA_RETIRADA', 'sol-G', 'x@example.com'), status: 'OBSOLETO' })
  eventos.set('evt-G-pendente', eventoFixture('evt-G-pendente', 'PRONTA_RETIRADA', 'sol-G', 'x@example.com', new Date('2026-08-20T09:30:00.000Z')))
  solicitacoes.set('sol-G', solicitacaoFixture('sol-G', 'PRONTA_RETIRADA', 'Fulano'))
  instalarMockSendEmail(() => ({ success: true, providerId: 'p-G', originalRecipient: 'x', physicalRecipient: 'x', isTest: false }))
  {
    const resumo = await processarEmailsPendentes(10)
    assert(resumo.encontrados === 1, 'G) o findMany do dispatcher nunca inclui o evento OBSOLETO — só o PENDENTE', resumo)
    assert(eventos.get('evt-G-obsoleto')?.status === 'OBSOLETO', 'G) evento OBSOLETO permanece intocado', eventos.get('evt-G-obsoleto')?.status)
  }

  // --- H) OBSOLETO nunca é reprocessado automaticamente ---------------------
  resetMocks()
  eventos.set('evt-H', { ...eventoFixture('evt-H', 'PRONTA_RETIRADA', 'sol-H', 'x@example.com'), status: 'OBSOLETO' })
  solicitacoes.set('sol-H', solicitacaoFixture('sol-H', 'PRONTA_RETIRADA', 'Fulano'))
  instalarMockSendEmail(() => ({ success: true, providerId: 'p-H', originalRecipient: 'x', physicalRecipient: 'x', isTest: false }))
  {
    const resumo = await processarEmailsPendentes(10)
    assert(resumo.encontrados === 0, 'H) dispatcher não encontra o evento (já não está PENDENTE)', resumo)
    assert(eventos.get('evt-H')?.status === 'OBSOLETO', 'H) evento permanece OBSOLETO — nunca volta a PENDENTE nem é reenviado', eventos.get('evt-H')?.status)
    assert(sendEmailCalls.length === 0, 'H) sendEmail nunca é chamado', sendEmailCalls.length)
  }

  // --- I) processados incrementa sempre que houve claim efetivo -------------
  resetMocks()
  eventos.set('evt-I', eventoFixture('evt-I', 'PRONTA_RETIRADA', 'sol-I', 'x@example.com'))
  solicitacoes.set('sol-I', solicitacaoFixture('sol-I', 'PRONTA_RETIRADA', 'Fulano'))
  instalarMockSendEmail(() => ({ success: true, providerId: 'p-I', originalRecipient: 'x', physicalRecipient: 'x', isTest: false }))
  {
    const resumo = await processarEmailsPendentes(10)
    assert(resumo.processados === 1, 'I) processados incrementa quando houve claim efetivo (evento ENVIADO)', resumo)
  }

  // --- J) obsoletos incrementa só para resultado OBSOLETO (lote misto) -----
  resetMocks()
  eventos.set('evt-J-enviado', eventoFixture('evt-J-enviado', 'PRONTA_RETIRADA', 'sol-J-enviado', 'enviado@example.com', new Date('2026-08-20T09:00:00.000Z')))
  eventos.set('evt-J-obsoleto', eventoFixture('evt-J-obsoleto', 'PRONTA_RETIRADA', 'sol-J-obsoleto', 'obsoleto@example.com', new Date('2026-08-20T09:10:00.000Z')))
  eventos.set('evt-J-falha', eventoFixture('evt-J-falha', 'PRONTA_RETIRADA', 'sol-J-falha', 'falha@example.com', new Date('2026-08-20T09:20:00.000Z')))
  solicitacoes.set('sol-J-enviado', solicitacaoFixture('sol-J-enviado', 'PRONTA_RETIRADA', 'Fulano Enviado'))
  solicitacoes.set('sol-J-obsoleto', solicitacaoFixture('sol-J-obsoleto', 'CANCELADA', 'Fulano Obsoleto'))
  solicitacoes.set('sol-J-falha', solicitacaoFixture('sol-J-falha', 'PRONTA_RETIRADA', 'Fulano Falha'))
  instalarMockSendEmail((input) =>
    input.to === 'falha@example.com'
      ? { success: false, originalRecipient: input.to, physicalRecipient: input.to, isTest: false, error: 'Erro simulado do provedor.' }
      : { success: true, providerId: `p-${input.to}`, originalRecipient: input.to, physicalRecipient: input.to, isTest: false }
  )
  {
    const resumo = await processarEmailsPendentes(10)
    assert(resumo.encontrados === 3, 'J) os três eventos do lote são encontrados', resumo)
    assert(resumo.enviados === 1, 'J) exatamente um enviado', resumo)
    assert(resumo.falhas === 1, 'J) exatamente uma falha', resumo)
    assert(resumo.obsoletos === 1, 'J) exatamente um obsoleto — não vaza para ignorados nem para falhas', resumo)
    assert(resumo.ignorados === 0, 'J) nenhum ignorado neste lote (todos os três tiveram claim efetivo e desfecho definido)', resumo)
  }

  // --- K) Dois dispatchers concorrentes: NAO_REIVINDICADO não incrementa processados ---
  resetMocks()
  eventos.set('evt-K', eventoFixture('evt-K', 'PRONTA_RETIRADA', 'sol-K', 'x@example.com'))
  solicitacoes.set('sol-K', solicitacaoFixture('sol-K', 'PRONTA_RETIRADA', 'Fulano'))
  instalarMockSendEmail(() => ({ success: true, providerId: 'p-K', originalRecipient: 'x', physicalRecipient: 'x', isTest: false }))
  {
    const [resumoK1, resumoK2] = await Promise.all([processarEmailsPendentes(10), processarEmailsPendentes(10)])
    assert(sendEmailCalls.length === 1, 'K) sendEmail é chamado só uma vez entre os dois dispatchers', sendEmailCalls.length)
    assert(
      resumoK1.processados + resumoK2.processados === 1,
      'K) só um dos dois dispatchers conta o evento como processado (o outro perdeu o claim, NAO_REIVINDICADO)',
      { resumoK1, resumoK2 }
    )
    assert(
      resumoK1.enviados + resumoK2.enviados === 1,
      'K) só um dos dois dispatchers conta o evento como enviado',
      { resumoK1, resumoK2 }
    )
    assert(eventos.get('evt-K')?.status === 'ENVIADO', 'K) estado final do evento é ENVIADO', eventos.get('evt-K')?.status)
  }

  // --- L) Um evento obsoleto no lote não impede o processamento dos demais -
  resetMocks()
  eventos.set('evt-L-obsoleto', eventoFixture('evt-L-obsoleto', 'PRONTA_RETIRADA', 'sol-L-obsoleto', 'obsoleto@example.com', new Date('2026-08-20T09:00:00.000Z')))
  eventos.set('evt-L-ok', eventoFixture('evt-L-ok', 'PRONTA_RETIRADA', 'sol-L-ok', 'ok@example.com', new Date('2026-08-20T09:30:00.000Z')))
  solicitacoes.set('sol-L-obsoleto', solicitacaoFixture('sol-L-obsoleto', 'CANCELADA', 'Fulano Obsoleto'))
  solicitacoes.set('sol-L-ok', solicitacaoFixture('sol-L-ok', 'PRONTA_RETIRADA', 'Fulano OK'))
  instalarMockSendEmail((input) => ({ success: true, providerId: `p-${input.to}`, originalRecipient: input.to, physicalRecipient: input.to, isTest: false }))
  {
    const resumo = await processarEmailsPendentes(10)
    assert(resumo.encontrados === 2, 'L) dispatcher encontra os dois eventos do lote', resumo)
    assert(resumo.obsoletos === 1 && resumo.enviados === 1, 'L) um termina obsoleto e o outro enviado, sem contaminação entre contadores', resumo)
  }
  assert(eventos.get('evt-L-obsoleto')?.status === 'OBSOLETO', 'L) o item obsoleto é persistido como OBSOLETO, sem envio', eventos.get('evt-L-obsoleto')?.status)
  assert(eventos.get('evt-L-ok')?.status === 'ENVIADO', 'L) o item saudável é enviado normalmente apesar do outro ser obsoleto', eventos.get('evt-L-ok')?.status)
  assert(sendEmailCalls.length === 1, 'L) sendEmail só foi chamado para o item saudável', sendEmailCalls.length)

  // --- M) Starvation: tipos não suportados mais antigos não ocupam o limite ---
  // (correção pós-Codex-Review: o WHERE do findMany já filtra por
  // TIPOS_EMAIL_SUPORTADOS — sem isso, os três eventos não suportados
  // abaixo, por serem mais antigos, ocupariam sozinhos um `limite` de 3 e
  // o evento PRONTA_RETIRADA mais novo nunca seria alcançado.)
  //
  // Etapa email-aguardando-patrimonio: SOLICITACAO_AGUARDANDO_PATRIMONIO
  // acabou de ganhar template/suporte no dispatcher — era o ÚLTIMO valor
  // real do enum ainda não suportado, então não sobra nenhum para servir
  // de exemplo "tipo não suportado" (mesma classe de ajuste já feita 3x
  // antes — ver comentário em TipoEventoFake acima). Substituído pelo
  // valor sintético TIPO_INEXISTENTE_TESTE, reusado nas três fixtures
  // abaixo (o teste só precisa de "tipo fora de TIPOS_EMAIL_SUPORTADOS",
  // não de tipos distintos entre si).
  resetMocks()
  eventos.set('evt-M-nao-suportado-1', eventoFixture('evt-M-nao-suportado-1', 'TIPO_INEXISTENTE_TESTE', 'sol-M-x', 'x@example.com', new Date('2026-08-20T08:00:00.000Z')))
  eventos.set('evt-M-nao-suportado-2', eventoFixture('evt-M-nao-suportado-2', 'TIPO_INEXISTENTE_TESTE', 'sol-M-x', 'x2@example.com', new Date('2026-08-20T08:10:00.000Z')))
  eventos.set('evt-M-nao-suportado-3', eventoFixture('evt-M-nao-suportado-3', 'TIPO_INEXISTENTE_TESTE', 'sol-M-x', 'x3@example.com', new Date('2026-08-20T08:20:00.000Z')))
  eventos.set('evt-M-pronta', eventoFixture('evt-M-pronta', 'PRONTA_RETIRADA', 'sol-M-pronta', 'pronta@example.com', new Date('2026-08-20T09:00:00.000Z')))
  solicitacoes.set('sol-M-pronta', solicitacaoFixture('sol-M-pronta', 'PRONTA_RETIRADA', 'Fulano'))
  instalarMockSendEmail(() => ({ success: true, providerId: 'p-M', originalRecipient: 'x', physicalRecipient: 'x', isTest: false }))
  {
    // Limite pequeno (3) — se o filtro por tipo não existisse, os três
    // eventos não suportados (mais antigos) esgotariam o `take` e o evento
    // PRONTA_RETIRADA nunca apareceria em `encontrados`.
    const resumo = await processarEmailsPendentes(3)
    assert(resumo.encontrados === 1, 'M) só o evento de tipo suportado é encontrado, mesmo com eventos não suportados mais antigos', resumo)
    assert(resumo.enviados === 1, 'M) o evento suportado é processado e enviado normalmente', resumo)
  }
  assert(eventos.get('evt-M-pronta')?.status === 'ENVIADO', 'M) evento suportado termina ENVIADO', eventos.get('evt-M-pronta')?.status)
  assert(eventos.get('evt-M-nao-suportado-1')?.status === 'PENDENTE', 'M) tipo não suportado continua PENDENTE', eventos.get('evt-M-nao-suportado-1')?.status)
  assert(eventos.get('evt-M-nao-suportado-2')?.status === 'PENDENTE', 'M) segundo evento não suportado continua PENDENTE', eventos.get('evt-M-nao-suportado-2')?.status)
  assert(eventos.get('evt-M-nao-suportado-3')?.status === 'PENDENTE', 'M) terceiro evento não suportado continua PENDENTE', eventos.get('evt-M-nao-suportado-3')?.status)

  // --- N) PRONTA_RETIRADA e NAO_RETIRADA são ambos selecionados -------------
  resetMocks()
  eventos.set('evt-N-pronta', eventoFixture('evt-N-pronta', 'PRONTA_RETIRADA', 'sol-N-pronta', 'pronta@example.com', new Date('2026-08-20T09:00:00.000Z')))
  eventos.set('evt-N-nao-retirada', eventoFixture('evt-N-nao-retirada', 'NAO_RETIRADA', 'sol-N-nao-retirada', 'naoretirada@example.com', new Date('2026-08-20T09:10:00.000Z')))
  solicitacoes.set('sol-N-pronta', solicitacaoFixture('sol-N-pronta', 'PRONTA_RETIRADA', 'Fulano'))
  solicitacoes.set('sol-N-nao-retirada', solicitacaoFixture('sol-N-nao-retirada', 'NAO_RETIRADA', 'Ciclano'))
  instalarMockSendEmail((input) => ({ success: true, providerId: `p-${input.to}`, originalRecipient: input.to, physicalRecipient: input.to, isTest: false }))
  {
    const resumo = await processarEmailsPendentes(10)
    assert(resumo.encontrados === 2, 'N) ambos os tipos suportados (PRONTA_RETIRADA e NAO_RETIRADA) são encontrados', resumo)
    assert(resumo.enviados === 2, 'N) ambos são processados e enviados', resumo)
  }
  assert(eventos.get('evt-N-pronta')?.status === 'ENVIADO', 'N) PRONTA_RETIRADA enviado', eventos.get('evt-N-pronta')?.status)
  assert(eventos.get('evt-N-nao-retirada')?.status === 'ENVIADO', 'N) NAO_RETIRADA enviado', eventos.get('evt-N-nao-retirada')?.status)

  // --- O) APP_URL ausente/inválido → FALHA (não fica PENDENTE preso) -------
  // Correção pós-Codex-Review: buildAppUrl() agora só é chamado DENTRO do
  // `build` (ver dispatcher.ts) — ou seja, depois do claim — então uma
  // falha de configuração de APP_URL atravessa o mesmo caminho de
  // processarEmailEvento() que qualquer outra falha de template.
  resetMocks()
  eventos.set('evt-O', eventoFixture('evt-O', 'PRONTA_RETIRADA', 'sol-O', 'x@example.com'))
  solicitacoes.set('sol-O', solicitacaoFixture('sol-O', 'PRONTA_RETIRADA', 'Fulano'))
  instalarMockSendEmail(() => ({ success: true, providerId: 'p-O', originalRecipient: 'x', physicalRecipient: 'x', isTest: false }))
  const appUrlOriginal = process.env.APP_URL
  process.env.APP_URL = ''
  resetAppUrlCache()
  {
    let resumo!: Awaited<ReturnType<typeof processarEmailsPendentes>>
    await silenciado(async () => {
      resumo = await processarEmailsPendentes(10)
    })
    assert(resumo.encontrados === 1, 'O) evento é encontrado normalmente', resumo)
    assert(resumo.processados === 1, 'O) claim efetivo conta em processados', resumo)
    assert(resumo.falhas === 1, 'O) conta em falhas', resumo)
    assert(resumo.ignorados === 0, 'O) não conta em ignorados', resumo)
  }
  assert(eventos.get('evt-O')?.status === 'FALHA', 'O) evento termina FALHA (não fica PENDENTE preso)', eventos.get('evt-O')?.status)
  assert(eventos.get('evt-O')?.tentativas === 1, 'O) tentativas incrementada uma única vez (via claim)', eventos.get('evt-O')?.tentativas)
  assert(sendEmailCalls.length === 0, 'O) provider/sendEmail nunca é chamado', sendEmailCalls.length)

  // --- P) Rodar o dispatcher de novo: evento já FALHA não é reselecionado --
  {
    const resumo = await processarEmailsPendentes(10)
    assert(resumo.encontrados === 0, 'P) evento em FALHA não é encontrado numa nova execução do dispatcher', resumo)
  }
  assert(sendEmailCalls.length === 0, 'P) provider continua nunca sendo chamado', sendEmailCalls.length)

  // Restaura APP_URL válido para os testes seguintes (Q e os demais deste arquivo).
  process.env.APP_URL = appUrlOriginal
  resetAppUrlCache()

  // --- Q) Mesmo cenário (APP_URL inválido) com NAO_RETIRADA ----------------
  resetMocks()
  eventos.set('evt-Q', eventoFixture('evt-Q', 'NAO_RETIRADA', 'sol-Q', 'x@example.com'))
  solicitacoes.set('sol-Q', solicitacaoFixture('sol-Q', 'NAO_RETIRADA', 'Fulano'))
  instalarMockSendEmail(() => ({ success: true, providerId: 'p-Q', originalRecipient: 'x', physicalRecipient: 'x', isTest: false }))
  process.env.APP_URL = ''
  resetAppUrlCache()
  {
    let resumo!: Awaited<ReturnType<typeof processarEmailsPendentes>>
    await silenciado(async () => {
      resumo = await processarEmailsPendentes(10)
    })
    assert(resumo.falhas === 1 && resumo.ignorados === 0, 'Q) NAO_RETIRADA com APP_URL inválido também termina em falhas, não em ignorados', resumo)
  }
  assert(eventos.get('evt-Q')?.status === 'FALHA', 'Q) evento NAO_RETIRADA termina FALHA', eventos.get('evt-Q')?.status)
  assert(sendEmailCalls.length === 0, 'Q) provider/sendEmail nunca é chamado', sendEmailCalls.length)
  process.env.APP_URL = appUrlOriginal
  resetAppUrlCache()

  // --- R) APP_URL válido → comportamento normal continua funcionando -------
  resetMocks()
  eventos.set('evt-R', eventoFixture('evt-R', 'PRONTA_RETIRADA', 'sol-R', 'r@example.com'))
  solicitacoes.set('sol-R', solicitacaoFixture('sol-R', 'PRONTA_RETIRADA', 'Fulano'))
  instalarMockSendEmail(() => ({ success: true, providerId: 'p-R', originalRecipient: 'r@example.com', physicalRecipient: 'r@example.com', isTest: false }))
  {
    const resumo = await processarEmailsPendentes(10)
    assert(resumo.enviados === 1, 'R) com APP_URL válido, o envio continua funcionando normalmente', resumo)
  }
  assert(eventos.get('evt-R')?.status === 'ENVIADO', 'R) evento termina ENVIADO', eventos.get('evt-R')?.status)
  assert(sendEmailCalls.length === 1, 'R) sendEmail foi chamado', sendEmailCalls.length)

  // --- Bônus: erro inesperado (não "obsoleto") em um item não impede os demais ---
  resetMocks()
  eventos.set('evt-erro', eventoFixture('evt-erro', 'PRONTA_RETIRADA', 'sol-erro', 'erro@example.com', new Date('2026-08-20T09:00:00.000Z')))
  eventos.set('evt-ok2', eventoFixture('evt-ok2', 'PRONTA_RETIRADA', 'sol-ok2', 'ok2@example.com', new Date('2026-08-20T09:30:00.000Z')))
  solicitacoes.set('sol-ok2', solicitacaoFixture('sol-ok2', 'PRONTA_RETIRADA', 'Fulano OK'))
  // sol-erro: propositalmente SEM fixture de solicitação — prisma.solicitacao.findUnique
  // lança (simulando falha de banco) ao tentar montar o template deste item.
  solicitacaoDeveFalhar.add('sol-erro')
  instalarMockSendEmail((input) => ({ success: true, providerId: `p-${input.to}`, originalRecipient: input.to, physicalRecipient: input.to, isTest: false }))
  let resumoBonus: Awaited<ReturnType<typeof processarEmailsPendentes>>
  await silenciado(async () => {
    resumoBonus = await processarEmailsPendentes(10)
  })
  assert(eventos.get('evt-ok2')?.status === 'ENVIADO', 'Bônus) o item saudável é processado apesar do erro inesperado no outro', eventos.get('evt-ok2')?.status)
  assert(eventos.get('evt-erro')?.status === 'PENDENTE', 'Bônus) o item com erro inesperado permanece PENDENTE (nunca chegou a reivindicar)', eventos.get('evt-erro')?.status)
  assert(resumoBonus!.ignorados >= 1, 'Bônus) o item com erro inesperado é contabilizado como ignorado', resumoBonus!)

  // =========================================================================
  // RESERVA_CONFIRMADA (Etapa D.3.6.5) — dispatcher usa EXCLUSIVAMENTE
  // EmailEvento.payload (snapshot histórico) para montar o e-mail. Nenhum
  // dos testes abaixo registra uma Solicitacao "compatível" no mock (na
  // maioria, nenhuma Solicitacao é registrada — ver `solicitacoes` sempre
  // vazio para esses `sol-*` ids): se o dispatcher algum dia voltasse a
  // depender de `prisma.solicitacao.findUnique` para este tipo, esses
  // testes quebrariam (evento ignorado por "solicitação não encontrada",
  // em vez de enviado) — essa é a prova de independência do catálogo vivo
  // (finding do Codex Review; achado da Etapa D.3.6.1/D.3.6.5).
  // =========================================================================

  // --- S) Interno, papel=solicitante (do payload) → ENVIADO ----------------
  resetMocks()
  eventos.set(
    'evt-S',
    eventoFixture(
      'evt-S',
      'RESERVA_CONFIRMADA',
      'sol-S',
      'solicitante-s@example.com',
      undefined,
      reservaConfirmadaPayloadFixture({ papel: 'solicitante', nomeSolicitante: 'Fulano Interno' })
    )
  )
  instalarMockSendEmail((input) => ({ success: true, providerId: `p-${input.to}`, originalRecipient: input.to, physicalRecipient: input.to, isTest: false }))
  {
    const resumo = await processarEmailsPendentes(10)
    assert(resumo.enviados === 1, 'S) RESERVA_CONFIRMADA interno (payload.papel=solicitante) é enviado', resumo)
  }
  assert(eventos.get('evt-S')?.status === 'ENVIADO', 'S) estado final é ENVIADO', eventos.get('evt-S')?.status)
  assert(sendEmailCalls[0]?.subject === '[Fluxo Patrimonial] Sua reserva foi confirmada — #77', 'S) papel do payload é solicitante — assunto correto', sendEmailCalls[0]?.subject)
  assert(!!sendEmailCalls[0]?.html.includes('Sua reserva foi confirmada pelo Patrimônio.'), 'S) corpo usa a variante interna do template (papel solicitante)', sendEmailCalls[0]?.html)

  // --- T) Interno, papel=patrimonio (do payload) → assunto/corpo do Patrimônio
  resetMocks()
  eventos.set(
    'evt-T',
    eventoFixture(
      'evt-T',
      'RESERVA_CONFIRMADA',
      'sol-T',
      'patrimonio-t@example.com',
      undefined,
      reservaConfirmadaPayloadFixture({ papel: 'patrimonio', nomeSolicitante: 'Beltrano' })
    )
  )
  instalarMockSendEmail((input) => ({ success: true, providerId: `p-${input.to}`, originalRecipient: input.to, physicalRecipient: input.to, isTest: false }))
  {
    const resumo = await processarEmailsPendentes(10)
    assert(resumo.enviados === 1, 'T) RESERVA_CONFIRMADA interno (payload.papel=patrimonio) é enviado', resumo)
  }
  assert(sendEmailCalls[0]?.subject === '[Fluxo Patrimonial] Reserva confirmada — #77 — Beltrano', 'T) papel do payload é patrimonio — assunto correto', sendEmailCalls[0]?.subject)
  assert(!!sendEmailCalls[0]?.html.includes('A reserva de Beltrano foi confirmada.'), 'T) corpo usa a variante interna do template (papel patrimonio)', sendEmailCalls[0]?.html)

  // --- U) Papel histórico: payload.papel=patrimonio NÃO é recalculado, mesmo
  // que o destinatário do evento coincida com o e-mail atual do solicitante
  // no mock (Etapa D.3.6.5, item 16 — dispatcher não reconstrói mais papel a
  // partir de evento.destinatario/solicitante.email; usa payload.papel tal
  // qual persistido).
  resetMocks()
  eventos.set(
    'evt-U',
    eventoFixture(
      'evt-U',
      'RESERVA_CONFIRMADA',
      'sol-U',
      'ambos@example.com',
      undefined,
      reservaConfirmadaPayloadFixture({ papel: 'patrimonio', nomeSolicitante: 'Ambos Papéis' })
    )
  )
  // Solicitacao presente de propósito, com o MESMO e-mail do destinatário do
  // evento — se o dispatcher ainda recalculasse o papel comparando esses
  // dois e-mails (comportamento antigo, pré-D.3.6.5), o resultado seria
  // 'solicitante', não 'patrimonio'.
  solicitacoes.set('sol-U', solicitacaoReservaConfirmadaFixture('sol-U', { tipoEmprestimo: 'interno', solicitanteEmail: 'ambos@example.com', solicitanteNome: 'Ambos Papéis' }))
  instalarMockSendEmail((input) => ({ success: true, providerId: `p-${input.to}`, originalRecipient: input.to, physicalRecipient: input.to, isTest: false }))
  await processarEmailsPendentes(10)
  assert(
    !!sendEmailCalls[0]?.subject.startsWith('[Fluxo Patrimonial] Reserva confirmada —'),
    'U) papel permanece patrimonio (do payload) mesmo com destinatário=e-mail atual do solicitante no mock — dispatcher não recalcula',
    sendEmailCalls[0]?.subject
  )

  // --- V) Externo, papel=solicitante → template externo, menciona assinatura
  resetMocks()
  eventos.set(
    'evt-V',
    eventoFixture(
      'evt-V',
      'RESERVA_CONFIRMADA',
      'sol-V',
      'solicitante-v@example.com',
      undefined,
      reservaConfirmadaPayloadFixture({
        papel: 'solicitante',
        nomeSolicitante: 'Ciclana',
        tipoEmprestimo: 'externo',
        ambiente: null,
        finalidade: null,
        atividadeExterna: 'Feira de tecnologia',
        local: 'Centro de Convenções',
        cidade: 'São Paulo',
        assinaturaConfirmadaEmIso: '2026-08-19T10:00:00.000Z',
      })
    )
  )
  instalarMockSendEmail((input) => ({ success: true, providerId: `p-${input.to}`, originalRecipient: input.to, physicalRecipient: input.to, isTest: false }))
  {
    const resumo = await processarEmailsPendentes(10)
    assert(resumo.enviados === 1, 'V) RESERVA_CONFIRMADA externo (payload.papel=solicitante) é enviado', resumo)
  }
  assert(
    !!sendEmailCalls[0]?.html.includes('Sua reserva foi confirmada após a conclusão da etapa de assinatura.'),
    'V) template externo solicitante menciona a conclusão da etapa de assinatura — a partir do payload',
    sendEmailCalls[0]?.html
  )

  // --- W) Externo, papel=patrimonio → assunto inclui nome do solicitante ---
  resetMocks()
  eventos.set(
    'evt-W',
    eventoFixture(
      'evt-W',
      'RESERVA_CONFIRMADA',
      'sol-W',
      'patrimonio-w@example.com',
      undefined,
      reservaConfirmadaPayloadFixture({
        papel: 'patrimonio',
        nomeSolicitante: 'Ciclana W',
        tipoEmprestimo: 'externo',
        ambiente: null,
        finalidade: null,
        atividadeExterna: 'Feira de tecnologia',
        local: 'Centro de Convenções',
        cidade: 'São Paulo',
        assinaturaConfirmadaEmIso: '2026-08-19T10:00:00.000Z',
      })
    )
  )
  instalarMockSendEmail((input) => ({ success: true, providerId: `p-${input.to}`, originalRecipient: input.to, physicalRecipient: input.to, isTest: false }))
  await processarEmailsPendentes(10)
  assert(sendEmailCalls[0]?.subject === '[Fluxo Patrimonial] Reserva confirmada — #77 — Ciclana W', 'W) assunto do Patrimônio inclui o nome do solicitante — do payload', sendEmailCalls[0]?.subject)
  assert(
    !!sendEmailCalls[0]?.html.includes('A reserva externa de Ciclana W foi confirmada após a conclusão da etapa de assinatura.'),
    'W) corpo do Patrimônio menciona a reserva externa confirmada após a assinatura — do payload',
    sendEmailCalls[0]?.html
  )

  // --- X) assinaturaConfirmadaEmIso do payload → chega ao template ---------
  resetMocks()
  eventos.set(
    'evt-X',
    eventoFixture(
      'evt-X',
      'RESERVA_CONFIRMADA',
      'sol-X',
      'solicitante-x@example.com',
      undefined,
      reservaConfirmadaPayloadFixture({ papel: 'solicitante', tipoEmprestimo: 'externo', ambiente: null, finalidade: null, assinaturaConfirmadaEmIso: '2026-08-19T14:30:00.000Z' })
    )
  )
  instalarMockSendEmail((input) => ({ success: true, providerId: `p-${input.to}`, originalRecipient: input.to, physicalRecipient: input.to, isTest: false }))
  await processarEmailsPendentes(10)
  assert(!!sendEmailCalls[0]?.html.includes('Assinatura confirmada em'), 'X) linha "Assinatura confirmada em" aparece quando payload.assinaturaConfirmadaEmIso está presente', sendEmailCalls[0]?.html)

  // --- Y) assinaturaConfirmadaEmIso ausente (null) → template continua válido
  resetMocks()
  eventos.set(
    'evt-Y',
    eventoFixture(
      'evt-Y',
      'RESERVA_CONFIRMADA',
      'sol-Y',
      'solicitante-y@example.com',
      undefined,
      reservaConfirmadaPayloadFixture({ papel: 'solicitante', tipoEmprestimo: 'externo', ambiente: null, finalidade: null, assinaturaConfirmadaEmIso: null })
    )
  )
  instalarMockSendEmail((input) => ({ success: true, providerId: `p-${input.to}`, originalRecipient: input.to, physicalRecipient: input.to, isTest: false }))
  {
    const resumo = await processarEmailsPendentes(10)
    assert(resumo.enviados === 1, 'Y) processa normalmente mesmo sem assinaturaConfirmadaEmIso (dado legado)', resumo)
  }
  assert(
    !sendEmailCalls[0]?.html.includes('undefined') && !sendEmailCalls[0]?.html.includes('null'),
    'Y) HTML não contém "undefined"/"null" com assinaturaConfirmadaEmIso ausente',
    sendEmailCalls[0]?.html
  )
  assert(!sendEmailCalls[0]?.html.includes('Assinatura confirmada em'), 'Y) linha "Assinatura confirmada em" é omitida quando ausente', sendEmailCalls[0]?.html)

  // --- Z) Status atual avançado/cancelado → NÃO vira OBSOLETO (histórico) --
  // Nenhuma Solicitacao é registrada para 'sol-Z' — o dispatcher não a
  // consulta para este tipo (sem aindaValido), então nem "status atual"
  // existe para ele considerar.
  resetMocks()
  eventos.set(
    'evt-Z',
    eventoFixture('evt-Z', 'RESERVA_CONFIRMADA', 'sol-Z', 'solicitante-z@example.com', undefined, reservaConfirmadaPayloadFixture({ papel: 'solicitante' }))
  )
  instalarMockSendEmail((input) => ({ success: true, providerId: `p-${input.to}`, originalRecipient: input.to, physicalRecipient: input.to, isTest: false }))
  {
    const resumo = await processarEmailsPendentes(10)
    assert(
      resumo.obsoletos === 0 && resumo.enviados === 1,
      'Z) RESERVA_CONFIRMADA não vira OBSOLETO — evento histórico, sem aindaValido, sem sequer consultar Solicitacao',
      resumo
    )
  }
  assert(eventos.get('evt-Z')?.status === 'ENVIADO', 'Z) estado final é ENVIADO, não OBSOLETO', eventos.get('evt-Z')?.status)

  // --- AA) APP_URL inválido → claim ocorre, evento termina FALHA -----------
  resetMocks()
  eventos.set(
    'evt-AA',
    eventoFixture('evt-AA', 'RESERVA_CONFIRMADA', 'sol-AA', 'solicitante-aa@example.com', undefined, reservaConfirmadaPayloadFixture({ papel: 'solicitante' }))
  )
  instalarMockSendEmail((input) => ({ success: true, providerId: `p-${input.to}`, originalRecipient: input.to, physicalRecipient: input.to, isTest: false }))
  {
    const appUrlOriginal = process.env.APP_URL
    process.env.APP_URL = ''
    resetAppUrlCache()
    let resumo!: Awaited<ReturnType<typeof processarEmailsPendentes>>
    await silenciado(async () => {
      resumo = await processarEmailsPendentes(10)
    })
    assert(resumo.falhas === 1 && resumo.ignorados === 0, 'AA) claim ocorre e o evento termina em falhas (não em ignorados) com APP_URL inválido', resumo)
    process.env.APP_URL = appUrlOriginal
    resetAppUrlCache()
  }
  assert(eventos.get('evt-AA')?.status === 'FALHA', 'AA) evento termina FALHA — não fica PENDENTE preso', eventos.get('evt-AA')?.status)
  assert(sendEmailCalls.length === 0, 'AA) provider nunca é chamado (build falhou antes)', sendEmailCalls.length)

  // --- AB) provider falha → evento termina FALHA ----------------------------
  resetMocks()
  eventos.set(
    'evt-AB',
    eventoFixture('evt-AB', 'RESERVA_CONFIRMADA', 'sol-AB', 'solicitante-ab@example.com', undefined, reservaConfirmadaPayloadFixture({ papel: 'solicitante' }))
  )
  instalarMockSendEmail((input) => ({ success: false, originalRecipient: input.to, physicalRecipient: input.to, isTest: false, error: 'Falha simulada do provedor.' }))
  {
    const resumo = await processarEmailsPendentes(10)
    assert(resumo.falhas === 1, 'AB) provider falha → contado em falhas', resumo)
  }
  assert(eventos.get('evt-AB')?.status === 'FALHA', 'AB) evento termina FALHA', eventos.get('evt-AB')?.status)

  // --- AC) segunda execução: evento FALHA não é reselecionado ---------------
  {
    const resumo = await processarEmailsPendentes(10)
    assert(resumo.encontrados === 0, 'AC) evento em FALHA (AB) não é encontrado numa nova execução do dispatcher', resumo)
  }

  // --- AD) concorrência: dois dispatchers, só um provider call --------------
  resetMocks()
  eventos.set(
    'evt-AD',
    eventoFixture('evt-AD', 'RESERVA_CONFIRMADA', 'sol-AD', 'solicitante-ad@example.com', undefined, reservaConfirmadaPayloadFixture({ papel: 'solicitante' }))
  )
  instalarMockSendEmail((input) => ({ success: true, providerId: `p-${input.to}`, originalRecipient: input.to, physicalRecipient: input.to, isTest: false }))
  {
    const [r1, r2] = await Promise.all([processarEmailsPendentes(10), processarEmailsPendentes(10)])
    assert(sendEmailCalls.length === 1, 'AD) sendEmail chamado só uma vez entre os dois dispatchers concorrentes', sendEmailCalls.length)
    assert(r1.processados + r2.processados === 1, 'AD) só um dos dois dispatchers conta o evento como processado (o outro é NAO_REIVINDICADO)', [r1, r2])
    assert(r1.enviados + r2.enviados === 1, 'AD) só um dos dois dispatchers conta o evento como enviado', [r1, r2])
  }
  assert(eventos.get('evt-AD')?.status === 'ENVIADO', 'AD) estado final do evento é ENVIADO', eventos.get('evt-AD')?.status)

  // --- AE) starvation: não suportados mais antigos não ocupam o limite -----
  // Etapa email-aguardando-patrimonio: SOLICITACAO_AGUARDANDO_PATRIMONIO
  // ganhou suporte — trocado pelo valor sintético TIPO_INEXISTENTE_TESTE
  // (reusado duas vezes) — mesmo motivo do cenário M acima.
  resetMocks()
  eventos.set('evt-AE-nao-suportado-1', eventoFixture('evt-AE-nao-suportado-1', 'TIPO_INEXISTENTE_TESTE', 'sol-AE', 'x@example.com', new Date('2026-08-20T08:00:00.000Z')))
  eventos.set('evt-AE-nao-suportado-2', eventoFixture('evt-AE-nao-suportado-2', 'TIPO_INEXISTENTE_TESTE', 'sol-AE', 'x2@example.com', new Date('2026-08-20T08:30:00.000Z')))
  eventos.set(
    'evt-AE-reserva',
    eventoFixture(
      'evt-AE-reserva',
      'RESERVA_CONFIRMADA',
      'sol-AE',
      'solicitante-ae@example.com',
      new Date('2026-08-20T09:00:00.000Z'),
      reservaConfirmadaPayloadFixture({ papel: 'solicitante' })
    )
  )
  instalarMockSendEmail((input) => ({ success: true, providerId: `p-${input.to}`, originalRecipient: input.to, physicalRecipient: input.to, isTest: false }))
  {
    // limite 1: se os não suportados contassem para o take, RESERVA_CONFIRMADA
    // (mais novo) nunca seria alcançado.
    const resumo = await processarEmailsPendentes(1)
    assert(resumo.encontrados === 1, 'AE) RESERVA_CONFIRMADA entra no lote — eventos não suportados mais antigos não ocupam o limite', resumo)
  }
  assert(eventos.get('evt-AE-reserva')?.status === 'ENVIADO', 'AE) o evento RESERVA_CONFIRMADA é enviado', eventos.get('evt-AE-reserva')?.status)
  assert(eventos.get('evt-AE-nao-suportado-1')?.status === 'PENDENTE', 'AE) tipo não suportado continua PENDENTE', eventos.get('evt-AE-nao-suportado-1')?.status)
  assert(eventos.get('evt-AE-nao-suportado-2')?.status === 'PENDENTE', 'AE) segundo evento não suportado continua PENDENTE', eventos.get('evt-AE-nao-suportado-2')?.status)

  // --- AF) Finding do Codex (P2), reproduzido diretamente: snapshot antigo
  // no payload vs. catálogo atual divergente — a mesma Solicitacao existe no
  // mock com dados DIFERENTES (numero/marca/modelo/categoria), e mesmo assim
  // o e-mail enviado usa SOMENTE os valores do payload.
  resetMocks()
  eventos.set(
    'evt-AF',
    eventoFixture(
      'evt-AF',
      'RESERVA_CONFIRMADA',
      'sol-AF',
      'solicitante-af@example.com',
      undefined,
      reservaConfirmadaPayloadFixture({
        papel: 'solicitante',
        itensPatrimonio: [{ numero: '123', marca: 'Dell', modelo: 'Latitude', categoria: 'Notebook' }],
      })
    )
  )
  // Catálogo/solicitação ATUAL — deliberadamente divergente do payload.
  solicitacoes.set('sol-AF', {
    ...solicitacaoReservaConfirmadaFixture('sol-AF', { tipoEmprestimo: 'interno', solicitanteEmail: 'solicitante-af@example.com' }),
    itensPatrimonio: [{ patrimonio: { numero: '999', marca: 'Lenovo', modelo: 'ThinkCentre', categoria: { nome: 'Equipamento' } } }],
  })
  instalarMockSendEmail((input) => ({ success: true, providerId: `p-${input.to}`, originalRecipient: input.to, physicalRecipient: input.to, isTest: false }))
  {
    const resumo = await processarEmailsPendentes(10)
    assert(resumo.enviados === 1, 'AF) evento é enviado normalmente mesmo com uma Solicitacao divergente presente no mock', resumo)
  }
  {
    const html = sendEmailCalls[0]?.html ?? ''
    assert(html.includes('123') && html.includes('Dell') && html.includes('Latitude') && html.includes('Notebook'), 'AF) e-mail contém os valores do PAYLOAD (123/Dell/Latitude/Notebook)', html)
    assert(
      !html.includes('999') && !html.includes('Lenovo') && !html.includes('ThinkCentre') && !html.includes('Equipamento'),
      'AF) e-mail NÃO contém os valores do catálogo atual divergente (999/Lenovo/ThinkCentre/Equipamento) — reprodução direta do finding do Codex Review',
      html
    )
  }

  // --- AG) Nome histórico: payload.nomeSolicitante prevalece sobre um nome
  // "atual" diferente presente no mock de Solicitacao.
  resetMocks()
  eventos.set(
    'evt-AG',
    eventoFixture('evt-AG', 'RESERVA_CONFIRMADA', 'sol-AG', 'solicitante-ag@example.com', undefined, reservaConfirmadaPayloadFixture({ papel: 'solicitante', nomeSolicitante: 'Nome Antigo' }))
  )
  solicitacoes.set('sol-AG', solicitacaoReservaConfirmadaFixture('sol-AG', { tipoEmprestimo: 'interno', solicitanteEmail: 'solicitante-ag@example.com', solicitanteNome: 'Nome Novo' }))
  instalarMockSendEmail((input) => ({ success: true, providerId: `p-${input.to}`, originalRecipient: input.to, physicalRecipient: input.to, isTest: false }))
  await processarEmailsPendentes(10)
  assert(!!sendEmailCalls[0]?.html.includes('Nome Antigo'), 'AG) e-mail usa o nome histórico do payload ("Nome Antigo")', sendEmailCalls[0]?.html)
  assert(!sendEmailCalls[0]?.html.includes('Nome Novo'), 'AG) e-mail NÃO usa o nome "atual" divergente presente no mock ("Nome Novo")', sendEmailCalls[0]?.html)

  // --- AH) Payload ausente (null) — evento antigo sem snapshot: FALHA
  // controlada, requer reconciliação manual; nunca cai para o catálogo vivo.
  resetMocks()
  eventos.set('evt-AH', eventoFixture('evt-AH', 'RESERVA_CONFIRMADA', 'sol-AH', 'solicitante-ah@example.com', undefined, null))
  // Solicitacao presente e "completa" no mock — se o dispatcher caísse de
  // volta para o catálogo vivo quando o payload está ausente, o e-mail
  // seria montado e enviado normalmente; o teste garante que isso NÃO ocorre.
  solicitacoes.set('sol-AH', solicitacaoReservaConfirmadaFixture('sol-AH', { tipoEmprestimo: 'interno', solicitanteEmail: 'solicitante-ah@example.com' }))
  instalarMockSendEmail((input) => ({ success: true, providerId: `p-${input.to}`, originalRecipient: input.to, physicalRecipient: input.to, isTest: false }))
  {
    let resumo!: Awaited<ReturnType<typeof processarEmailsPendentes>>
    await silenciado(async () => {
      resumo = await processarEmailsPendentes(10)
    })
    assert(resumo.processados === 1 && resumo.falhas === 1 && resumo.ignorados === 0, 'AH) payload ausente: claim efetivo, termina em falhas (não em ignorados)', resumo)
  }
  assert(eventos.get('evt-AH')?.status === 'FALHA', 'AH) evento termina FALHA — payload ausente não vira fallback para o catálogo', eventos.get('evt-AH')?.status)
  assert(sendEmailCalls.length === 0, 'AH) provider nunca é chamado com payload ausente', sendEmailCalls.length)
  assert(!(eventos.get('evt-AH')?.erro ?? '').match(/solicitante-ah@example\.com|Lab 1|Aula prática/), 'AH) mensagem de erro não contém dump do conteúdo do evento/payload', eventos.get('evt-AH')?.erro)

  // --- AI) Payload malformado (campo com tipo errado) → FALHA --------------
  resetMocks()
  {
    const payloadInvalido = { ...reservaConfirmadaPayloadFixture({ papel: 'solicitante' }), numero: 'não é um número' }
    eventos.set('evt-AI', eventoFixture('evt-AI', 'RESERVA_CONFIRMADA', 'sol-AI', 'solicitante-ai@example.com', undefined, payloadInvalido))
  }
  instalarMockSendEmail((input) => ({ success: true, providerId: `p-${input.to}`, originalRecipient: input.to, physicalRecipient: input.to, isTest: false }))
  {
    let resumo!: Awaited<ReturnType<typeof processarEmailsPendentes>>
    await silenciado(async () => {
      resumo = await processarEmailsPendentes(10)
    })
    assert(resumo.falhas === 1 && resumo.ignorados === 0, 'AI) payload com campo malformado ("numero" não-numérico): termina em falhas', resumo)
  }
  assert(eventos.get('evt-AI')?.status === 'FALHA', 'AI) evento termina FALHA', eventos.get('evt-AI')?.status)
  assert(sendEmailCalls.length === 0, 'AI) provider nunca é chamado com payload malformado', sendEmailCalls.length)

  // --- AJ) Payload com versão não suportada → FALHA -------------------------
  resetMocks()
  {
    const payloadVersaoErrada = { ...reservaConfirmadaPayloadFixture({ papel: 'solicitante' }), versao: 2 }
    eventos.set('evt-AJ', eventoFixture('evt-AJ', 'RESERVA_CONFIRMADA', 'sol-AJ', 'solicitante-aj@example.com', undefined, payloadVersaoErrada))
  }
  instalarMockSendEmail((input) => ({ success: true, providerId: `p-${input.to}`, originalRecipient: input.to, physicalRecipient: input.to, isTest: false }))
  {
    let resumo!: Awaited<ReturnType<typeof processarEmailsPendentes>>
    await silenciado(async () => {
      resumo = await processarEmailsPendentes(10)
    })
    assert(resumo.falhas === 1 && resumo.ignorados === 0, 'AJ) payload com versão não suportada: termina em falhas', resumo)
  }
  assert(eventos.get('evt-AJ')?.status === 'FALHA', 'AJ) evento termina FALHA', eventos.get('evt-AJ')?.status)
  assert(sendEmailCalls.length === 0, 'AJ) provider nunca é chamado com versão de payload não suportada', sendEmailCalls.length)

  // Regressão PRONTA_RETIRADA/NAO_RETIRADA continuando a usar aindaValido já
  // coberta acima pelos testes B/C/D (PRONTA_RETIRADA) e E/F (NAO_RETIRADA)
  // — não duplicada aqui.

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) do dispatcher falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes do dispatcher passaram. Nenhum e-mail real foi enviado, nenhum banco real foi acessado.')
}

main().catch((err) => {
  console.error('Falha inesperada ao executar os testes do dispatcher:', err instanceof Error ? err.message : err)
  process.exit(1)
})
