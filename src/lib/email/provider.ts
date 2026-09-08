// src/lib/email/provider.ts

export interface EmailMessage {
  to: string
  subject: string
  html: string
  text?: string
  replyTo?: string
  /**
   * Chave de idempotência por EmailEvento + GERAÇÃO LÓGICA (Etapa D.2 —
   * outbox; revisada na Etapa fix/signature-resend — ver
   * idempotencyKeyParaEvento em processar-evento.ts para a distinção
   * completa entre "geração" e `EmailEvento.tentativas`): reenviar a mesma
   * geração com a mesma chave nunca resulta em dois e-mails físicos —
   * proteção contra reprocessamento do MESMO claim E contra retry depois de
   * uma FALHA ambígua (o provedor pode ter aceitado a requisição antes de
   * um timeout do nosso lado — a aplicação não distingue isso de uma
   * rejeição definitiva, então precisa tratar como "possivelmente já
   * enviado" e preservar a chave). Uma geração NOVA (reenvio explícito de
   * um evento já ENVIADO — entrega CONFIRMADA pelo provedor) recebe uma
   * chave diferente — a aplicação não depende do provedor deduplicar (ou
   * não) a chave de uma geração anterior para que esse reenvio genuíno
   * chegue a ser entregue. Cada provedor traduz isso para o mecanismo
   * nativo equivalente.
   */
  idempotencyKey?: string
}

export interface EmailSendResult {
  /** Identificador retornado pelo provedor, quando disponível. */
  providerId?: string
}

export class EmailProviderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EmailProviderError'
  }
}

/**
 * Contrato que qualquer provedor de e-mail deve implementar. O restante do
 * sistema nunca deve depender da SDK de um provedor específico — apenas
 * desta interface, via sendEmail() em send-email.ts.
 */
export interface EmailProvider {
  send(message: EmailMessage): Promise<EmailSendResult>
}
