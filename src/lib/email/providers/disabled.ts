// src/lib/email/providers/disabled.ts
//
// Provedor no-op para EMAIL_PROVIDER=disabled (Fluxo Patrimonial — Demo).
// `send()` nunca faz nenhuma chamada de rede — nenhum fetch, nenhuma SDK de
// provedor é importada/instanciada. Sempre resolve com sucesso, para que o
// restante do fluxo (EmailEvento, dispatcher, rotas de negócio) continue
// funcionando exatamente como funcionaria com um provedor real que sempre
// entrega — só que sem nenhuma mensagem saindo do sistema.
import type { EmailMessage, EmailProvider, EmailSendResult } from '../provider'

export function createDisabledProvider(): EmailProvider {
  return {
    async send(_message: EmailMessage): Promise<EmailSendResult> {
      return { providerId: 'disabled' }
    },
  }
}
