// scripts/test-email-validade-evento.ts
//
// Teste manual (mesmo padrão de scripts/test-email-config.ts) da correção
// final pós-Codex-Review (Etapa D.2): o caminho INLINE das rotas de
// separação/não-retirada — não só o dispatcher — precisa revalidar o
// status atual da Solicitação antes de enviar, para não entregar um
// e-mail "pronta para retirada" (ou "não retirada") já desatualizado se
// outra requisição concorrente mudar o status entre o COMMIT da transação
// e o envio.
//
// Este teste exercita exatamente a combinação usada pelas rotas:
// processarEmailEvento(id, build, { aindaValido: criarValidadorDeEvento(tipo, solicitacaoId) })
// — a MESMA função `criarValidadorDeEvento` que o dispatcher usa (ver
// scripts/test-email-dispatcher.ts), provando que os dois caminhos
// compartilham a mesma fonte de verdade, sem lógica duplicada.
//
// Usa mocks em memória para prisma.emailEvento, prisma.solicitacao e
// sendEmail() — não abre conexão real com o banco nem envia e-mail real
// pelo Resend.
//
// Executar com: npm run test:email-validade-evento

import { processarEmailEvento } from '../src/lib/email/processar-evento'
import { criarValidadorDeEvento } from '../src/lib/email/validade-evento'
import { renderProntaRetiradaEmail } from '../src/lib/email/templates/pronta-retirada'
import type { SendEmailInput, SendEmailResult } from '../src/lib/email/send-email'

// Etapa email-gestor-pendente (itens H/I do pedido): SOLICITACAO_AGUARDANDO_GESTOR
// usa a MESMA infraestrutura de validade testada acima para PRONTA_RETIRADA/
// NAO_RETIRADA — nenhuma lógica nova, só uma nova entrada em
// STATUS_ESPERADO_POR_TIPO (ver validade-evento.ts). Os cenários abaixo
// reutilizam processarComoRota()/resetMocks(), só trocando o `tipo`.

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

// --- Mocks -------------------------------------------------------------

type StatusEventoFake = 'PENDENTE' | 'PROCESSANDO' | 'ENVIADO' | 'FALHA' | 'OBSOLETO'

const EVENTO_ID = 'evento-inline-1'
const SOLICITACAO_ID = 'sol-inline-1'

interface EventoFake {
  id: string
  destinatario: string
  status: StatusEventoFake
  tentativas: number
  erro: string | null
  enviadoEm: Date | null
}

let evento: EventoFake
let statusSolicitacaoAtual: string | null

function resetMocks() {
  evento = { id: EVENTO_ID, destinatario: 'solicitante@example.com', status: 'PENDENTE', tentativas: 0, erro: null, enviadoEm: null }
  statusSolicitacaoAtual = 'PRONTA_RETIRADA'
}

function instalarMockPrisma() {
  prisma.emailEvento = {
    updateMany: async ({ where, data }: { where: { id: string; status?: StatusEventoFake }; data: Record<string, unknown> }) => {
      if (where.id !== evento.id) return { count: 0 }
      if (where.status !== undefined && evento.status !== where.status) return { count: 0 }
      if (typeof data.status === 'string') evento.status = data.status as StatusEventoFake
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
      if (typeof data.status === 'string') evento.status = data.status as StatusEventoFake
      if ('erro' in data) evento.erro = data.erro as string | null
      if ('enviadoEm' in data) evento.enviadoEm = data.enviadoEm as Date | null
      return { ...evento }
    },
  }

  prisma.solicitacao = {
    // Releitura enxuta feita por criarValidadorDeEvento() — reflete o
    // status ATUAL no momento da chamada, simulando uma transição
    // concorrente (/retirada, /cancelar, /nao-retirada) que já mudou o
    // status entre o commit da rota original e este ponto.
    findUnique: async ({ where }: { where: { id: string } }) => {
      if (where.id !== SOLICITACAO_ID) return null
      return { status: statusSolicitacaoAtual }
    },
  }
}

let sendEmailCalls: SendEmailInput[] = []

function instalarMockSendEmail(resultado: SendEmailResult) {
  sendEmailCalls = []
  sendEmailModule.sendEmail = async (input: SendEmailInput): Promise<SendEmailResult> => {
    sendEmailCalls.push(input)
    return resultado
  }
}

const templateOk = () => ({ subject: 'Assunto de teste', html: '<p>Corpo</p>', text: 'Corpo' })

async function processarComoRota(tipo: 'PRONTA_RETIRADA' | 'NAO_RETIRADA' | 'SOLICITACAO_AGUARDANDO_GESTOR' | 'ASSINATURA_PENDENTE' | 'SOLICITACAO_AGUARDANDO_PATRIMONIO') {
  const aindaValido = criarValidadorDeEvento(tipo, SOLICITACAO_ID)
  return processarEmailEvento(EVENTO_ID, templateOk, { aindaValido: aindaValido ?? undefined })
}

async function main() {
  instalarMockPrisma()

  // --- A) PRONTA_RETIRADA: status mudou para EM_UTILIZACAO → OBSOLETO ------
  resetMocks()
  statusSolicitacaoAtual = 'EM_UTILIZACAO'
  instalarMockSendEmail({ success: true, providerId: 'p-A', originalRecipient: 'x', physicalRecipient: 'x', isTest: false })
  {
    const r = await processarComoRota('PRONTA_RETIRADA')
    assert(r === 'OBSOLETO', 'A) resultado é OBSOLETO quando o status virou EM_UTILIZACAO', r)
    assert(evento.status === 'OBSOLETO', 'A) evento é persistido como OBSOLETO', evento.status)
    assert(sendEmailCalls.length === 0, 'A) sendEmail (provider) nunca é chamado', sendEmailCalls.length)
  }

  // --- B) PRONTA_RETIRADA: status mudou para CANCELADA → OBSOLETO ----------
  resetMocks()
  statusSolicitacaoAtual = 'CANCELADA'
  instalarMockSendEmail({ success: true, providerId: 'p-B', originalRecipient: 'x', physicalRecipient: 'x', isTest: false })
  {
    const r = await processarComoRota('PRONTA_RETIRADA')
    assert(r === 'OBSOLETO', 'B) resultado é OBSOLETO quando o status virou CANCELADA', r)
    assert(evento.status === 'OBSOLETO', 'B) evento é persistido como OBSOLETO', evento.status)
    assert(sendEmailCalls.length === 0, 'B) sendEmail (provider) nunca é chamado', sendEmailCalls.length)
  }

  // --- C) PRONTA_RETIRADA: status mudou para NAO_RETIRADA → OBSOLETO -------
  resetMocks()
  statusSolicitacaoAtual = 'NAO_RETIRADA'
  instalarMockSendEmail({ success: true, providerId: 'p-C', originalRecipient: 'x', physicalRecipient: 'x', isTest: false })
  {
    const r = await processarComoRota('PRONTA_RETIRADA')
    assert(r === 'OBSOLETO', 'C) resultado é OBSOLETO quando o status virou NAO_RETIRADA', r)
    assert(evento.status === 'OBSOLETO', 'C) evento é persistido como OBSOLETO', evento.status)
    assert(sendEmailCalls.length === 0, 'C) sendEmail (provider) nunca é chamado', sendEmailCalls.length)
  }

  // --- D) PRONTA_RETIRADA: status continua PRONTA_RETIRADA → envia ---------
  resetMocks()
  statusSolicitacaoAtual = 'PRONTA_RETIRADA'
  instalarMockSendEmail({ success: true, providerId: 'p-D', originalRecipient: 'x', physicalRecipient: 'x', isTest: false })
  {
    const r = await processarComoRota('PRONTA_RETIRADA')
    assert(r === 'ENVIADO', 'D) resultado é ENVIADO quando o status continua PRONTA_RETIRADA', r)
    assert(evento.status === 'ENVIADO', 'D) evento é persistido como ENVIADO', evento.status)
    assert(sendEmailCalls.length === 1, 'D) sendEmail é chamado normalmente', sendEmailCalls.length)
  }

  // --- E) NAO_RETIRADA: status atual NAO_RETIRADA → envia ------------------
  resetMocks()
  statusSolicitacaoAtual = 'NAO_RETIRADA'
  instalarMockSendEmail({ success: true, providerId: 'p-E', originalRecipient: 'x', physicalRecipient: 'x', isTest: false })
  {
    const r = await processarComoRota('NAO_RETIRADA')
    assert(r === 'ENVIADO', 'E) resultado é ENVIADO quando o status continua NAO_RETIRADA', r)
    assert(sendEmailCalls.length === 1, 'E) sendEmail é chamado normalmente', sendEmailCalls.length)
  }

  // --- F) NAO_RETIRADA: status incompatível → OBSOLETO, provider não chamado ---
  resetMocks()
  statusSolicitacaoAtual = 'EM_UTILIZACAO'
  instalarMockSendEmail({ success: true, providerId: 'p-F', originalRecipient: 'x', physicalRecipient: 'x', isTest: false })
  {
    const r = await processarComoRota('NAO_RETIRADA')
    assert(r === 'OBSOLETO', 'F) resultado é OBSOLETO quando o status não bate mais', r)
    assert(evento.status === 'OBSOLETO', 'F) evento é persistido como OBSOLETO', evento.status)
    assert(sendEmailCalls.length === 0, 'F) sendEmail (provider) nunca é chamado', sendEmailCalls.length)
  }

  // --- G/H) Texto do template PRONTA_RETIRADA não garante estado futuro ----
  // (correção final pós-Codex-Review: fecha a micro-race entre aindaValido()
  // e a entrega real pelo provedor, mudando a semântica da mensagem em vez
  // de tentar segurar um lock de banco durante a chamada ao Resend)
  {
    const { subject, html, text } = renderProntaRetiradaEmail({
      nomeSolicitante: 'Fulano',
      numero: 7,
      data: new Date('2026-08-20T00:00:00.000Z'),
      periodos: ['TARDE'],
      itensPatrimonio: [],
      itensPapelaria: [],
      link: 'http://localhost:3000/solicitacoes/sol-1',
      bannerDestinatarioOriginal: null,
    })
    assert(
      html.includes('foi preparada e disponibilizada para retirada') && text.includes('foi preparada e disponibilizada para retirada'),
      'G) template usa "foi preparada e disponibilizada para retirada" (notificação de evento, não garantia de estado atual)',
      { html, text }
    )
    // Correção pós-Codex-Review seguinte: o ASSUNTO também não pode mais
    // afirmar "está pronta" — era o único lugar que ainda restava com
    // linguagem de garantia de estado atual depois da correção do corpo.
    // Como o assunto mudou, o <title> do <head> do HTML (que ecoa
    // `subject`) também deixou de conter a frase antiga — dá para checar
    // subject/html/text de uma vez, sem ressalva.
    assert(
      !subject.includes('está pronta') && !html.includes('está pronta') && !text.includes('está pronta'),
      'G) nem assunto, nem HTML, nem texto puro afirmam "está pronta" (presente/estado atual garantido)',
      { subject, html, text }
    )
    assert(
      subject.includes('foi preparada para retirada'),
      'G) assunto descreve o evento de preparação ocorrido, não uma garantia de estado atual',
      subject
    )
    assert(
      html.includes('consulte a solicitação para verificar a situação atual') &&
        text.includes('consulte a solicitação para verificar a situação atual'),
      'H) template orienta a consultar a situação atual antes da retirada',
      { html, text }
    )
  }

  // --- H) SOLICITACAO_AGUARDANDO_GESTOR: já aprovada antes do dispatch → OBSOLETO ------
  resetMocks()
  statusSolicitacaoAtual = 'AGUARDANDO_PATRIMONIO' // aprovada pelo gestor → avançou de status
  instalarMockSendEmail({ success: true, providerId: 'p-H', originalRecipient: 'x', physicalRecipient: 'x', isTest: false })
  {
    const r = await processarComoRota('SOLICITACAO_AGUARDANDO_GESTOR')
    assert(r === 'OBSOLETO', 'H) resultado é OBSOLETO quando a solicitação já foi aprovada pelo gestor', r)
    assert(evento.status === 'OBSOLETO', 'H) evento é persistido como OBSOLETO', evento.status)
    assert(sendEmailCalls.length === 0, 'H) sendEmail (provider) nunca é chamado — nenhuma notificação atrasada', sendEmailCalls.length)
  }

  // --- I) SOLICITACAO_AGUARDANDO_GESTOR: rejeitada/cancelada antes do dispatch → OBSOLETO ---
  for (const statusIncompativel of ['REJEICAO_GESTOR', 'CANCELADA']) {
    resetMocks()
    statusSolicitacaoAtual = statusIncompativel
    instalarMockSendEmail({ success: true, providerId: 'p-I', originalRecipient: 'x', physicalRecipient: 'x', isTest: false })
    const r = await processarComoRota('SOLICITACAO_AGUARDANDO_GESTOR')
    assert(r === 'OBSOLETO', `I) resultado é OBSOLETO quando a solicitação está ${statusIncompativel}`, r)
    assert(evento.status === 'OBSOLETO', `I) evento é persistido como OBSOLETO (${statusIncompativel})`, evento.status)
    assert(sendEmailCalls.length === 0, `I) sendEmail (provider) nunca é chamado (${statusIncompativel})`, sendEmailCalls.length)
  }

  // --- I.2) SOLICITACAO_AGUARDANDO_GESTOR: status continua AGUARDANDO_GESTOR → envia -------
  resetMocks()
  statusSolicitacaoAtual = 'AGUARDANDO_GESTOR'
  instalarMockSendEmail({ success: true, providerId: 'p-I2', originalRecipient: 'x', physicalRecipient: 'x', isTest: false })
  {
    const r = await processarComoRota('SOLICITACAO_AGUARDANDO_GESTOR')
    assert(r === 'ENVIADO', 'I.2) resultado é ENVIADO quando a decisão do gestor continua pendente', r)
    assert(sendEmailCalls.length === 1, 'I.2) sendEmail é chamado normalmente', sendEmailCalls.length)
  }

  // --- J) ASSINATURA_PENDENTE: assinatura já confirmada antes do dispatch → OBSOLETO ------
  resetMocks()
  statusSolicitacaoAtual = 'ASSINATURA_CONFIRMADA'
  instalarMockSendEmail({ success: true, providerId: 'p-J', originalRecipient: 'x', physicalRecipient: 'x', isTest: false })
  {
    const r = await processarComoRota('ASSINATURA_PENDENTE')
    assert(r === 'OBSOLETO', 'J) resultado é OBSOLETO quando a assinatura já foi confirmada', r)
    assert(evento.status === 'OBSOLETO', 'J) evento é persistido como OBSOLETO', evento.status)
    assert(sendEmailCalls.length === 0, 'J) sendEmail (provider) nunca é chamado — nenhuma notificação atrasada', sendEmailCalls.length)
  }

  // --- K) ASSINATURA_PENDENTE: cancelamento antes do dispatch → OBSOLETO ------------------
  resetMocks()
  statusSolicitacaoAtual = 'CANCELADA'
  instalarMockSendEmail({ success: true, providerId: 'p-K', originalRecipient: 'x', physicalRecipient: 'x', isTest: false })
  {
    const r = await processarComoRota('ASSINATURA_PENDENTE')
    assert(r === 'OBSOLETO', 'K) resultado é OBSOLETO quando a solicitação foi cancelada', r)
    assert(evento.status === 'OBSOLETO', 'K) evento é persistido como OBSOLETO', evento.status)
    assert(sendEmailCalls.length === 0, 'K) sendEmail (provider) nunca é chamado', sendEmailCalls.length)
  }

  // --- K.2) ASSINATURA_PENDENTE: status continua AGUARDANDO_ASSINATURA → envia ------------
  resetMocks()
  statusSolicitacaoAtual = 'AGUARDANDO_ASSINATURA'
  instalarMockSendEmail({ success: true, providerId: 'p-K2', originalRecipient: 'x', physicalRecipient: 'x', isTest: false })
  {
    const r = await processarComoRota('ASSINATURA_PENDENTE')
    assert(r === 'ENVIADO', 'K.2) resultado é ENVIADO quando a assinatura continua pendente', r)
    assert(sendEmailCalls.length === 1, 'K.2) sendEmail é chamado normalmente', sendEmailCalls.length)
  }

  // --- L) SOLICITACAO_AGUARDANDO_PATRIMONIO: status continua AGUARDANDO_PATRIMONIO → envia ---
  resetMocks()
  statusSolicitacaoAtual = 'AGUARDANDO_PATRIMONIO'
  instalarMockSendEmail({ success: true, providerId: 'p-L', originalRecipient: 'x', physicalRecipient: 'x', isTest: false })
  {
    const r = await processarComoRota('SOLICITACAO_AGUARDANDO_PATRIMONIO')
    assert(r === 'ENVIADO', 'L) resultado é ENVIADO quando a análise do Patrimônio continua pendente', r)
    assert(sendEmailCalls.length === 1, 'L) sendEmail é chamado normalmente', sendEmailCalls.length)
  }

  // --- M) SOLICITACAO_AGUARDANDO_PATRIMONIO: Patrimônio confirmou antes do dispatch → OBSOLETO ---
  resetMocks()
  statusSolicitacaoAtual = 'EM_SEPARACAO' // Patrimônio confirmou → fluxo interno avançou (ver /confirmar-patrimonio)
  instalarMockSendEmail({ success: true, providerId: 'p-M', originalRecipient: 'x', physicalRecipient: 'x', isTest: false })
  {
    const r = await processarComoRota('SOLICITACAO_AGUARDANDO_PATRIMONIO')
    assert(r === 'OBSOLETO', 'M) resultado é OBSOLETO quando o Patrimônio já confirmou', r)
    assert(evento.status === 'OBSOLETO', 'M) evento é persistido como OBSOLETO', evento.status)
    assert(sendEmailCalls.length === 0, 'M) sendEmail (provider) nunca é chamado — nenhuma notificação atrasada', sendEmailCalls.length)
  }

  // --- N) SOLICITACAO_AGUARDANDO_PATRIMONIO: Patrimônio rejeitou antes do dispatch → OBSOLETO ---
  resetMocks()
  statusSolicitacaoAtual = 'REJEITADA_PATRIMONIO'
  instalarMockSendEmail({ success: true, providerId: 'p-N', originalRecipient: 'x', physicalRecipient: 'x', isTest: false })
  {
    const r = await processarComoRota('SOLICITACAO_AGUARDANDO_PATRIMONIO')
    assert(r === 'OBSOLETO', 'N) resultado é OBSOLETO quando o Patrimônio já rejeitou', r)
    assert(evento.status === 'OBSOLETO', 'N) evento é persistido como OBSOLETO', evento.status)
    assert(sendEmailCalls.length === 0, 'N) sendEmail (provider) nunca é chamado', sendEmailCalls.length)
  }

  // --- O) SOLICITACAO_AGUARDANDO_PATRIMONIO: cancelada antes do dispatch → OBSOLETO -------
  resetMocks()
  statusSolicitacaoAtual = 'CANCELADA'
  instalarMockSendEmail({ success: true, providerId: 'p-O', originalRecipient: 'x', physicalRecipient: 'x', isTest: false })
  {
    const r = await processarComoRota('SOLICITACAO_AGUARDANDO_PATRIMONIO')
    assert(r === 'OBSOLETO', 'O) resultado é OBSOLETO quando a solicitação foi cancelada', r)
    assert(evento.status === 'OBSOLETO', 'O) evento é persistido como OBSOLETO', evento.status)
    assert(sendEmailCalls.length === 0, 'O) sendEmail (provider) nunca é chamado', sendEmailCalls.length)
  }

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) de validade de evento (caminho inline) falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes de validade de evento (caminho inline) passaram. Nenhum e-mail real foi enviado, nenhum banco real foi acessado.')
}

main().catch((err) => {
  console.error('Falha inesperada ao executar os testes de validade de evento:', err instanceof Error ? err.message : err)
  process.exit(1)
})
