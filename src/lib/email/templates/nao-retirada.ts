// src/lib/email/templates/nao-retirada.ts
// Etapa D.2 — template do evento NAO_RETIRADA. Tom neutro e institucional
// (não acusatório) — ver decisão registrada na Etapa D.2. Monta apenas
// subject/html/text; destinatário físico, provedor e persistência do
// EmailEvento são responsabilidade de src/lib/email/processar-evento.ts.
import { formatDataCivil, formatDateTime, formatPeriodos } from '@/utils'
import type { PeriodoSolicitacao } from '@/types'
import { escapeHtml } from '../html'
import { renderEmailLayout, renderEmailLayoutText } from './layout'
import { renderButton, renderSummaryTable } from './components'
import type { RenderedEmail } from '../processar-evento'

export interface NaoRetiradaTemplateInput {
  nomeSolicitante: string
  numero: number
  data: Date
  periodos: PeriodoSolicitacao[]
  naoRetiradaEm: Date
  link: string
  /** Repassado direto de BuildEmailContext — ver processar-evento.ts. */
  bannerDestinatarioOriginal: string | null
}

export function renderNaoRetiradaEmail(input: NaoRetiradaTemplateInput): RenderedEmail {
  const subject = `[Fluxo Patrimonial] Reserva não retirada — #${input.numero}`

  // input.data é a DATA CIVIL da reserva (Solicitacao.data, @db.Date) —
  // formatDataCivil(), não formatDate() (ver Etapa D.3.FOLLOW-UP).
  // input.naoRetiradaEm CONTINUA em formatDateTime(): é um instante real
  // (TIMESTAMP), correto exibir em horário local/Brasília.
  const dataFormatada = formatDataCivil(input.data)
  const periodosFormatados = formatPeriodos(input.periodos)
  const registradoEmFormatado = formatDateTime(input.naoRetiradaEm)

  const bodyHtml = `
<p style="margin: 0 0 4px 0; font-size: 15px;">Olá, <strong>${escapeHtml(input.nomeSolicitante)}</strong>.</p>
<p style="margin: 0 0 4px 0;">A solicitação #${input.numero} foi registrada como não retirada.</p>
${renderSummaryTable([
  { label: 'Reserva prevista', value: dataFormatada },
  { label: 'Período', value: periodosFormatados },
  { label: 'Registrada em', value: registradoEmFormatado },
])}
${renderButton({ href: input.link, label: 'VER SOLICITAÇÃO' })}
`.trim()

  const html = renderEmailLayout({
    title: subject,
    bodyHtml,
    testOriginalRecipient: input.bannerDestinatarioOriginal,
  })

  const textBody = [
    `Olá, ${input.nomeSolicitante}.`,
    '',
    `A solicitação #${input.numero} foi registrada como não retirada.`,
    '',
    `Reserva prevista para: ${dataFormatada}`,
    `Período: ${periodosFormatados}`,
    '',
    `Registrada como não retirada em: ${registradoEmFormatado}`,
    '',
    `Ver solicitação: ${input.link}`,
  ].join('\n')

  const text = renderEmailLayoutText(textBody, input.bannerDestinatarioOriginal)

  return { subject, html, text }
}
