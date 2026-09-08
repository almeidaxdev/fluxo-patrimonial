// scripts/test-validade-evento.ts
//
// Teste manual (mesmo padrão de scripts/test-email-config.ts) da correção
// arquitetural da Etapa D.3.1: desacoplar "tipo suportado pelo dispatcher"
// (TIPOS_EMAIL_SUPORTADOS) de "tipo com regra de validade baseada em
// status atual" (STATUS_ESPERADO_POR_TIPO/criarValidadorDeEvento) em
// src/lib/email/validade-evento.ts.
//
// PRONTA_RETIRADA e NAO_RETIRADA continuam com comportamento idêntico ao
// de antes (suportados + com validador). O cenário E prova que
// criarValidadorDeEvento() já responde `undefined` (não "tipo não
// suportado") para um tipo sem entrada em STATUS_ESPERADO_POR_TIPO — usa
// um valor SINTÉTICO (`'TIPO_INEXISTENTE_TESTE' as unknown as TipoEmailEvento`,
// nunca existirá no enum real). Etapa email-aguardando-patrimonio: com
// SOLICITACAO_AGUARDANDO_PATRIMONIO ganhando suporte nesta etapa, TODOS os
// valores reais do enum passam a estar em TIPOS_EMAIL_SUPORTADOS — não
// sobra nenhum valor real para servir de exemplo "genuinamente não
// suportado" (mesma classe de ajuste já feita 3x antes: ASSINATURA_PENDENTE,
// depois REJEICAO_*, depois CANCELAMENTO — cada um "expirou" esse papel
// quando ganhou suporte). O valor sintético é mais robusto a longo prazo:
// não expira quando um novo tipo real ganhar suporte, e também simula um
// cenário real possível (uma linha existente no banco com um valor de
// enum adicionado ao schema antes do código da aplicação ser atualizado
// para reconhecê-lo). O cenário F prova o caso complementar,
// real desde a Etapa D.3.6: RESERVA_CONFIRMADA É suportado pelo
// dispatcher, mas DELIBERADAMENTE sem entrada em STATUS_ESPERADO_POR_TIPO
// — "suportado" e "tem regra de validade" continuam perguntas
// independentes mesmo quando ambas são verdade/falsa ao mesmo tempo para
// tipos diferentes.
//
// Usa mocks em memória para prisma.emailEvento/prisma.solicitacao e
// sendEmail() — não abre conexão real com o banco nem envia e-mail real.
//
// Executar com: npm run test:validade-evento

import { criarValidadorDeEvento, statusEsperadoParaTipo, TIPOS_EMAIL_SUPORTADOS } from '../src/lib/email/validade-evento'
import { processarEmailEvento } from '../src/lib/email/processar-evento'
import type { SendEmailInput, SendEmailResult } from '../src/lib/email/send-email'
import type { TipoEmailEvento } from '@prisma/client'

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

const SOL_ID = 'sol-validade-1'

async function main() {
  // --- A/B) PRONTA_RETIRADA e NAO_RETIRADA continuam suportados ------------
  assert(TIPOS_EMAIL_SUPORTADOS.includes('PRONTA_RETIRADA'), 'A) PRONTA_RETIRADA continua em TIPOS_EMAIL_SUPORTADOS')
  assert(TIPOS_EMAIL_SUPORTADOS.includes('NAO_RETIRADA'), 'B) NAO_RETIRADA continua em TIPOS_EMAIL_SUPORTADOS')

  // --- C/D) PRONTA_RETIRADA e NAO_RETIRADA continuam recebendo validador ---
  assert(statusEsperadoParaTipo('PRONTA_RETIRADA') === 'PRONTA_RETIRADA', 'C) statusEsperadoParaTipo(PRONTA_RETIRADA) inalterado')
  assert(
    typeof criarValidadorDeEvento('PRONTA_RETIRADA', SOL_ID) === 'function',
    'C) criarValidadorDeEvento(PRONTA_RETIRADA, ...) continua retornando uma função'
  )
  assert(statusEsperadoParaTipo('NAO_RETIRADA') === 'NAO_RETIRADA', 'D) statusEsperadoParaTipo(NAO_RETIRADA) inalterado')
  assert(
    typeof criarValidadorDeEvento('NAO_RETIRADA', SOL_ID) === 'function',
    'D) criarValidadorDeEvento(NAO_RETIRADA, ...) continua retornando uma função'
  )

  // --- E) Tipo sem entrada em STATUS_ESPERADO_POR_TIPO → undefined, não erro ---
  // Etapa email-aguardando-patrimonio: SOLICITACAO_AGUARDANDO_PATRIMONIO
  // (usado aqui até esta etapa) ganhou suporte E entrada em
  // STATUS_ESPERADO_POR_TIPO nesta mesma etapa — não serve mais como
  // exemplo de "tipo sem regra de validade, fora de TIPOS_EMAIL_SUPORTADOS".
  // TODOS os valores reais do enum já têm suporte no dispatcher agora, então
  // usa-se um valor SINTÉTICO (nunca existirá no enum real) — mais robusto
  // a longo prazo, já que não expira quando um novo tipo real ganhar
  // suporte (ver comentário no topo do arquivo).
  const TIPO_SINTETICO_SEM_SUPORTE = 'TIPO_INEXISTENTE_TESTE' as unknown as TipoEmailEvento
  assert(statusEsperadoParaTipo(TIPO_SINTETICO_SEM_SUPORTE) === null, 'E) statusEsperadoParaTipo(tipo sintético) é null (sem regra)')
  assert(
    criarValidadorDeEvento(TIPO_SINTETICO_SEM_SUPORTE, SOL_ID) === undefined,
    'E) criarValidadorDeEvento(tipo sintético, ...) retorna undefined — não é tratado como erro nem como "tipo não suportado"'
  )
  assert(!TIPOS_EMAIL_SUPORTADOS.includes(TIPO_SINTETICO_SEM_SUPORTE), 'E) tipo sintético está FORA de TIPOS_EMAIL_SUPORTADOS (produção)')

  // --- F) RESERVA_CONFIRMADA (Etapa D.3.6): suportado, mas sem regra de validade ---
  assert(TIPOS_EMAIL_SUPORTADOS.includes('RESERVA_CONFIRMADA'), 'F) RESERVA_CONFIRMADA está em TIPOS_EMAIL_SUPORTADOS (Etapa D.3.6)')
  assert(statusEsperadoParaTipo('RESERVA_CONFIRMADA') === null, 'F) statusEsperadoParaTipo(RESERVA_CONFIRMADA) é null (sem regra)')
  assert(
    criarValidadorDeEvento('RESERVA_CONFIRMADA', SOL_ID) === undefined,
    'F) criarValidadorDeEvento(RESERVA_CONFIRMADA, ...) retorna undefined — suportado, mas sem checagem de obsolescência'
  )

  // --- H) processarEmailEvento com aindaValido=undefined processa sem gate -
  // Prova, de ponta a ponta, que um tipo "suportado sem validador" (como
  // RESERVA_CONFIRMADA, desde a Etapa D.3.6) pode ser processado por
  // processarEmailEvento() exatamente como um evento sem nenhuma opção de
  // validade — sem qualquer checagem de status/obsolescência.
  {
    const eventoId = 'evento-sem-validador-1'
    let evento = { id: eventoId, destinatario: 'solicitante@example.com', status: 'PENDENTE', tentativas: 0, erro: null as string | null, enviadoEm: null as Date | null }

    prisma.emailEvento = {
      updateMany: async ({ where, data }: { where: { id: string; status?: string }; data: Record<string, unknown> }) => {
        if (where.id !== evento.id) return { count: 0 }
        if (where.status !== undefined && evento.status !== where.status) return { count: 0 }
        if (typeof data.status === 'string') evento.status = data.status as string
        const tentativasOp = data.tentativas as { increment?: number } | undefined
        if (tentativasOp?.increment) evento.tentativas += tentativasOp.increment
        return { count: 1 }
      },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        if (where.id !== evento.id) throw new Error('EmailEvento não encontrado (mock).')
        return { destinatario: evento.destinatario }
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        if (where.id !== evento.id) throw new Error('EmailEvento não encontrado (mock).')
        if (typeof data.status === 'string') evento.status = data.status as string
        if ('erro' in data) evento.erro = data.erro as string | null
        if ('enviadoEm' in data) evento.enviadoEm = data.enviadoEm as Date | null
        return { ...evento }
      },
    }

    const sendEmailCalls: SendEmailInput[] = []
    sendEmailModule.sendEmail = async (input: SendEmailInput): Promise<SendEmailResult> => {
      sendEmailCalls.push(input)
      return { success: true, providerId: 'p-H', originalRecipient: input.to, physicalRecipient: input.to, isTest: false }
    }

    const aindaValido = criarValidadorDeEvento('RESERVA_CONFIRMADA', SOL_ID) // undefined
    const resultado = await processarEmailEvento(
      eventoId,
      () => ({ subject: 'Assunto de teste', html: '<p>Corpo</p>', text: 'Corpo' }),
      { aindaValido }
    )

    assert(resultado === 'ENVIADO', 'H) resultado é ENVIADO mesmo sem regra de validade (aindaValido undefined)', resultado)
    assert(evento.status === 'ENVIADO', 'H) evento é persistido como ENVIADO, sem checagem de status', evento.status)
    assert(sendEmailCalls.length === 1, 'H) sendEmail é chamado normalmente', sendEmailCalls.length)
  }

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) de validade-evento (desacoplamento D.3.1) falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes de validade-evento (desacoplamento D.3.1) passaram. Nenhum e-mail real foi enviado, nenhum banco real foi acessado.')
}

main().catch((err) => {
  console.error('Falha inesperada ao executar os testes de validade-evento:', err instanceof Error ? err.message : err)
  process.exit(1)
})
