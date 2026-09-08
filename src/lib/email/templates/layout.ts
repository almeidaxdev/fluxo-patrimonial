// src/lib/email/templates/layout.ts
import { escapeHtml } from '../html'
import { renderTestBanner } from './components'

export interface RenderEmailLayoutInput {
  title: string
  /** HTML já montado do corpo do e-mail (deve vir de templates que escapam valores dinâmicos). */
  bodyHtml: string
  /** Presente apenas quando o envio será redirecionado pelo modo de teste. */
  testOriginalRecipient?: string | null
}

/**
 * Layout institucional base, conservador para compatibilidade com Outlook:
 * tabelas, estilos inline, largura fixa, fontes padrão, sem flex/grid/JS.
 * `border-radius`/sombra são progressivos: degradam para cantos retos em
 * clientes que os ignoram (ex.: Outlook desktop), sem quebrar a estrutura.
 */
export function renderEmailLayout({ title, bodyHtml, testOriginalRecipient }: RenderEmailLayoutInput): string {
  const safeTitle = escapeHtml(title)
  const banner = testOriginalRecipient ? renderTestBanner(testOriginalRecipient) : ''

  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light" />
    <title>${safeTitle}</title>
  </head>
  <body style="margin: 0; padding: 0; background-color: #eef1f5;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color: #eef1f5;">
      <tr>
        <td align="center" style="padding: 32px 16px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width: 600px; width: 100%; background-color: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #e3e6eb;">
            <tr>
              <td style="padding: 28px 32px; background-color: #0F6B63;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                  <tr>
                    <td style="font-family: Arial, Helvetica, sans-serif;">
                      <div style="font-size: 20px; font-weight: bold; color: #ffffff; line-height: 1.3;">
                        Fluxo Patrimonial
                      </div>
                      <div style="font-size: 12px; color: #cfe0f2; margin-top: 2px; letter-spacing: 0.2px;">
                        Gestão de Patrimônio
                      </div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding: 32px;">
                ${banner}
                <div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; color: #2b2b2b; line-height: 1.6;">
                  ${bodyHtml}
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding: 20px 32px 28px 32px;">
                <div style="border-top: 1px solid #e3e6eb; padding-top: 16px;">
                  <span style="font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #8a8f98; line-height: 1.5;">
                    Mensagem automática do sistema de Gestão de Empréstimos Patrimoniais Fluxo Patrimonial. Não responda diretamente a este e-mail.
                  </span>
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
}

/**
 * Versão em texto simples equivalente ao layout, para clientes de e-mail
 * sem suporte a HTML. Templates específicos devem fornecer `bodyText` já
 * formatado (sem HTML).
 */
export function renderEmailLayoutText(bodyText: string, testOriginalRecipient?: string | null): string {
  const banner = testOriginalRecipient
    ? `[AMBIENTE DE TESTE]\nDestinatário original: ${testOriginalRecipient}\n\n`
    : ''

  return `${banner}${bodyText}\n\n--\nFluxo Patrimonial — Gestão de Patrimônio\nMensagem automática, não responda a este e-mail.`
}
