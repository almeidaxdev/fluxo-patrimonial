// src/lib/email/templates/components.ts
import { escapeHtml } from '../html'

export interface RenderButtonInput {
  href: string
  label: string
}

/**
 * Botão compatível com Outlook (tabela + estilos inline, sem CSS externo),
 * com link textual de fallback logo abaixo. `border-radius` é progressivo —
 * clientes que o ignoram (ex.: Outlook desktop) mostram cantos retos, sem
 * perder a área clicável.
 */
export function renderButton({ href, label }: RenderButtonInput): string {
  const safeHref = escapeHtml(href)
  const safeLabel = escapeHtml(label)

  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 28px 0 16px 0;">
  <tr>
    <td align="center" bgcolor="#0F6B63" style="border-radius: 6px;">
      <a href="${safeHref}" target="_blank"
         style="display: inline-block; padding: 14px 32px; font-family: Arial, Helvetica, sans-serif; font-size: 15px; font-weight: bold; color: #ffffff; text-decoration: none; border-radius: 6px;">
        ${safeLabel}
      </a>
    </td>
  </tr>
</table>
<p style="font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #8a8f98; margin: 0 0 8px 0;">
  Se o botão não funcionar, copie e cole este link no navegador:
</p>
<p style="font-family: Arial, Helvetica, sans-serif; font-size: 12px; margin: 0 0 24px 0; word-break: break-all;">
  <a href="${safeHref}" target="_blank" style="color: #0F6B63;">${safeHref}</a>
</p>`.trim()
}

/**
 * Bloco visível identificando um e-mail como enviado em ambiente de teste,
 * com o destinatário original que o receberia em produção.
 */
export function renderTestBanner(originalRecipient: string): string {
  const safeOriginal = escapeHtml(originalRecipient)

  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color: #fff8e6; border: 1px solid #f5dd94; border-radius: 8px; margin-bottom: 24px;">
  <tr>
    <td style="padding: 14px 18px; font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #7a5c00; line-height: 1.6;">
      <div style="font-weight: bold; letter-spacing: 0.3px; margin-bottom: 4px;">AMBIENTE DE TESTE</div>
      <div>Destinatário original: ${safeOriginal}</div>
    </td>
  </tr>
</table>`.trim()
}

export interface SummaryRowInput {
  label: string
  value: string
}

/**
 * Bloco "Solicitação / Data / Período" em tabela label-valor, com fundo
 * suave para separar visualmente do restante do corpo.
 */
export function renderSummaryTable(rows: SummaryRowInput[]): string {
  const linhas = rows
    .map(
      (row) => `
    <tr>
      <td style="padding: 5px 0; font-family: Arial, Helvetica, sans-serif; font-size: 13px; color: #667085; width: 120px; vertical-align: top;">${escapeHtml(row.label)}</td>
      <td style="padding: 5px 0; font-family: Arial, Helvetica, sans-serif; font-size: 14px; color: #1a1a1a; font-weight: bold;">${escapeHtml(row.value)}</td>
    </tr>`
    )
    .join('')

  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color: #f6f8fa; border: 1px solid #e9ecef; border-radius: 8px; margin: 20px 0;">
  <tr>
    <td style="padding: 16px 20px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        ${linhas}
      </table>
    </td>
  </tr>
</table>`.trim()
}

export interface ListItemInput {
  primary: string
  secondary?: string
}

/**
 * Lista visual com título em destaque (ex.: "ITENS RESERVADOS") e um item
 * por linha — cada um com um texto principal e, opcionalmente, uma linha
 * secundária menor (ex.: número de patrimônio). Retorna string vazia
 * quando não há itens, para o chamador omitir o bloco inteiro.
 */
export function renderItemList(title: string, items: ListItemInput[]): string {
  if (items.length === 0) return ''

  const linhas = items
    .map((item, index) => {
      const isLast = index === items.length - 1
      const borda = isLast ? '' : 'border-bottom: 1px solid #eef0f2;'
      const secundaria = item.secondary
        ? `<div style="font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #667085; margin-top: 2px;">${escapeHtml(item.secondary)}</div>`
        : ''

      return `
    <tr>
      <td style="padding: 10px 0; ${borda}">
        <div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; color: #1a1a1a;">• ${escapeHtml(item.primary)}</div>
        ${secundaria}
      </td>
    </tr>`
    })
    .join('')

  return `
<div style="margin: 20px 0;">
  <div style="font-family: Arial, Helvetica, sans-serif; font-size: 12px; font-weight: bold; color: #0F6B63; text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 6px;">
    ${escapeHtml(title)}
  </div>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
    ${linhas}
  </table>
</div>`.trim()
}
