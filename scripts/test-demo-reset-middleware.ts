// scripts/test-demo-reset-middleware.ts
//
// Matriz completa MIDDLEWARE + HANDLER de POST /api/internal/demo-reset,
// depois da correção que isentou esta rota (caminho + método exatos) do
// gate de sessão em src/middleware.ts. Objetivo: provar que, mesmo sem
// esse gate, a rota continua totalmente protegida — só que agora por UMA
// única credencial real (DEMO_RESET_SECRET), nunca por cookie de sessão,
// nem mesmo a sessão do Administrador Demo.
//
// Cada caso chama `middleware()` de verdade (mesmo padrão de
// scripts/test-demo-status-middleware.ts) e, quando o middleware deixa
// passar, encadeia a chamada REAL ao handler da rota (nunca uma
// reimplementação) — exatamente o caminho que uma requisição HTTP real
// percorreria.
//
// `resetarDatasetDemo()` (src/lib/demo/dataset.ts) é mockada como no-op:
// este arquivo testa o GATE DE AUTENTICAÇÃO da rota, não a lógica de
// reset do dataset (que não toca banco algum nestes testes, por design —
// nenhuma infraestrutura é provisionada).
//
// Executar com: npm run test:demo-reset-middleware

import type { NextRequest } from 'next/server'

export {}

let failures = 0

function assert(condition: boolean, label: string, detalhe?: unknown) {
  if (condition) {
    console.log(`OK   - ${label}`)
  } else {
    failures++
    console.error(`FALHA - ${label}${detalhe !== undefined ? ` (${JSON.stringify(detalhe)})` : ''}`)
  }
}

const CAMINHO = '/api/internal/demo-reset'

function fakeMiddlewareRequest(token?: string): NextRequest {
  return {
    nextUrl: { pathname: CAMINHO },
    url: `http://localhost:3000${CAMINHO}`,
    method: 'POST',
    cookies: { get: (name: string) => (name === 'session' && token ? { value: token } : undefined) },
  } as unknown as NextRequest
}

async function main() {
  process.env.APP_URL = 'http://localhost:3000'

  // --- Mock de @vercel/firewall (fail-open — o alvo aqui é o gate de
  // secret/sessão, não o rate limit, já coberto por scripts/test-rate-limit.ts).
  const firewallPath = require.resolve('@vercel/firewall')
  require.cache[firewallPath] = {
    id: firewallPath,
    filename: firewallPath,
    loaded: true,
    exports: {
      checkRateLimit: async () => ({ rateLimited: false }),
      unstable_checkRateLimit: async () => ({ rateLimited: false }),
    },
  } as unknown as NodeModule

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { middleware } = require('../src/middleware')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const authModule = require('../src/lib/auth')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { prisma } = require('../src/lib/prisma')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const datasetModule = require('../src/lib/demo/dataset')

  // Só o GATE é testado aqui — resetarDatasetDemo() nunca é exercitada de
  // verdade (nenhum banco é tocado). prisma.$transaction é um passthrough
  // simples (mesmo padrão de scripts/test-demo-mode-routes.ts).
  datasetModule.resetarDatasetDemo = async () => {}
  prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)

  const ADMIN_DEMO_TOKEN = 'token-admin-demo'
  authModule.verifyToken = async (token: string) =>
    token === ADMIN_DEMO_TOKEN
      ? { id: 'user-admin-demo', nome: 'Administrador Demo', email: 'admin@example.com', permissao: 'administrador', podeSerGestor: true, podeSolicitarParaOutro: false, versaoSessao: 0 }
      : null

  function reqComSecret(secret?: string) {
    return { headers: { get: (k: string) => (k.toLowerCase() === 'x-demo-reset-secret' ? secret ?? null : null) } } as any
  }

  async function chamarHandler(secret?: string) {
    delete require.cache[require.resolve('../src/app/api/internal/demo-reset/route')]
    const rota = require('../src/app/api/internal/demo-reset/route')
    return rota.POST(reqComSecret(secret))
  }

  /** Encadeia middleware (sem sessão) + handler real, mesmo caminho que uma requisição HTTP real percorre. */
  async function chamarViaMiddlewareSemSessao(secret?: string) {
    const resMiddleware = await middleware(fakeMiddlewareRequest())
    assert(resMiddleware.status !== 401, `middleware deixa passar POST ${CAMINHO} sem sessão`, resMiddleware.status)
    return chamarHandler(secret)
  }

  const SECRET_CORRETO = 'segredo-correto-de-teste-32-bytes-ok'

  // =========================================================================
  // DEMO_MODE=true
  // =========================================================================
  process.env.DEMO_MODE = 'true'
  process.env.DEMO_RESET_SECRET = SECRET_CORRETO

  {
    const res = await chamarViaMiddlewareSemSessao(undefined)
    assert(res.status === 401, 'sem cookie + sem secret → chega ao handler e é bloqueado pelo secret (401)', res.status)
  }

  {
    const res = await chamarViaMiddlewareSemSessao('valor-totalmente-errado')
    assert(res.status === 401, 'sem cookie + secret incorreto → bloqueado (401)', res.status)
  }

  {
    const res = await chamarViaMiddlewareSemSessao(SECRET_CORRETO)
    assert(res.status === 200, 'sem cookie + secret correto → permitido (200)', res.status)
    const corpo = await res.json()
    assert(typeof corpo.resetadoEm === 'string', 'resposta de sucesso inclui resetadoEm', corpo)
  }

  {
    // Cookie de sessão VÁLIDO presente (não-admin, mas isso nem importa —
    // é o ponto do teste seguinte) + sem secret → o middleware já deixa
    // passar por caminho+método, então a presença/validade do cookie é
    // irrelevante; o handler nunca olha para ele.
    const resMiddleware = await middleware(fakeMiddlewareRequest('qualquer-token-invalido-mesmo'))
    assert(resMiddleware.status !== 401, `middleware deixa passar POST ${CAMINHO} mesmo com cookie presente (não é isso que decide)`, resMiddleware.status)
    const res = await chamarHandler(undefined)
    assert(res.status === 401, 'cookie de sessão presente + sem secret → bloqueado (401) — cookie nunca é avaliado pelo handler', res.status)
  }

  {
    // Administrador Demo AUTENTICADO (sessão real e válida) + sem secret.
    // Este é o caso central do requisito "cookie de sessão ≠ autorização
    // para reset" — mesmo a conta mais privilegiada da demo não consegue
    // resetar só por estar logada.
    const resMiddleware = await middleware(fakeMiddlewareRequest(ADMIN_DEMO_TOKEN))
    assert(resMiddleware.status !== 401, 'middleware deixa passar POST com sessão do Administrador Demo (irrelevante para a decisão)', resMiddleware.status)
    const res = await chamarHandler(undefined)
    assert(res.status === 401, 'Administrador Demo autenticado + sem secret → BLOQUEADO (sessão nunca substitui o secret)', res.status)
  }

  {
    // Administrador Demo autenticado + secret correto → mesmo assim
    // permitido (o secret é quem decide, não a ausência/presença de sessão).
    const res = await chamarHandler(SECRET_CORRETO)
    assert(res.status === 200, 'Administrador Demo autenticado + secret correto → permitido (200) — secret é a única credencial que importa', res.status)
  }

  delete process.env.DEMO_RESET_SECRET
  delete process.env.DEMO_MODE

  // =========================================================================
  // DEMO_MODE=false — indisponível mesmo com secret correto
  // =========================================================================
  {
    process.env.DEMO_MODE = 'false'
    process.env.DEMO_RESET_SECRET = SECRET_CORRETO

    const resMiddleware = await middleware(fakeMiddlewareRequest())
    assert(resMiddleware.status !== 401, 'middleware deixa passar POST mesmo com DEMO_MODE=false (a decisão de disponibilidade é da rota)', resMiddleware.status)

    const res = await chamarHandler(SECRET_CORRETO)
    assert(res.status === 404, 'DEMO_MODE=false, mesmo com secret correto → 404 (rota indisponível fora da demo)', res.status)

    delete process.env.DEMO_RESET_SECRET
    delete process.env.DEMO_MODE
  }

  console.log(`\n${failures === 0 ? '✅ Todos os testes passaram.' : `❌ ${failures} teste(s) falharam.`}`)
  if (failures > 0) process.exit(1)
}

main()
