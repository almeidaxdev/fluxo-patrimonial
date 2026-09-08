// src/lib/auth.ts
import { SignJWT, jwtVerify } from 'jose'
import { cookies } from 'next/headers'
import { SessionUser } from '@/types'

const TAMANHO_MINIMO_SECRET = 32

// Avaliada de forma preguiçosa (só na primeira assinatura/verificação real),
// nunca no escopo do módulo — o Next.js importa este arquivo durante
// `next build` (coleta de rotas/middleware), e o build pode rodar num
// ambiente sem as variáveis de runtime configuradas. Falhar aqui é
// intencional (fail-fast), mas só quando o token realmente for usado.
let secretCache: Uint8Array | null = null

function getSecret(): Uint8Array {
  if (secretCache) return secretCache

  const valor = process.env.JWT_SECRET
  if (!valor || valor.trim().length < TAMANHO_MINIMO_SECRET) {
    throw new Error(
      `JWT_SECRET ausente ou fraco: defina uma variável de ambiente JWT_SECRET com pelo menos ${TAMANHO_MINIMO_SECRET} caracteres (ex.: openssl rand -base64 32).`
    )
  }

  secretCache = new TextEncoder().encode(valor)
  return secretCache
}

// Etapa security/session-revocation: reduzido de 7d para 24h. Sem
// revalidação server-side (getSession() só verifica assinatura/expiração,
// nunca reconsulta o banco), o JWT era a única barreira de tempo contra um
// token comprometido — 7 dias era uma janela grande demais dado que a
// revogação real (versaoSessao) só é aplicada nas rotas de mutação, não em
// toda navegação (ver getValidatedMutationSession(),
// src/lib/session-validation.ts, e docs/ARQUITETURA.md). Sem refresh token
// nesta etapa — o usuário precisa logar de novo após 24h.
export async function signToken(payload: SessionUser): Promise<string> {
  return await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(getSecret())
}

export async function verifyToken(token: string): Promise<SessionUser | null> {
  const secret = getSecret()
  try {
    const { payload } = await jwtVerify(token, secret)
    return payload as unknown as SessionUser
  } catch {
    return null
  }
}

export async function getSession(): Promise<SessionUser | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get('session')?.value
  if (!token) return null
  return verifyToken(token)
}

export async function setSession(user: SessionUser): Promise<void> {
  const token = await signToken(user)
  const cookieStore = await cookies()
  cookieStore.set('session', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24, // 24 hours (Etapa security/session-revocation — era 7 dias)
    path: '/',
  })
}

export async function clearSession(): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.delete('session')
}
