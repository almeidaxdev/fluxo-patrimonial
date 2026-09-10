// scripts/test-demo-status-middleware.ts
//
// Correção do bug relatado: GET /api/demo/status devolvia
// {"message":"Não autorizado."} (401) mesmo com DEMO_MODE=true, porque
// src/middleware.ts exige um cookie de sessão para QUALQUER rota /api/*
// que não seja /login, /cadastro ou /api/auth/* — antes mesmo do handler
// da rota (src/app/api/demo/status/route.ts) rodar. O mesmo valia para
// POST /api/demo/entrar. Os testes em scripts/test-demo-mode-routes.ts
// chamam os handlers de rota DIRETAMENTE (`rota.GET()`/`rota.POST()`),
// contornando o middleware inteiramente — por isso esse bug não foi
// detectado antes: middleware.ts é uma camada de execução separada do
// Next.js, que só roda de fato numa requisição HTTP real, nunca ao chamar
// a função exportada do route.ts diretamente.
//
// Este arquivo testa a camada que faltava: chama `middleware()`
// (src/middleware.ts) de verdade, mesmo padrão de mock de
// scripts/test-patrimonio-operational-ux.ts (fakeRequest + mock de
// verifyToken) — sem cookie/sessão nenhuma, exatamente como um visitante
// da demo pública que ainda não fez login.
//
// Cobre:
//   - GET /api/demo/status SEM sessão, DEMO_MODE=true → passa pelo
//     middleware (não é bloqueado) e a rota real devolve 200 {enabled:true}.
//   - GET /api/demo/status SEM sessão, DEMO_MODE=false → idem, {enabled:false}.
//   - POST /api/demo/entrar SEM sessão, DEMO_MODE=true → passa pelo
//     middleware e a rota real cria a sessão da conta demo.
//   - POST /api/demo/entrar SEM sessão, DEMO_MODE=false → passa pelo
//     middleware (nunca bloqueado ali) mas a ROTA devolve 404 (indisponível
//     fora da demo — comportamento já existente, preservado).
//   - POST /api/internal/demo-reset SEM sessão → o MIDDLEWARE não bloqueia
//     mais (exceção cirúrgica caminho+método exatos — ver
//     scripts/test-demo-reset-middleware.ts para a matriz completa
//     middleware+handler dessa rota, incluindo a prova de que sessão nunca
//     substitui o secret).
//   - GET /api/internal/demo-reset (método errado) SEM sessão → continua
//     bloqueado pelo middleware (a exceção é só para POST).
//   - Uma rota administrativa qualquer (GET /api/colaboradores) SEM sessão
//     → continua bloqueada pelo middleware, comportamento intacto.
//
// Executar com: npm run test:demo-status-middleware

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

function fakeRequest(pathname: string, method: string = 'GET'): NextRequest {
  return {
    nextUrl: { pathname },
    url: `http://localhost:3000${pathname}`,
    method,
    cookies: { get: () => undefined }, // nunca há cookie de sessão nestes testes
  } as unknown as NextRequest
}

async function main() {
  process.env.APP_URL = 'http://localhost:3000'

  // --- Mock de @vercel/firewall (fail-open — o alvo aqui é o gate de
  // sessão do middleware, não o rate limit, já coberto por
  // scripts/test-rate-limit.ts). Ver comentário completo em test-rate-limit.ts.
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
  const { prisma } = require('../src/lib/prisma')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const authModule = require('../src/lib/auth')

  authModule.setSession = async () => {}

  const ADMIN_DEMO_ID = 'user-admin-demo-1'
  prisma.user = {
    findUnique: async ({ where }: { where: { id?: string; email?: string } }) => {
      if (where.email === 'admin@example.com' || where.id === ADMIN_DEMO_ID) {
        return {
          id: ADMIN_DEMO_ID,
          nome: 'Administrador Demo',
          email: 'admin@example.com',
          permissao: 'administrador',
          ativo: true,
          podeSerGestor: true,
          podeSolicitarParaOutro: false,
          versaoSessao: 0,
        }
      }
      return null
    },
  }

  function chamarRota(caminhoRelativo: string) {
    const caminho = `../src/app/api/${caminhoRelativo}/route`
    delete require.cache[require.resolve(caminho)]
    return require(caminho)
  }

  // =========================================================================
  // GET /api/demo/status — SEM sessão, nos dois estados de DEMO_MODE
  // =========================================================================
  for (const [demoMode, esperado] of [['true', true], ['false', false]] as const) {
    process.env.DEMO_MODE = demoMode

    const resMiddleware = await middleware(fakeRequest('/api/demo/status'))
    assert(
      resMiddleware.status !== 401,
      `middleware NÃO bloqueia GET /api/demo/status sem sessão (DEMO_MODE=${demoMode})`,
      resMiddleware.status
    )

    const resRota = await chamarRota('demo/status').GET()
    assert(resRota.status === 200, `GET /api/demo/status (DEMO_MODE=${demoMode}) devolve 200`, resRota.status)
    const corpo = await resRota.json()
    assert(corpo.enabled === esperado, `GET /api/demo/status (DEMO_MODE=${demoMode}) → {"enabled":${esperado}}`, corpo)
    assert(
      Object.keys(corpo).length === 1 && 'enabled' in corpo,
      `GET /api/demo/status não expõe nenhum campo além de "enabled"`,
      corpo
    )
  }
  delete process.env.DEMO_MODE

  // =========================================================================
  // POST /api/demo/entrar — SEM sessão
  // =========================================================================
  {
    process.env.DEMO_MODE = 'true'
    const resMiddleware = await middleware(fakeRequest('/api/demo/entrar'))
    assert(resMiddleware.status !== 401, 'middleware NÃO bloqueia POST /api/demo/entrar sem sessão (DEMO_MODE=true)', resMiddleware.status)

    const req = { headers: { get: () => null } } as any
    const resRota = await chamarRota('demo/entrar').POST(req)
    assert(resRota.status === 200, 'POST /api/demo/entrar sem sessão, DEMO_MODE=true → cria sessão (200)', resRota.status)
    const corpo = await resRota.json()
    assert(corpo.user?.email === 'admin@example.com', 'Sessão criada é da conta demo configurada', corpo.user?.email)
  }

  {
    process.env.DEMO_MODE = 'false'
    const resMiddleware = await middleware(fakeRequest('/api/demo/entrar'))
    assert(
      resMiddleware.status !== 401,
      'middleware NÃO bloqueia POST /api/demo/entrar sem sessão mesmo com DEMO_MODE=false (o 404 é decisão da ROTA, não do middleware)',
      resMiddleware.status
    )

    const req = { headers: { get: () => null } } as any
    const resRota = await chamarRota('demo/entrar').POST(req)
    assert(resRota.status === 404, 'POST /api/demo/entrar sem sessão, DEMO_MODE=false → 404 (indisponível, decisão da rota)', resRota.status)
  }
  delete process.env.DEMO_MODE

  // =========================================================================
  // /api/internal/demo-reset — a proteção de sessão do middleware foi
  // deliberadamente removida SÓ para POST neste caminho exato (a
  // autenticação de verdade passou a ser inteiramente do handler, via
  // secret — ver matriz completa em
  // scripts/test-demo-reset-middleware.ts). Aqui confirmamos só o
  // contrato do middleware: POST passa, GET (método errado) continua
  // exigindo sessão normalmente.
  // =========================================================================
  {
    process.env.DEMO_MODE = 'true'
    const resPost = await middleware(fakeRequest('/api/internal/demo-reset', 'POST'))
    assert(resPost.status !== 401, 'middleware NÃO bloqueia POST /api/internal/demo-reset sem sessão (exceção cirúrgica)', resPost.status)

    const resGet = await middleware(fakeRequest('/api/internal/demo-reset', 'GET'))
    assert(resGet.status === 401, 'middleware CONTINUA bloqueando GET /api/internal/demo-reset sem sessão (exceção é só para POST)', resGet.status)

    const resOutraRota = await middleware(fakeRequest('/api/internal/outra-rota', 'POST'))
    assert(
      resOutraRota.status === 401,
      'middleware CONTINUA bloqueando POST /api/internal/outra-rota sem sessão (exceção é só o caminho exato de demo-reset, nunca prefixo /api/internal/*)',
      resOutraRota.status
    )
    delete process.env.DEMO_MODE
  }

  // =========================================================================
  // Rota administrativa qualquer — comportamento intacto (continua exigindo
  // sessão via middleware, nada foi enfraquecido).
  // =========================================================================
  {
    const res = await middleware(fakeRequest('/api/colaboradores'))
    assert(res.status === 401, 'middleware continua bloqueando GET /api/colaboradores sem sessão (comportamento intacto)', res.status)
  }

  console.log(`\n${failures === 0 ? '✅ Todos os testes passaram.' : `❌ ${failures} teste(s) falharam.`}`)
  if (failures > 0) process.exit(1)
}

main()
