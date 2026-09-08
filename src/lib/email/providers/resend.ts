// src/lib/email/providers/resend.ts
import { Resend } from 'resend'
import type { EmailConfig } from '../config'
import type { EmailMessage, EmailProvider, EmailSendResult } from '../provider'
import { EmailProviderError } from '../provider'

function normalizeError(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err).slice(0, 500)
  } catch {
    return 'Erro desconhecido do provedor de e-mail.'
  }
}

export function createResendProvider(config: EmailConfig): EmailProvider {
  const client = new Resend(config.apiKey)

  return {
    async send(message: EmailMessage): Promise<EmailSendResult> {
      try {
        const result = await client.emails.send(
          {
            from: `${config.fromName} <${config.fromAddress}>`,
            to: message.to,
            subject: message.subject,
            html: message.html,
            text: message.text,
            replyTo: message.replyTo,
          },
          // Opção oficial da SDK do Resend — traduz idempotencyKey em
          // header `Idempotency-Key`. Omitido (undefined) quando o
          // chamador não fornece chave, mantendo o comportamento anterior.
          message.idempotencyKey ? { idempotencyKey: message.idempotencyKey } : undefined
        )

        if (result.error) {
          throw new EmailProviderError(normalizeError(result.error))
        }

        return { providerId: result.data?.id }
      } catch (err) {
        if (err instanceof EmailProviderError) throw err
        throw new EmailProviderError(normalizeError(err))
      }
    },
  }
}
