// src/lib/email/templates/pronta-retirada.ts
// Etapa D.2 — template do evento PRONTA_RETIRADA. Monta apenas subject/html/text;
// destinatário físico, provedor e persistência do EmailEvento são
// responsabilidade de src/lib/email/processar-evento.ts.
//
// Texto (correção pós-Codex-Review): o e-mail é uma NOTIFICAÇÃO de que a
// separação ocorreu, não uma garantia do estado atual no instante em que
// o destinatário o lê — mesmo com a validação em aindaValido() (ver
// validade-evento.ts, executada depois do claim e antes deste template
// ser montado), a solicitação pode mudar de status nos milissegundos
// entre essa validação e a entrega real pelo provedor. Por isso nem o
// corpo nem o ASSUNTO (correção pós-Codex-Review seguinte: o assunto
// ainda dizia "está pronta" mesmo depois do corpo já ter sido corrigido)
// afirmam "está pronta para retirada" (presente, implica garantia atual)
// — o corpo ainda inclui uma orientação explícita para conferir a
// situação antes de agir. A mensagem continua historicamente verdadeira
// mesmo nesse cenário raro.
import { formatDataCivil, formatPeriodos } from '@/utils'
import type { PeriodoSolicitacao } from '@/types'
import { escapeHtml } from '../html'
import { renderEmailLayout, renderEmailLayoutText } from './layout'
import { renderButton, renderSummaryTable, renderItemList, type ListItemInput } from './components'
import type { RenderedEmail } from '../processar-evento'

export interface ItemPatrimonioResumo {
  numero: string
  marca: string
  modelo: string
}

export interface ItemPapelariaResumo {
  descricao: string
  quantidade: number
}

export interface ProntaRetiradaTemplateInput {
  nomeSolicitante: string
  numero: number
  data: Date
  periodos: PeriodoSolicitacao[]
  itensPatrimonio: ItemPatrimonioResumo[]
  itensPapelaria: ItemPapelariaResumo[]
  link: string
  /** Repassado direto de BuildEmailContext — ver processar-evento.ts. */
  bannerDestinatarioOriginal: string | null
}

function itensParaLista(itensPatrimonio: ItemPatrimonioResumo[], itensPapelaria: ItemPapelariaResumo[]): ListItemInput[] {
  return [
    ...itensPatrimonio.map((item) => ({
      primary: `${item.marca} ${item.modelo}`,
      secondary: `Patrimônio: ${item.numero}`,
    })),
    ...itensPapelaria.map((item) => ({
      primary: `${item.descricao} (${item.quantidade}x)`,
    })),
  ]
}

function itensParaTexto(itensPatrimonio: ItemPatrimonioResumo[], itensPapelaria: ItemPapelariaResumo[]): string {
  const linhas: string[] = [
    ...itensPatrimonio.map((item) => `- ${item.marca} ${item.modelo} (patrimônio ${item.numero})`),
    ...itensPapelaria.map((item) => `- ${item.descricao} (${item.quantidade}x)`),
  ]
  return linhas.length > 0 ? linhas.join('\n') : '- Nenhum item registrado.'
}

export function renderProntaRetiradaEmail(input: ProntaRetiradaTemplateInput): RenderedEmail {
  const subject = `[Fluxo Patrimonial] Sua reserva foi preparada para retirada — #${input.numero}`

  // input.data é a DATA CIVIL da reserva (Solicitacao.data, Prisma
  // `DateTime @db.Date` — sem componente de hora/timezone), nunca um
  // instante real — por isso formatDataCivil(), não formatDate() (ver
  // análise da Etapa D.3.FOLLOW-UP: formatDate() usa getters locais de
  // Date, que podem exibir o dia anterior dependendo do timezone do
  // processo/navegador).
  const dataFormatada = formatDataCivil(input.data)
  const periodosFormatados = formatPeriodos(input.periodos)
  const itensLista = itensParaLista(input.itensPatrimonio, input.itensPapelaria)

  const bodyHtml = `
<p style="margin: 0 0 4px 0; font-size: 15px;">Olá, <strong>${escapeHtml(input.nomeSolicitante)}</strong>.</p>
<p style="margin: 0 0 4px 0;">Sua reserva foi preparada e disponibilizada para retirada.</p>
<p style="margin: 0 0 16px 0; font-size: 13px; color: #667085;">Antes de realizar a retirada, consulte a solicitação para verificar a situação atual.</p>
${renderSummaryTable([
  { label: 'Solicitação', value: `#${input.numero}` },
  { label: 'Data', value: dataFormatada },
  { label: 'Período', value: periodosFormatados },
])}
${renderItemList('Itens reservados', itensLista)}
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
    'Sua reserva foi preparada e disponibilizada para retirada.',
    '',
    'Antes de realizar a retirada, consulte a solicitação para verificar a situação atual.',
    '',
    `Solicitação: #${input.numero}`,
    `Data: ${dataFormatada}`,
    `Período: ${periodosFormatados}`,
    '',
    'Itens reservados:',
    itensParaTexto(input.itensPatrimonio, input.itensPapelaria),
    '',
    `Ver solicitação: ${input.link}`,
  ].join('\n')

  const text = renderEmailLayoutText(textBody, input.bannerDestinatarioOriginal)

  return { subject, html, text }
}
