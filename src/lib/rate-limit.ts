// src/lib/rate-limit.ts
//
// Etapa security/rate-limit — helper central para todas as ações sensíveis
// protegidas por rate limit. O plano Vercel atual (Hobby) só permite UMA
// única regra de Rate Limit por projeto — por isso, em vez de uma regra por
// ação, este projeto usa UM ÚNICO Rate Limit ID (RATE_LIMIT_ID abaixo) e
// separa as ações por meio da própria `rateLimitKey`: cada chamada monta uma
// chave como `<namespace>:<hash>` (ex.: `login:9f86d0...`,
// `cadastro:2c26b4...`), então o contador de tentativas de LOGIN nunca soma
// com o de CADASTRO nem com o de reenvio de ASSINATURA — cada namespace tem
// seu próprio "balde", mesmo compartilhando a mesma janela/limite
// configurada na regra do Firewall (Fixed Window, 600s, 8 requests — ver
// docs/ARQUITETURA.md, seção "Rate limiting").
//
// A regra correspondente ("fluxo-patrimonial-sensitive-actions") é criada e mantida
// manualmente no Dashboard da Vercel (Firewall → Custom Rules) — nunca por
// código/CLI nesta etapa. Antes de essa regra existir/ser publicada, toda
// chamada aqui simplesmente devolve `limited: false` (fail-open) — ver
// `checkRateLimit()` de `@vercel/firewall`, que responde 404 (`error:
// 'not-found'`) e já assim `rateLimited: false`.
//
// Identificadores (e-mail, IP) NUNCA são usados em texto puro como chave —
// sempre normalizados e passados por SHA-256 antes de compor a
// `rateLimitKey`, para que nenhum e-mail de colaborador apareça em texto
// puro em qualquer log/observability do Firewall.

import { checkRateLimit } from '@vercel/firewall'
import type { NextRequest } from 'next/server'

// Único Rate Limit ID usado por TODAS as ações sensíveis deste projeto —
// corresponde exatamente ao "Rate Limit ID" configurado manualmente na
// única regra disponível no plano Hobby (ver docs/ARQUITETURA.md).
const RATE_LIMIT_ID = 'fluxo-patrimonial-sensitive-actions'

export interface SensitiveRateLimitInput {
  /** Request da rota (NextRequest ou Request padrão) — usado para extrair headers. */
  request: NextRequest | Request
  /**
   * Namespace da ação — isola o contador desta ação de qualquer outra que
   * reutilize o mesmo Rate Limit ID (ex.: `'login'`, `'cadastro'`,
   * `'assinatura'`). Nunca deve conter o separador `:` (usado para compor a
   * chave final).
   */
  namespace: string
  /**
   * Identificador bruto da entidade sendo limitada (e-mail, IP, ou uma
   * composição já pronta como `${solicitacaoId}:${session.id}`). Nunca
   * exposto ao client nem logado em texto puro — é normalizado e hasheado
   * antes de virar a `rateLimitKey`.
   */
  identifier: string
}

export interface SensitiveRateLimitResult {
  /** `true` quando a ação deve ser bloqueada com 429. */
  limited: boolean
}

/**
 * Extrai o IP do cliente da forma recomendada para o ambiente Vercel:
 * `x-real-ip` primeiro (mesmo header que `@vercel/firewall` usa como
 * fallback interno quando nenhuma `rateLimitKey` é informada — ou seja, é o
 * header que a própria Vercel injeta de forma confiável na edge), com
 * `x-forwarded-for` (primeiro IP da cadeia) como segunda tentativa. Nunca
 * lança — na ausência de qualquer header (ex.: `next dev` local, sem
 * proxy), devolve um valor fixo não-vazio, para nunca quebrar o cálculo da
 * chave.
 */
export function extrairIpCliente(request: NextRequest | Request): string {
  const headers = request.headers
  const xRealIp = headers.get('x-real-ip')
  if (xRealIp) return xRealIp

  const xForwardedFor = headers.get('x-forwarded-for')
  const primeiroIp = xForwardedFor?.split(',')[0]?.trim()
  if (primeiroIp) return primeiroIp

  return 'sem-ip-identificavel'
}

/** SHA-256 em hex — Web Crypto (`globalThis.crypto.subtle`), disponível tanto no runtime Node quanto Edge da Vercel. */
async function sha256Hex(valor: string): Promise<string> {
  const dados = new TextEncoder().encode(valor)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', dados)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Ponto único de verificação de rate limit para ações sensíveis (login,
 * cadastro, reenvio de assinatura). Nunca duplicar esta lógica em cada rota
 * — todas devem chamar este helper.
 *
 * Comportamento em falha de infraestrutura (fail-open documentado —
 * ver Etapa security/rate-limit, decisão registrada em
 * docs/ARQUITETURA.md): se `checkRateLimit()` lançar uma exceção (erro de
 * rede, resposta inesperada do Firewall etc.), esta função NUNCA propaga o
 * erro — registra um `console.error` seguro (sem identificador bruto, sem
 * payload) e devolve `limited: false`, para que uma indisponibilidade
 * temporária do Firewall nunca vire indisponibilidade total do login/
 * cadastro. Uma determinação REAL de rate limit (`rateLimited: true`, ou
 * `error: 'blocked'`) nunca é tratada como falha — sempre bloqueia (fail-
 * closed), porque nesses casos o Firewall respondeu com sucesso, só que
 * dizendo "bloquear".
 */
export async function checkSensitiveRateLimit({
  request,
  namespace,
  identifier,
}: SensitiveRateLimitInput): Promise<SensitiveRateLimitResult> {
  const identificadorNormalizado = identifier.trim().toLowerCase()
  const hash = await sha256Hex(identificadorNormalizado)
  const rateLimitKey = `${namespace}:${hash}`

  try {
    const { rateLimited } = await checkRateLimit(RATE_LIMIT_ID, {
      request: request as Request,
      rateLimitKey,
    })
    return { limited: rateLimited }
  } catch (err) {
    // Fail-open deliberado — ver docstring acima. Nunca loga `identifier`
    // bruto nem `rateLimitKey` (que já é um hash, mas mesmo assim não há
    // motivo para logar em toda falha).
    console.error(
      `[RateLimit] Falha ao consultar o Vercel Firewall para o namespace "${namespace}" — seguindo sem bloquear (fail-open):`,
      err instanceof Error ? err.message : err
    )
    return { limited: false }
  }
}

/** Header padrão de resposta 429 desta aplicação — sempre a mesma janela da regra única (600s). */
export const RATE_LIMIT_RETRY_AFTER_SECONDS = 600

/** Corpo de resposta 429 padronizado — mensagem genérica, nunca revela conta/limite/qual camada disparou. */
export const RATE_LIMIT_RESPONSE_BODY = {
  error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.',
}
