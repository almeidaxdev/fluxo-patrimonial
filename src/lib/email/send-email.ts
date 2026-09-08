// src/lib/email/send-email.ts
import { getEmailConfig, EmailConfigError } from './config'
import { resolvePhysicalRecipient } from './recipient'
import { createResendProvider } from './providers/resend'
import type { EmailConfig } from './config'
import type { EmailProvider } from './provider'
import { EmailProviderError } from './provider'

export interface SendEmailInput {
  /** Destinatário lógico original. Nunca recebe o e-mail fisicamente em EMAIL_TEST_MODE. */
  to: string
  subject: string
  html: string
  text?: string
  replyTo?: string
  /** Repassada como está para o provedor — ver EmailMessage.idempotencyKey em provider.ts. */
  idempotencyKey?: string
}

export interface SendEmailResult {
  success: boolean
  providerId?: string
  originalRecipient: string
  physicalRecipient: string
  isTest: boolean
  error?: string
}

function getProvider(config: EmailConfig): EmailProvider {
  switch (config.provider) {
    case 'resend':
      return createResendProvider(config)
    default:
      throw new EmailConfigError(`Provedor de e-mail não suportado: ${config.provider}`)
  }
}

/**
 * Ponto único de envio de e-mail do sistema. Nenhum outro módulo deve
 * chamar a SDK de um provedor diretamente.
 *
 * Garante, independentemente do chamador:
 * - redirecionamento físico obrigatório em EMAIL_TEST_MODE (nunca envia ao
 *   destinatário real nesse modo, com falha segura se a configuração de
 *   teste estiver incompleta — ver resolvePhysicalRecipient);
 * - reply-to institucional (EMAIL_REPLY_TO) quando configurado, sobrepondo
 *   qualquer valor vindo do chamador;
 * - erros do provedor nunca vazam como exceção não tratada — sempre
 *   retornam como SendEmailResult com success: false.
 *
 * Não lança para falhas de envio (config ou provedor); apenas retorna
 * success: false. Isso permite que o chamador (fase futura) trate a falha
 * de e-mail sem comprometer a transação de negócio que a originou.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  let config: EmailConfig
  try {
    config = getEmailConfig()
  } catch (err) {
    return {
      success: false,
      originalRecipient: input.to,
      physicalRecipient: input.to,
      isTest: false,
      error: err instanceof Error ? err.message : 'Erro de configuração de e-mail desconhecido.',
    }
  }

  let recipient
  try {
    recipient = resolvePhysicalRecipient(input.to)
  } catch (err) {
    return {
      success: false,
      originalRecipient: input.to,
      physicalRecipient: input.to,
      isTest: false,
      error: err instanceof Error ? err.message : 'Erro ao resolver destinatário de e-mail.',
    }
  }

  try {
    const provider = getProvider(config)
    const result = await provider.send({
      to: recipient.physical,
      subject: recipient.isTest ? `[TESTE] ${input.subject}` : input.subject,
      html: input.html,
      text: input.text,
      replyTo: config.replyTo ?? input.replyTo,
      idempotencyKey: input.idempotencyKey,
    })

    return {
      success: true,
      providerId: result.providerId,
      originalRecipient: recipient.original,
      physicalRecipient: recipient.physical,
      isTest: recipient.isTest,
    }
  } catch (err) {
    const message =
      err instanceof EmailProviderError || err instanceof Error
        ? err.message
        : 'Erro desconhecido ao enviar e-mail.'

    return {
      success: false,
      originalRecipient: recipient.original,
      physicalRecipient: recipient.physical,
      isTest: recipient.isTest,
      error: message,
    }
  }
}
