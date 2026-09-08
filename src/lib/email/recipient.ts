// src/lib/email/recipient.ts
import { getEmailConfig, EmailConfigError } from './config'

export interface ResolvedRecipient {
  /** Destinatário lógico original esperado pelo evento de negócio. */
  original: string
  /** Destinatário físico real do envio (igual a `original` fora do modo de teste). */
  physical: string
  isTest: boolean
}

/**
 * Resolve o destinatário físico de um envio. Em EMAIL_TEST_MODE, todo envio
 * é redirecionado para EMAIL_TEST_RECIPIENT — o destinatário original nunca
 * recebe o e-mail fisicamente, mas continua rastreável em `original`.
 *
 * getEmailConfig() já falha (EmailConfigError) se o modo de teste estiver
 * ativo sem um destinatário de teste válido, então esta função nunca cai de
 * volta para o destinatário real por omissão de configuração.
 */
export function resolvePhysicalRecipient(original: string): ResolvedRecipient {
  const config = getEmailConfig()

  if (!config.testMode) {
    return { original, physical: original, isTest: false }
  }

  if (!config.testRecipient) {
    throw new EmailConfigError(
      'EMAIL_TEST_MODE está ativo sem EMAIL_TEST_RECIPIENT configurado — envio bloqueado por segurança.'
    )
  }

  return { original, physical: config.testRecipient, isTest: true }
}
