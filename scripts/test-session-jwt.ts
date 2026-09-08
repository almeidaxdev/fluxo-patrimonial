// scripts/test-session-jwt.ts
//
// Teste manual (mesmo padrão de scripts/test-rate-limit.ts) da Etapa
// security/session-revocation — parte JWT: signToken()/verifyToken()/
// setSession() de src/lib/auth.ts.
//
// Chama as funções REAIS de src/lib/auth.ts (jose de verdade, sem mock) —
// só `next/headers` (cookies()) é substituído por um cookie-store fake em
// memória, necessário porque cookies() do App Router só existe dentro de um
// request real (mesma técnica documentada em
// scripts/test-colaboradores-reset-senha.ts: "login chama setSession(), que
// usa cookies() de next/headers — fora de um request real isso lançaria").
// Aqui o cookie-store fake CAPTURA os argumentos em vez de ser um no-op,
// para o teste D poder inspecionar `maxAge` de verdade.
//
// Cobre:
//   A) versaoSessao é gravada no JWT e sobrevive ao round-trip sign→verify;
//   B) exp do token é ~24h de vida (86400s), não mais 7d;
//   C) token assinado SEM a claim versaoSessao (simula um token pré-S5) é
//      detectável — verifyToken() ainda decodifica (assinatura válida), mas
//      typeof payload.versaoSessao !== 'number', que é exatamente a
//      checagem usada por getValidatedMutationSession() para rejeitar sem
//      fallback ?? 0 (ver src/lib/session-validation.ts);
//   D) setSession() grava o cookie "session" com maxAge=86400 (24h),
//      httpOnly, sameSite=lax;
//   E) verifyToken() com token corrompido/lixo retorna null;
//   F) verifyToken() com token JÁ EXPIRADO (exp no passado) retorna null.
//
// Executar com: npm run test:session-jwt

export {}

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'a'.repeat(32)

// eslint-disable-next-line @typescript-eslint/no-var-requires
const nextHeaders = require('next/headers')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const jose = require('jose')

let failures = 0

function assert(condition: boolean, label: string, detalhe?: unknown) {
  if (condition) {
    console.log(`OK   - ${label}`)
  } else {
    failures++
    console.error(`FALHA - ${label}${detalhe !== undefined ? ` (${JSON.stringify(detalhe)})` : ''}`)
  }
}

const SESSION_USER = {
  id: 'user-jwt-1',
  nome: 'Fulano JWT',
  email: 'fulano.jwt@example.com',
  permissao: 'colaborador' as const,
  podeSerGestor: false,
  podeSolicitarParaOutro: false,
  versaoSessao: 3,
}

let cookieSetCalls: Array<{ name: string; value: string; options: Record<string, unknown> }>
let cookieStoreFake: {
  set: (name: string, value: string, options: Record<string, unknown>) => void
  get: (name: string) => { value: string } | undefined
  delete: (name: string) => void
}
let cookieValorAtual: string | undefined

function instalarMockCookies() {
  cookieSetCalls = []
  cookieValorAtual = undefined
  cookieStoreFake = {
    set: (name, value, options) => {
      cookieSetCalls.push({ name, value, options })
      if (name === 'session') cookieValorAtual = value
    },
    get: (name) => (name === 'session' && cookieValorAtual ? { value: cookieValorAtual } : undefined),
    delete: (name) => {
      if (name === 'session') cookieValorAtual = undefined
    },
  }
  nextHeaders.cookies = async () => cookieStoreFake
}

async function main() {
  instalarMockCookies()
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const authModule = require('../src/lib/auth')

  // --- A) versaoSessao sobrevive ao round-trip sign→verify -----------------
  {
    const token = await authModule.signToken(SESSION_USER)
    const decodificado = await authModule.verifyToken(token)
    assert(decodificado !== null, 'A) verifyToken() decodifica um token recém-assinado', decodificado)
    assert(decodificado?.versaoSessao === 3, 'A) claim versaoSessao sobrevive ao round-trip (valor exato)', decodificado?.versaoSessao)
    assert(typeof decodificado?.versaoSessao === 'number', 'A) versaoSessao decodificada é do tipo number', typeof decodificado?.versaoSessao)
  }

  // --- B) expiração do token é ~24h (86400s), não mais 7 dias ---------------
  {
    const token = await authModule.signToken(SESSION_USER)
    const partesJwt = token.split('.')
    const payloadBruto = JSON.parse(Buffer.from(partesJwt[1], 'base64url').toString('utf8'))
    const validadeSegundos = payloadBruto.exp - payloadBruto.iat
    assert(validadeSegundos === 86400, 'B) exp - iat é exatamente 86400s (24h)', validadeSegundos)
    assert(validadeSegundos < 7 * 86400, 'B) validade é MENOR que os 7 dias antigos (regressão de segurança se voltar a crescer)', validadeSegundos)
  }

  // --- C) token pré-S5 (sem a claim versaoSessao) é detectável -------------
  // Simula um token emitido ANTES desta etapa: mesma assinatura/algoritmo,
  // mesmo emissor, só que sem o campo versaoSessao no payload — exatamente o
  // formato que um usuário logado antes do deploy desta etapa carregaria.
  {
    const { versaoSessao, ...payloadSemVersao } = SESSION_USER
    const secret = new TextEncoder().encode(process.env.JWT_SECRET)
    const tokenPreS5 = await new jose.SignJWT({ ...payloadSemVersao })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('24h')
      .sign(secret)

    const decodificado = await authModule.verifyToken(tokenPreS5)
    assert(decodificado !== null, 'C) verifyToken() ainda decodifica um token pré-S5 (assinatura continua válida)', decodificado)
    assert(
      typeof decodificado?.versaoSessao !== 'number',
      'C) claim versaoSessao está ausente — exatamente a condição que getValidatedMutationSession() usa para rejeitar (sem fallback ?? 0)',
      decodificado
    )
    // Referência cruzada: garante que este teste não ficou desatualizado
    // em relação à checagem de fato usada em produção.
    const sessionValidationModule = require('../src/lib/session-validation')
    assert(
      typeof sessionValidationModule.getValidatedMutationSession === 'function',
      'C) getValidatedMutationSession() existe e é o ponto real que aplica esta rejeição (ver scripts/test-session-revalidation.ts para o comportamento fim-a-fim)',
      undefined
    )
  }

  // --- D) setSession() grava cookie "session" com maxAge=86400 (24h) --------
  {
    instalarMockCookies()
    await authModule.setSession(SESSION_USER)
    assert(cookieSetCalls.length === 1, 'D) exatamente 1 cookie é gravado por setSession()', cookieSetCalls.length)
    const chamada = cookieSetCalls[0]
    assert(chamada?.name === 'session', 'D) o cookie gravado se chama "session"', chamada?.name)
    assert(chamada?.options.maxAge === 86400, 'D) maxAge do cookie é 86400s (24h) — era 604800 (7d) antes desta etapa', chamada?.options.maxAge)
    assert(chamada?.options.httpOnly === true, 'D) cookie continua httpOnly', chamada?.options.httpOnly)
    assert(chamada?.options.sameSite === 'lax', 'D) cookie continua sameSite=lax', chamada?.options.sameSite)
  }

  // --- E) verifyToken() com token corrompido/lixo retorna null --------------
  {
    const resultado = await authModule.verifyToken('isto.nao.eh-um-jwt-valido')
    assert(resultado === null, 'E) verifyToken() com token corrompido retorna null (nunca lança)', resultado)
  }

  // --- F) verifyToken() com token já expirado retorna null ------------------
  {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET)
    const agora = Math.floor(Date.now() / 1000)
    const tokenExpirado = await new jose.SignJWT({ ...SESSION_USER })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(agora - 100000)
      .setExpirationTime(agora - 1) // já expirado
      .sign(secret)

    const resultado = await authModule.verifyToken(tokenExpirado)
    assert(resultado === null, 'F) verifyToken() com token expirado retorna null', resultado)
  }

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) de JWT (security/session-revocation) falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes de JWT (security/session-revocation) passaram. Nenhum cookie real foi gravado, nenhum banco foi acessado.')
}

main().catch((err) => {
  console.error('Falha inesperada ao executar os testes de JWT:', err instanceof Error ? err.message : err)
  process.exit(1)
})
