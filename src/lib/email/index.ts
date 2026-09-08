// src/lib/email/index.ts
// Superfície pública do módulo de e-mail. Fases futuras devem importar
// destes pontos, nunca de providers/* ou da SDK do provedor diretamente.

export { sendEmail } from './send-email'
export type { SendEmailInput, SendEmailResult } from './send-email'

export { getEmailConfig, EmailConfigError, parseAppUrl } from './config'
export type { EmailConfig, EmailProviderName } from './config'

export { resolvePhysicalRecipient } from './recipient'
export type { ResolvedRecipient } from './recipient'

export { buildAppUrl } from './app-url'
export { escapeHtml } from './html'

export { renderEmailLayout, renderEmailLayoutText } from './templates/layout'
export { renderButton, renderTestBanner } from './templates/components'

export type { EmailMessage, EmailProvider, EmailSendResult } from './provider'
export { EmailProviderError } from './provider'

export { processarEmailEvento, idempotencyKeyParaEvento, geracaoIdempotenciaDoPayload } from './processar-evento'
export type { RenderedEmail, BuildEmailContext, BuildEmailTemplate, ResultadoProcessamento } from './processar-evento'

export { processarEmailsPendentes } from './dispatcher'
export type { ResumoDispatch } from './dispatcher'

export { criarValidadorDeEvento, statusEsperadoParaTipo } from './validade-evento'
