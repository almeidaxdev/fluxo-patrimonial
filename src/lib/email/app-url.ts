// src/lib/email/app-url.ts
import { parseAppUrl } from './config'

// Cache separado da configuração de e-mail: buildAppUrl só depende de
// APP_URL e não deve exigir credenciais de provedor para ser usada (ex.: ao
// montar um link de e-mail antes de decidir se o envio vai ocorrer).
// A regra de validação em si vem de parseAppUrl() (config.ts) — ponto
// único, para não divergir da validação usada por getEmailConfig().
let baseCache: string | null = null

function getAppUrlBase(): string {
  if (baseCache) return baseCache
  baseCache = parseAppUrl(process.env.APP_URL)
  return baseCache
}

/**
 * Monta uma URL absoluta interna a partir de APP_URL, evitando barras
 * duplicadas independentemente de APP_URL terminar ou não com "/".
 * Nunca inclui token/JWT/sessão — apenas caminho.
 */
export function buildAppUrl(path: string): string {
  const base = getAppUrlBase()
  const cleanPath = path.startsWith('/') ? path : `/${path}`
  return `${base}${cleanPath}`
}

export function resetAppUrlCache(): void {
  baseCache = null
}
