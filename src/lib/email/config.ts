// src/lib/email/config.ts
// 'disabled' (Fluxo Patrimonial — Demo): provedor no-op — nenhuma chamada de
// rede, nenhuma credencial exigida. Ver getEmailConfig() e
// send-email.ts/getProvider() para os dois únicos pontos que conhecem este
// valor especial.
export type EmailProviderName = 'resend' | 'disabled'

export interface EmailConfig {
  provider: EmailProviderName
  // Vazios/nulos quando provider === 'disabled' — nunca exigidos nesse modo
  // (ver isNonEmpty()/validações condicionais em getEmailConfig() abaixo).
  apiKey: string
  fromName: string
  fromAddress: string
  replyTo: string | null
  appUrl: string
  testMode: boolean
  testRecipient: string | null
}

export class EmailConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EmailConfigError'
  }
}

const SUPPORTED_PROVIDERS: EmailProviderName[] = ['resend', 'disabled']

function isNonEmpty(value: string | undefined | null): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}

const ALLOWED_APP_URL_PROTOCOLS = ['http:', 'https:']

/**
 * Ponto único de validação de APP_URL, usado tanto por getEmailConfig()
 * quanto por buildAppUrl() (src/lib/email/app-url.ts) — nunca duplicar esta
 * regra. Aceita apenas URLs absolutas http/https com hostname (localhost e
 * IPs servem para desenvolvimento); rejeita outros esquemas (mailto:,
 * javascript:, ftp:, file: etc.), string vazia e valores ausentes.
 */
export function parseAppUrl(raw: string | undefined | null): string {
  if (!isNonEmpty(raw)) {
    throw new EmailConfigError('APP_URL ausente: defina a URL base da aplicação para montagem de links de e-mail.')
  }

  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    throw new EmailConfigError(`APP_URL inválido: "${raw}" não é uma URL válida.`)
  }

  if (!ALLOWED_APP_URL_PROTOCOLS.includes(parsed.protocol)) {
    throw new EmailConfigError(
      `APP_URL inválido: protocolo "${parsed.protocol}" não é suportado. Use http: ou https: (ex.: http://localhost:3000).`
    )
  }

  if (!parsed.hostname) {
    throw new EmailConfigError(`APP_URL inválido: "${raw}" não possui hostname.`)
  }

  if (parsed.search || parsed.hash) {
    // APP_URL é a URL BASE da aplicação — query string ou fragment aqui
    // corromperiam a concatenação em buildAppUrl() (o path viraria parte da
    // query, ou ficaria escondido atrás do fragment).
    throw new EmailConfigError(
      `APP_URL inválido: "${raw}" não pode conter query string ou fragment — informe apenas a URL base (ex.: https://exemplo.com/app).`
    )
  }

  return parsed.toString().replace(/\/+$/, '')
}

// Avaliada de forma preguiçosa (só quando um e-mail realmente vai ser
// enviado), nunca no escopo do módulo — o Next.js importa módulos durante
// `next build`, que pode rodar sem as variáveis de ambiente de produção
// configuradas (ver mesmo padrão em src/lib/auth.ts).
let configCache: EmailConfig | null = null

export function getEmailConfig(): EmailConfig {
  if (configCache) return configCache

  const providerRaw = process.env.EMAIL_PROVIDER?.trim()
  if (!isNonEmpty(providerRaw) || !SUPPORTED_PROVIDERS.includes(providerRaw as EmailProviderName)) {
    throw new EmailConfigError(
      `EMAIL_PROVIDER inválido ou ausente: defina como um dos suportados (${SUPPORTED_PROVIDERS.join(', ')}).`
    )
  }
  const provider = providerRaw as EmailProviderName

  // 'disabled' (Fluxo Patrimonial — Demo): nenhuma credencial de provedor é
  // exigida — só APP_URL continua obrigatório (templates de e-mail montam
  // links absolutos independentemente de o envio físico acontecer ou não).
  // getProvider() (send-email.ts) nunca lê apiKey/fromAddress/fromName/
  // replyTo/testMode/testRecipient quando provider === 'disabled' — os
  // valores abaixo são só placeholders inertes para satisfazer o formato de
  // EmailConfig.
  if (provider === 'disabled') {
    const appUrlDisabled = parseAppUrl(process.env.APP_URL)
    configCache = {
      provider,
      apiKey: '',
      fromName: '',
      fromAddress: '',
      replyTo: null,
      appUrl: appUrlDisabled,
      testMode: false,
      testRecipient: null,
    }
    return configCache
  }

  const apiKey = process.env.EMAIL_API_KEY
  if (!isNonEmpty(apiKey)) {
    throw new EmailConfigError('EMAIL_API_KEY ausente: defina a chave de API do provedor de e-mail.')
  }

  const fromAddress = process.env.EMAIL_FROM_ADDRESS
  if (!isNonEmpty(fromAddress) || !looksLikeEmail(fromAddress)) {
    throw new EmailConfigError('EMAIL_FROM_ADDRESS ausente ou inválido: defina um endereço de e-mail válido.')
  }

  const fromNameRaw = process.env.EMAIL_FROM_NAME
  const fromName = isNonEmpty(fromNameRaw) ? fromNameRaw.trim() : 'Fluxo Patrimonial'

  const replyToRaw = process.env.EMAIL_REPLY_TO
  const replyTo = isNonEmpty(replyToRaw) ? replyToRaw.trim() : null
  if (replyTo && !looksLikeEmail(replyTo)) {
    throw new EmailConfigError('EMAIL_REPLY_TO inválido: defina um endereço de e-mail válido ou deixe vazio.')
  }

  const appUrl = parseAppUrl(process.env.APP_URL)

  // Comparação literal do valor RAW — sem trim, sem lowercase, sem coerção
  // booleana. EMAIL_TEST_MODE é o mecanismo de segurança contra envio real
  // acidental, então mesmo variações "óbvias" (" true", "TRUE", "False",
  // "true ") precisam ser rejeitadas, não normalizadas silenciosamente para
  // um valor aceito. Só os literais exatos "true"/"false" são válidos.
  const testModeRaw = process.env.EMAIL_TEST_MODE
  if (testModeRaw !== 'true' && testModeRaw !== 'false') {
    throw new EmailConfigError(
      `EMAIL_TEST_MODE ausente ou inválido: defina literalmente "true" ou "false", sem espaços e sem variação de maiúsculas/minúsculas (valor atual: ${
        testModeRaw === undefined ? 'ausente' : JSON.stringify(testModeRaw)
      }).`
    )
  }
  const testMode = testModeRaw === 'true'

  const testRecipientRaw = process.env.EMAIL_TEST_RECIPIENT
  const testRecipient = isNonEmpty(testRecipientRaw) ? testRecipientRaw.trim() : null

  if (testMode && (!testRecipient || !looksLikeEmail(testRecipient))) {
    // Proteção obrigatória: em modo de teste, um destinatário de teste
    // ausente ou inválido NUNCA deve resultar em fallback para o
    // destinatário real. Falha segura, sem envio possível.
    throw new EmailConfigError(
      'EMAIL_TEST_MODE está ativo, mas EMAIL_TEST_RECIPIENT está ausente ou inválido. Configure um destinatário de teste válido antes de enviar e-mails.'
    )
  }

  configCache = {
    provider,
    apiKey,
    fromName,
    fromAddress,
    replyTo,
    appUrl,
    testMode,
    testRecipient,
  }
  return configCache
}

// Uso exclusivo de testes/desenvolvimento: permite reavaliar a configuração
// após alterar variáveis de ambiente em tempo de execução.
export function resetEmailConfigCache(): void {
  configCache = null
}

// Caixa de grupo do Patrimônio (Etapa email-patrimonio-caixa-grupo):
// endereço ÚNICO para o qual todo e-mail cujo destinatário OPERACIONAL seja
// "a equipe Patrimônio" é enviado — nunca mais um EmailEvento por usuário
// individual com permissao='patrimonio'. Deliberadamente SEPARADA de
// EmailConfig/getEmailConfig() acima: é lida em outro MOMENTO do fluxo (ao
// decidir quem vai ser notificado, dentro da transação de negócio que cria
// a solicitação/confirma o Patrimônio/etc. — não ao efetivamente enviar),
// e sua ausência/invalidez não pode exigir EMAIL_API_KEY/EMAIL_PROVIDER
// válidos só para ser checada (getEmailConfig() validaria tudo isso junto,
// sem necessidade). Ver resolverEmailPatrimonioOuNull() em
// destinatarios.ts para o uso seguro dentro de uma transação (nunca lança).
let patrimonioRecipientCache: string | null = null

export function getEmailPatrimonioRecipient(): string {
  if (patrimonioRecipientCache) return patrimonioRecipientCache

  const raw = process.env.EMAIL_PATRIMONIO_RECIPIENT
  if (!isNonEmpty(raw) || !looksLikeEmail(raw)) {
    throw new EmailConfigError(
      'EMAIL_PATRIMONIO_RECIPIENT ausente ou inválido: defina o endereço de e-mail da caixa de grupo do Patrimônio.'
    )
  }

  patrimonioRecipientCache = raw.trim()
  return patrimonioRecipientCache
}

// Uso exclusivo de testes/desenvolvimento: mesmo propósito de
// resetEmailConfigCache() acima, para este cache separado.
export function resetEmailPatrimonioRecipientCache(): void {
  patrimonioRecipientCache = null
}
