// scripts/test-email-processar-evento.ts
//
// Teste manual (sem framework, mesmo padrão de scripts/test-email-config.ts)
// de src/lib/email/processar-evento.ts — cobre o outbox robusto da Etapa
// D.2 (claim atômico PENDENTE → PROCESSANDO, idempotencyKey por evento +
// GERAÇÃO LÓGICA — Etapa fix/signature-resend, 2ª rodada — e o tratamento
// especial de "provedor confirmou entrega mas a persistência de ENVIADO
// falhou").
//
// Geração lógica (ver idempotencyKeyParaEvento/geracaoIdempotenciaDoPayload
// em processar-evento.ts) é DELIBERADAMENTE diferente de `tentativas`: o
// mock de EventoFake carrega os dois campos separados, e os cenários K.*
// abaixo provam explicitamente que a chave segue a geração (lida do
// `payload`), nunca o contador de tentativas.
//
// Usa mocks em memória para prisma.emailEvento e sendEmail() — não abre
// conexão real com o banco nem envia e-mail real pelo Resend.
//
// Executar com: npm run test:email-processar-evento

import { processarEmailEvento, idempotencyKeyParaEvento, geracaoIdempotenciaDoPayload } from '../src/lib/email/processar-evento'
import type { ResultadoProcessamento } from '../src/lib/email/processar-evento'
import type { SendEmailInput, SendEmailResult } from '../src/lib/email/send-email'

// require() puro (não `import`) de propósito: precisamos mutar as próprias
// propriedades dos objetos de módulo (prisma.emailEvento, sendEmail) para
// que processar-evento.ts — que faz sua própria chamada `require()`
// interna para os mesmos caminhos — enxergue os mocks.
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

// --- Mock de prisma.emailEvento -----------------------------------------

type StatusFake = 'PENDENTE' | 'PROCESSANDO' | 'ENVIADO' | 'FALHA' | 'OBSOLETO'

interface EventoFake {
  id: string
  destinatario: string
  status: StatusFake
  tentativas: number
  erro: string | null
  enviadoEm: Date | null
  /** Geração lógica (ver comentário no topo do arquivo) — sempre `{ geracao: N }` nos testes, exceto onde simulando payload legado. */
  payload: unknown
}

const EVENTO_ID = 'evento-teste-1'
let eventos: Map<string, EventoFake>
let claimCalls: number
let claimShouldThrow: boolean
let enviadoUpdateShouldThrow: boolean
let obsoletoUpdateShouldThrow: boolean

function novoEvento(status: StatusFake): EventoFake {
  return { id: EVENTO_ID, destinatario: 'solicitante@example.com', status, tentativas: 0, erro: null, enviadoEm: null, payload: { geracao: 1 } }
}

function resetMocks(status: StatusFake = 'PENDENTE') {
  eventos = new Map([[EVENTO_ID, novoEvento(status)]])
  claimCalls = 0
  claimShouldThrow = false
  enviadoUpdateShouldThrow = false
  obsoletoUpdateShouldThrow = false
}

function instalarMockPrisma() {
  prisma.emailEvento = {
    // Claim: PENDENTE -> PROCESSANDO (+ tentativas). Síncrono por dentro de
    // propósito (sem await interno) — simula a atomicidade de um UPDATE
    // real: quando duas chamadas a processarEmailEvento() disparam
    // updateMany() "concorrentemente" (Promise.all), a primeira a rodar
    // muta o Map ANTES de devolver o controle (mesmo sendo uma função
    // `async`), então a segunda já enxerga o novo status.
    updateMany: async ({ where, data }: { where: { id: string; status?: StatusFake }; data: Record<string, unknown> }) => {
      claimCalls++
      if (claimShouldThrow) throw new Error('Falha simulada ao reivindicar (banco indisponível).')
      const evento = eventos.get(where.id)
      if (!evento) return { count: 0 }
      if (where.status !== undefined && evento.status !== where.status) return { count: 0 }
      if (typeof data.status === 'string') evento.status = data.status as StatusFake
      const tentativasOp = data.tentativas as { increment?: number } | undefined
      if (tentativasOp?.increment) evento.tentativas += tentativasOp.increment
      return { count: 1 }
    },
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
      const evento = eventos.get(where.id)
      if (!evento) throw new Error(`EmailEvento ${where.id} não encontrado (mock).`)
      return { destinatario: evento.destinatario, payload: evento.payload }
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      if (data.status === 'ENVIADO' && enviadoUpdateShouldThrow) {
        throw new Error('Falha simulada de banco ao persistir ENVIADO (teste F).')
      }
      if (data.status === 'OBSOLETO' && obsoletoUpdateShouldThrow) {
        throw new Error('Falha simulada de banco ao persistir OBSOLETO.')
      }
      const evento = eventos.get(where.id)
      if (!evento) throw new Error(`EmailEvento ${where.id} não encontrado (mock).`)
      if (typeof data.status === 'string') evento.status = data.status as StatusFake
      if ('erro' in data) evento.erro = data.erro as string | null
      if ('enviadoEm' in data) evento.enviadoEm = data.enviadoEm as Date | null
      return { ...evento }
    },
  }
}

// --- Mock de sendEmail ----------------------------------------------------

let sendEmailCalls: SendEmailInput[] = []

function instalarMockSendEmail(resultado: SendEmailResult) {
  sendEmailCalls = []
  sendEmailModule.sendEmail = async (input: SendEmailInput): Promise<SendEmailResult> => {
    sendEmailCalls.push(input)
    return resultado
  }
}

const templateOk = () => ({ subject: 'Assunto de teste', html: '<p>Corpo</p>', text: 'Corpo' })

const originalConsoleError = console.error
function silenciado(fn: () => Promise<void>): Promise<void> {
  console.error = () => {}
  return fn().finally(() => {
    console.error = originalConsoleError
  })
}

async function main() {
  instalarMockPrisma()

  // --- B) Dois claims concorrentes para o MESMO evento → só um envia -----
  resetMocks('PENDENTE')
  instalarMockSendEmail({ success: true, providerId: 'p-1', originalRecipient: 'x', physicalRecipient: 'x', isTest: false })
  const [rB1, rB2] = await Promise.all([
    processarEmailEvento(EVENTO_ID, templateOk),
    processarEmailEvento(EVENTO_ID, templateOk),
  ])
  {
    const resultados = [rB1, rB2].sort()
    assert(sendEmailCalls.length === 1, 'B) sendEmail é chamado exatamente uma vez', sendEmailCalls.length)
    assert(
      JSON.stringify(resultados) === JSON.stringify(['ENVIADO', 'NAO_REIVINDICADO']),
      'B) um resultado é ENVIADO e o outro NAO_REIVINDICADO',
      resultados
    )
    assert(eventos.get(EVENTO_ID)?.tentativas === 1, 'B) tentativas incrementa só uma vez (só o claim vencedor)', eventos.get(EVENTO_ID)?.tentativas)
    assert(eventos.get(EVENTO_ID)?.status === 'ENVIADO', 'B) estado final é ENVIADO')
    assert(claimCalls === 2, 'B) ambas as chamadas tentaram reivindicar (só uma ganhou)', claimCalls)
  }

  // --- C) Falha na construção do template → FALHA -------------------------
  resetMocks('PENDENTE')
  instalarMockSendEmail({ success: true, providerId: 'p', originalRecipient: 'x', physicalRecipient: 'x', isTest: false })
  await silenciado(async () => {
    const r = await processarEmailEvento(EVENTO_ID, () => {
      throw new Error('APP_URL inválido: simulando falha de configuração.')
    })
    assert(r === 'FALHA', 'C) resultado é FALHA', r)
  })
  {
    const evento = eventos.get(EVENTO_ID)!
    assert(evento.status === 'FALHA', 'C) status final é FALHA', evento.status)
    assert(evento.tentativas === 1, 'C) tentativas incrementada em 1 (via claim)', evento.tentativas)
    assert(evento.enviadoEm === null, 'C) enviadoEm continua null', evento.enviadoEm)
    assert(typeof evento.erro === 'string' && evento.erro.includes('APP_URL'), 'C) erro sanitizado é persistido', evento.erro)
    assert(sendEmailCalls.length === 0, 'C) sendEmail nunca chega a ser chamado', sendEmailCalls.length)
  }

  // --- D) Falha do provider → FALHA ----------------------------------------
  resetMocks('PENDENTE')
  instalarMockSendEmail({
    success: false,
    originalRecipient: 'x',
    physicalRecipient: 'x',
    isTest: false,
    error: 'Erro sanitizado do provedor (simulado).',
  })
  await silenciado(async () => {
    const r = await processarEmailEvento(EVENTO_ID, templateOk)
    assert(r === 'FALHA', 'D) resultado é FALHA', r)
  })
  {
    const evento = eventos.get(EVENTO_ID)!
    assert(evento.status === 'FALHA', 'D) status final é FALHA', evento.status)
    assert(evento.tentativas === 1, 'D) tentativas incrementada em 1', evento.tentativas)
    assert(evento.erro === 'Erro sanitizado do provedor (simulado).', 'D) erro do provedor é persistido', evento.erro)
  }

  // --- E) Provider sucesso + update sucesso → ENVIADO ----------------------
  resetMocks('PENDENTE')
  instalarMockSendEmail({ success: true, providerId: 'p-2', originalRecipient: 'x', physicalRecipient: 'x', isTest: false })
  {
    const r = await processarEmailEvento(EVENTO_ID, templateOk)
    assert(r === 'ENVIADO', 'E) resultado é ENVIADO', r)
    const evento = eventos.get(EVENTO_ID)!
    assert(evento.status === 'ENVIADO', 'E) status final é ENVIADO')
    assert(evento.tentativas === 1, 'E) tentativas incrementada em 1 (só no claim)', evento.tentativas)
    assert(evento.enviadoEm instanceof Date, 'E) enviadoEm é preenchido', evento.enviadoEm)
    assert(evento.erro === null, 'E) erro é limpo (null)', evento.erro)
  }

  // --- F) Provider sucesso + update ENVIADO falha → permanece PROCESSANDO --
  resetMocks('PENDENTE')
  enviadoUpdateShouldThrow = true
  instalarMockSendEmail({ success: true, providerId: 'p-3', originalRecipient: 'x', physicalRecipient: 'x', isTest: false })
  await silenciado(async () => {
    const r = await processarEmailEvento(EVENTO_ID, templateOk)
    assert(r === 'PERSISTENCIA_FALHOU', 'F) resultado é PERSISTENCIA_FALHOU', r)
  })
  {
    const evento = eventos.get(EVENTO_ID)!
    assert(evento.status === 'PROCESSANDO', 'F) evento permanece PROCESSANDO (nunca FALHA, nunca volta a PENDENTE)', evento.status)
    assert(evento.tentativas === 1, 'F) tentativas continua em 1 (não incrementa de novo)', evento.tentativas)
    assert(sendEmailCalls.length === 1, 'F) sendEmail foi chamado só uma vez (não houve reenvio)', sendEmailCalls.length)
  }

  // --- G) Evento ENVIADO → nunca processado de novo -------------------------
  resetMocks('ENVIADO')
  instalarMockSendEmail({ success: true, providerId: 'p-4', originalRecipient: 'x', physicalRecipient: 'x', isTest: false })
  {
    const r = await processarEmailEvento(EVENTO_ID, templateOk)
    assert(r === 'NAO_REIVINDICADO', 'G) resultado é NAO_REIVINDICADO para evento já ENVIADO', r)
    assert(sendEmailCalls.length === 0, 'G) sendEmail nunca é chamado', sendEmailCalls.length)
  }

  // --- H) Evento PROCESSANDO → nunca processado automaticamente ------------
  resetMocks('PROCESSANDO')
  instalarMockSendEmail({ success: true, providerId: 'p-5', originalRecipient: 'x', physicalRecipient: 'x', isTest: false })
  {
    const r = await processarEmailEvento(EVENTO_ID, templateOk)
    assert(r === 'NAO_REIVINDICADO', 'H) resultado é NAO_REIVINDICADO para evento já PROCESSANDO', r)
    assert(sendEmailCalls.length === 0, 'H) sendEmail nunca é chamado', sendEmailCalls.length)
  }

  // --- I) Evento FALHA → não reprocessado automaticamente nesta fase -------
  resetMocks('FALHA')
  instalarMockSendEmail({ success: true, providerId: 'p-6', originalRecipient: 'x', physicalRecipient: 'x', isTest: false })
  {
    const r = await processarEmailEvento(EVENTO_ID, templateOk)
    assert(r === 'NAO_REIVINDICADO', 'I) resultado é NAO_REIVINDICADO para evento já FALHA', r)
    assert(sendEmailCalls.length === 0, 'I) sendEmail nunca é chamado', sendEmailCalls.length)
  }

  // --- K) idempotencyKey por GERAÇÃO LÓGICA (Etapa fix/signature-resend, 2ª rodada) ---
  // A geração vem do `payload` do evento (ver geracaoIdempotenciaDoPayload)
  // — NUNCA de `tentativas`. Os cenários abaixo simulam exatamente o que
  // assinatura/route.ts faz de verdade: reabrir de FALHA/OBSOLETO preserva
  // `payload.geracao`; reabrir de ENVIADO incrementa.

  // K.A) geração 1 — primeiro envio.
  resetMocks('PENDENTE')
  eventos.get(EVENTO_ID)!.payload = { geracao: 1 }
  instalarMockSendEmail({ success: true, providerId: 'p-7', originalRecipient: 'x', physicalRecipient: 'x', isTest: false })
  await processarEmailEvento(EVENTO_ID, templateOk)
  let chaveGeracao1a: string | undefined
  {
    chaveGeracao1a = sendEmailCalls[0]?.idempotencyKey
    assert(typeof chaveGeracao1a === 'string' && chaveGeracao1a.includes(EVENTO_ID), 'K.A) idempotencyKey contém o eventoId', chaveGeracao1a)
    assert(!!chaveGeracao1a?.endsWith('-geracao-1'), 'K.A) idempotencyKey termina em "-geracao-1" (geração 1, primeiro envio)', chaveGeracao1a)
    assert(chaveGeracao1a === idempotencyKeyParaEvento(EVENTO_ID, 1), 'K.A) chave bate com idempotencyKeyParaEvento(id, 1)', chaveGeracao1a)
    assert(eventos.get(EVENTO_ID)!.tentativas === 1, 'K.A) tentativas (contador técnico, separado) incrementa para 1', eventos.get(EVENTO_ID)!.tentativas)
  }

  // K.B) retry TÉCNICO da MESMA geração — o evento volta de FALHA para
  // PENDENTE preservando `payload.geracao` (exatamente o que o Gate 2 de
  // assinatura/route.ts faz ao reabrir de FALHA/OBSOLETO: resultado
  // ambíguo do provedor, nunca confirmado — a chave TEM que continuar
  // igual). `tentativas` incrementa mesmo assim (contador técnico,
  // independente da geração).
  {
    const evento = eventos.get(EVENTO_ID)!
    evento.status = 'PENDENTE'
    evento.erro = null
    // payload preservado — ainda { geracao: 1 }.
  }
  instalarMockSendEmail({ success: true, providerId: 'p-8', originalRecipient: 'x', physicalRecipient: 'x', isTest: false })
  await processarEmailEvento(EVENTO_ID, templateOk)
  {
    const chaveGeracao1b = sendEmailCalls[0]?.idempotencyKey
    assert(chaveGeracao1b === chaveGeracao1a, 'K.B) retry técnico da MESMA geração usa EXATAMENTE A MESMA idempotencyKey — protege contra FALHA ambígua do provedor', [chaveGeracao1a, chaveGeracao1b])
    assert(eventos.get(EVENTO_ID)!.tentativas === 2, 'K.B) tentativas incrementa para 2 mesmo com a geração preservada — são contadores independentes', eventos.get(EVENTO_ID)!.tentativas)
  }

  // K.C) reenvio EXPLÍCITO de um evento ENVIADO — geração 2 → chave
  // diferente (simula o Gate 2 reabrindo de ENVIADO, que incrementa
  // `payload.geracao`).
  {
    const evento = eventos.get(EVENTO_ID)!
    evento.status = 'PENDENTE'
    evento.erro = null
    evento.payload = { geracao: 2 }
  }
  instalarMockSendEmail({ success: true, providerId: 'p-9', originalRecipient: 'x', physicalRecipient: 'x', isTest: false })
  await processarEmailEvento(EVENTO_ID, templateOk)
  let chaveGeracao2a: string | undefined
  {
    chaveGeracao2a = sendEmailCalls[0]?.idempotencyKey
    assert(!!chaveGeracao2a?.endsWith('-geracao-2'), 'K.C) idempotencyKey da geração 2 termina em "-geracao-2"', chaveGeracao2a)
    assert(chaveGeracao2a === idempotencyKeyParaEvento(EVENTO_ID, 2), 'K.C) chave bate com idempotencyKeyParaEvento(id, 2)', chaveGeracao2a)
    assert(chaveGeracao2a !== chaveGeracao1a, 'K.C) chave da geração 2 é DIFERENTE da geração 1 — reenvio de ENVIADO não depende de dedup do provedor', [chaveGeracao1a, chaveGeracao2a])
  }

  // K.D) retry técnico DENTRO da geração 2 → mesma chave da geração 2 — a
  // solução funciona em qualquer geração, não só na primeira.
  {
    const evento = eventos.get(EVENTO_ID)!
    evento.status = 'PENDENTE'
    evento.erro = null
    // payload preservado — ainda { geracao: 2 }.
  }
  instalarMockSendEmail({ success: true, providerId: 'p-10', originalRecipient: 'x', physicalRecipient: 'x', isTest: false })
  await processarEmailEvento(EVENTO_ID, templateOk)
  {
    const chaveGeracao2b = sendEmailCalls[0]?.idempotencyKey
    assert(chaveGeracao2b === chaveGeracao2a, 'K.D) retry técnico dentro da geração 2 usa a MESMA chave da geração 2', [chaveGeracao2a, chaveGeracao2b])
  }

  // K.E) novo reenvio explícito depois da geração 2 ter sido ENVIADA →
  // geração 3, nova chave.
  {
    const evento = eventos.get(EVENTO_ID)!
    evento.status = 'PENDENTE'
    evento.erro = null
    evento.payload = { geracao: 3 }
  }
  instalarMockSendEmail({ success: true, providerId: 'p-11', originalRecipient: 'x', physicalRecipient: 'x', isTest: false })
  await processarEmailEvento(EVENTO_ID, templateOk)
  {
    const chaveGeracao3 = sendEmailCalls[0]?.idempotencyKey
    assert(!!chaveGeracao3?.endsWith('-geracao-3'), 'K.E) idempotencyKey da geração 3 termina em "-geracao-3"', chaveGeracao3)
    assert(
      chaveGeracao3 !== chaveGeracao1a && chaveGeracao3 !== chaveGeracao2a,
      'K.E) chave da geração 3 é diferente das gerações 1 e 2 — e assim sucessivamente',
      { chaveGeracao1a, chaveGeracao2a, chaveGeracao3 }
    )
  }

  // K.F/K.G) claim concorrente continua exclusivo, e o perdedor nunca chama
  // o provider — já comprovado pelo cenário B) acima ("Dois claims
  // concorrentes para o MESMO evento → só um envia"), que continua válido
  // sem nenhuma mudança: a exclusividade do claim (PENDENTE → PROCESSANDO)
  // é INDEPENDENTE de qual geração está em jogo — o claim nem lê `payload`
  // antes de reivindicar.

  // K.H) payload legado (evento anterior a esta etapa, sem `geracao` no
  // JSON) continua processável — cai no fallback (1), não quebra.
  {
    const idLegado = 'evento-legado-sem-geracao'
    eventos.set(idLegado, {
      id: idLegado,
      destinatario: 'legado@example.com',
      status: 'PENDENTE',
      tentativas: 0,
      erro: null,
      enviadoEm: null,
      payload: { numero: 42 }, // payload real de um tipo qualquer, sem `geracao`
    })
    instalarMockSendEmail({ success: true, providerId: 'p-12', originalRecipient: 'x', physicalRecipient: 'x', isTest: false })
    const r = await processarEmailEvento(idLegado, templateOk)
    assert(r === 'ENVIADO', 'K.H) payload legado sem `geracao` continua processável (ENVIADO)', r)
    const chaveLegado = sendEmailCalls[0]?.idempotencyKey
    assert(chaveLegado === idempotencyKeyParaEvento(idLegado, 1), 'K.H) payload legado sem `geracao` usa o fallback (geração 1)', chaveLegado)
  }

  // K.I) idempotencyKeyParaEvento é pura: mesma geração sempre produz a
  // mesma chave (proteção original da Etapa D.2 contra reprocessamento do
  // MESMO claim continua de pé).
  {
    const chaveDireta1 = idempotencyKeyParaEvento(EVENTO_ID, 2)
    const chaveDireta2 = idempotencyKeyParaEvento(EVENTO_ID, 2)
    assert(chaveDireta1 === chaveDireta2, 'K.I) mesma geração sempre produz a mesma chave (função pura)', [chaveDireta1, chaveDireta2])
  }

  // K.J) geracaoIdempotenciaDoPayload é tolerante (nunca lança) e tem o
  // fallback correto (1) para todo formato inesperado — usada como está
  // pelo claim, então precisa ser robusta contra QUALQUER payload real.
  {
    assert(geracaoIdempotenciaDoPayload(undefined) === 1, 'K.J) payload undefined → fallback 1', geracaoIdempotenciaDoPayload(undefined))
    assert(geracaoIdempotenciaDoPayload(null) === 1, 'K.J) payload null → fallback 1', geracaoIdempotenciaDoPayload(null))
    assert(geracaoIdempotenciaDoPayload({}) === 1, 'K.J) payload sem geracao → fallback 1', geracaoIdempotenciaDoPayload({}))
    assert(geracaoIdempotenciaDoPayload({ geracao: 0 }) === 1, 'K.J) geracao=0 (fora do domínio) → fallback 1', geracaoIdempotenciaDoPayload({ geracao: 0 }))
    assert(geracaoIdempotenciaDoPayload({ geracao: -3 }) === 1, 'K.J) geracao negativa → fallback 1', geracaoIdempotenciaDoPayload({ geracao: -3 }))
    assert(geracaoIdempotenciaDoPayload({ geracao: 1.5 }) === 1, 'K.J) geracao não-inteira → fallback 1', geracaoIdempotenciaDoPayload({ geracao: 1.5 }))
    assert(geracaoIdempotenciaDoPayload({ geracao: 'x' }) === 1, 'K.J) geracao como string → fallback 1', geracaoIdempotenciaDoPayload({ geracao: 'x' }))
    assert(geracaoIdempotenciaDoPayload({ geracao: 5 }) === 5, 'K.J) geracao numérica válida é usada como está', geracaoIdempotenciaDoPayload({ geracao: 5 }))
    assert(geracaoIdempotenciaDoPayload('string qualquer') === 1, 'K.J) payload não-objeto (string) → fallback 1', geracaoIdempotenciaDoPayload('string qualquer'))
  }

  // --- L) aindaValido retorna false → OBSOLETO, nada é montado/enviado -----
  // (hook genérico; a semântica "solicitação avançou de status" é testada
  // com dados reais em scripts/test-email-dispatcher.ts, cenários A-H)
  resetMocks('PENDENTE')
  instalarMockSendEmail({ success: true, providerId: 'p-9', originalRecipient: 'x', physicalRecipient: 'x', isTest: false })
  let templateChamado = false
  await silenciado(async () => {
    const r = await processarEmailEvento(
      EVENTO_ID,
      () => {
        templateChamado = true
        return templateOk()
      },
      { aindaValido: async () => false }
    )
    assert(r === 'OBSOLETO', 'L) resultado é OBSOLETO', r)
  })
  {
    const evento = eventos.get(EVENTO_ID)!
    assert(evento.status === 'OBSOLETO', 'L) evento é persistido como OBSOLETO (não FALHA, não volta a PENDENTE)', evento.status)
    assert(evento.erro === null, 'L) erro é null (não houve falha técnica)', evento.erro)
    assert(evento.enviadoEm === null, 'L) enviadoEm é null', evento.enviadoEm)
    assert(evento.tentativas === 1, 'L) tentativas incrementada em 1 (via claim, antes da checagem) — não incrementa de novo', evento.tentativas)
    assert(templateChamado === false, 'L) build nunca é chamado quando obsoleto', templateChamado)
    assert(sendEmailCalls.length === 0, 'L) sendEmail (e portanto o provedor/idempotencyKey) nunca é chamado quando obsoleto', sendEmailCalls.length)
  }

  // --- M) aindaValido lança → tratado como falha técnica (mesmo caminho de build) ---
  resetMocks('PENDENTE')
  instalarMockSendEmail({ success: true, providerId: 'p-10', originalRecipient: 'x', physicalRecipient: 'x', isTest: false })
  await silenciado(async () => {
    const r = await processarEmailEvento(EVENTO_ID, templateOk, {
      aindaValido: async () => {
        throw new Error('Falha simulada ao consultar status atual da solicitação.')
      },
    })
    assert(r === 'FALHA', 'M) erro em aindaValido resulta em FALHA (não em exceção não tratada)', r)
  })
  {
    const evento = eventos.get(EVENTO_ID)!
    assert(evento.status === 'FALHA', 'M) status final é FALHA', evento.status)
    assert(sendEmailCalls.length === 0, 'M) sendEmail nunca é chamado', sendEmailCalls.length)
  }

  // --- N) Falha ao persistir OBSOLETO → evento permanece PROCESSANDO -------
  resetMocks('PENDENTE')
  obsoletoUpdateShouldThrow = true
  instalarMockSendEmail({ success: true, providerId: 'p-11', originalRecipient: 'x', physicalRecipient: 'x', isTest: false })
  await silenciado(async () => {
    const r = await processarEmailEvento(EVENTO_ID, templateOk, { aindaValido: async () => false })
    assert(r === 'OBSOLETO', 'N) resultado ainda reporta OBSOLETO mesmo com falha de persistência', r)
  })
  {
    const evento = eventos.get(EVENTO_ID)!
    assert(evento.status === 'PROCESSANDO', 'N) evento fica PROCESSANDO quando a persistência de OBSOLETO falha (não vira FALHA)', evento.status)
    assert(sendEmailCalls.length === 0, 'N) sendEmail nunca é chamado', sendEmailCalls.length)
  }

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) de processar-evento falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes de processarEmailEvento passaram. Nenhum e-mail real foi enviado, nenhum banco real foi acessado.')
}

main().catch((err) => {
  console.error('Falha inesperada ao executar os testes de processar-evento:', err instanceof Error ? err.message : err)
  process.exit(1)
})
