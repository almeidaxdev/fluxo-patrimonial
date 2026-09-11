// scripts/test-demo-reset-cron.ts
//
// Matriz de GET /api/internal/demo-reset (mecanismo exclusivo do Vercel
// Cron, ver vercel.json) + regressão cruzada com o POST manual
// (DEMO_RESET_SECRET, ver scripts/test-demo-reset-middleware.ts). Prova
// que:
//   - os dois secrets (DEMO_RESET_SECRET e CRON_SECRET) nunca autorizam o
//     verbo um do outro;
//   - o GET nunca executa a restauração do dataset mais de uma vez por
//     chamada autenticada;
//   - o middleware libera só GET/POST nesse caminho exato — qualquer
//     outro verbo, ou qualquer outra rota sob /api/internal/, continua
//     exigindo sessão normalmente.
//
// `resetarDatasetDemo()` (src/lib/demo/dataset.ts) é mockada como um
// contador de chamadas: este arquivo testa o GATE DE AUTENTICAÇÃO e o
// não-duplicação de execução, não a lógica de reset do dataset (que não
// toca banco algum nestes testes, por design — nenhuma infraestrutura é
// provisionada).
//
// Executar com: npm run test:demo-reset-cron

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

function fakeMiddlewareRequest(method: string, pathname: string = CAMINHO): NextRequest {
  return {
    nextUrl: { pathname },
    url: `http://localhost:3000${pathname}`,
    method,
    cookies: { get: () => undefined },
  } as unknown as NextRequest
}

async function main() {
  process.env.APP_URL = 'http://localhost:3000'

  // --- Mock de @vercel/firewall (fail-open — o alvo aqui é o gate de
  // secret/sessão e a não-duplicação de execução, não o rate limit do
  // POST, já coberto por scripts/test-rate-limit.ts).
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
  const datasetModule = require('../src/lib/demo/dataset')

  let chamadasReset = 0
  datasetModule.resetarDatasetDemo = async () => {
    chamadasReset++
  }
  prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)

  function reqComHeaders(opts: { authorization?: string; demoResetSecret?: string } = {}) {
    return {
      headers: {
        get: (k: string) => {
          const chave = k.toLowerCase()
          if (chave === 'authorization') return opts.authorization ?? null
          if (chave === 'x-demo-reset-secret') return opts.demoResetSecret ?? null
          return null
        },
      },
    } as any
  }

  async function chamarGET(opts?: { authorization?: string; demoResetSecret?: string }) {
    delete require.cache[require.resolve('../src/app/api/internal/demo-reset/route')]
    const rota = require('../src/app/api/internal/demo-reset/route')
    return rota.GET(reqComHeaders(opts))
  }

  async function chamarPOST(opts?: { authorization?: string; demoResetSecret?: string }) {
    delete require.cache[require.resolve('../src/app/api/internal/demo-reset/route')]
    const rota = require('../src/app/api/internal/demo-reset/route')
    return rota.POST(reqComHeaders(opts))
  }

  const CRON_SECRET_CORRETO = 'cron-segredo-correto-de-teste-32-bytes'
  const DEMO_RESET_SECRET_CORRETO = 'demo-reset-segredo-correto-de-teste'

  // =========================================================================
  // DEMO_MODE=false — GET indisponível mesmo com Bearer correto
  // =========================================================================
  {
    process.env.DEMO_MODE = 'false'
    process.env.CRON_SECRET = CRON_SECRET_CORRETO

    const res = await chamarGET({ authorization: `Bearer ${CRON_SECRET_CORRETO}` })
    assert(res.status === 404, '(1) DEMO_MODE=false, mesmo com Bearer correto → 404 (rota indisponível fora da demo)', res.status)

    delete process.env.CRON_SECRET
    delete process.env.DEMO_MODE
  }

  // =========================================================================
  // DEMO_MODE=true
  // =========================================================================
  process.env.DEMO_MODE = 'true'

  {
    // (2) CRON_SECRET ausente no ambiente → fail-closed, mesmo com um
    // Authorization qualquer.
    delete process.env.CRON_SECRET
    const res = await chamarGET({ authorization: 'Bearer qualquer-coisa-nao-deveria-importar' })
    assert(res.status === 503, '(2) CRON_SECRET ausente no ambiente → 503 fail-closed', res.status)
    const corpo = await res.json()
    assert(
      JSON.stringify(corpo).toLowerCase().indexOf('qualquer-coisa-nao-deveria-importar') === -1,
      'resposta de CRON_SECRET ausente não vaza o token recebido',
      corpo
    )
  }

  process.env.CRON_SECRET = CRON_SECRET_CORRETO

  {
    // (3) Authorization ausente → 401.
    const res = await chamarGET()
    assert(res.status === 401, '(3) Authorization ausente → 401', res.status)
  }

  {
    // (4) Authorization incorreto → 401 (valor errado e também formato
    // sem o prefixo "Bearer ").
    const resValorErrado = await chamarGET({ authorization: 'Bearer valor-totalmente-errado' })
    assert(resValorErrado.status === 401, '(4) Authorization com Bearer incorreto → 401', resValorErrado.status)

    const resSemPrefixo = await chamarGET({ authorization: CRON_SECRET_CORRETO })
    assert(resSemPrefixo.status === 401, '(4) Authorization sem o prefixo "Bearer " → 401 (formato exigido, não só o valor)', resSemPrefixo.status)
  }

  {
    // (9) DEMO_RESET_SECRET correto no header errado (x-demo-reset-secret)
    // NÃO autoriza GET — o GET só lê Authorization: Bearer.
    process.env.DEMO_RESET_SECRET = DEMO_RESET_SECRET_CORRETO
    const res = await chamarGET({ demoResetSecret: DEMO_RESET_SECRET_CORRETO })
    assert(res.status === 401, '(9) DEMO_RESET_SECRET correto em x-demo-reset-secret NÃO autoriza GET → 401', res.status)
  }

  {
    // (5)+(6) Bearer correto → executa o reset exatamente uma vez.
    const chamadasAntes = chamadasReset
    const res = await chamarGET({ authorization: `Bearer ${CRON_SECRET_CORRETO}` })
    assert(res.status === 200, '(5) Bearer correto → 200', res.status)
    assert(chamadasReset === chamadasAntes + 1, '(6) Bearer correto → chama a função central de reset exatamente uma vez (não duplica)', chamadasReset)
    const corpo = await res.json()
    assert(typeof corpo.resetadoEm === 'string', 'resposta de sucesso do GET inclui resetadoEm', corpo)
  }

  {
    // (8) CRON_SECRET (via Authorization: Bearer) NÃO autoriza POST — o
    // POST continua exigindo DEMO_RESET_SECRET no header
    // x-demo-reset-secret, que aqui está ausente.
    const res = await chamarPOST({ authorization: `Bearer ${CRON_SECRET_CORRETO}` })
    assert(res.status === 401, '(8) Bearer CRON_SECRET correto NÃO autoriza POST → 401 (x-demo-reset-secret ausente)', res.status)
  }

  {
    // (7) Regressão: POST continua funcionando exatamente como antes, com
    // DEMO_RESET_SECRET — CRON_SECRET não interfere nele.
    const chamadasAntes = chamadasReset
    const res = await chamarPOST({ demoResetSecret: DEMO_RESET_SECRET_CORRETO })
    assert(res.status === 200, '(7) POST com DEMO_RESET_SECRET correto continua funcionando (200)', res.status)
    assert(chamadasReset === chamadasAntes + 1, 'POST com secret correto → chama a função central de reset exatamente uma vez', chamadasReset)
  }

  delete process.env.DEMO_RESET_SECRET
  delete process.env.CRON_SECRET
  delete process.env.DEMO_MODE

  // =========================================================================
  // (10) Middleware — só GET/POST liberados nesse caminho exato
  // =========================================================================
  {
    const resGet = await middleware(fakeMiddlewareRequest('GET'))
    assert(resGet.status !== 401, '(10) middleware libera GET /api/internal/demo-reset sem sessão', resGet.status)

    const resPost = await middleware(fakeMiddlewareRequest('POST'))
    assert(resPost.status !== 401, '(10) middleware libera POST /api/internal/demo-reset sem sessão', resPost.status)
  }

  for (const metodo of ['PUT', 'PATCH', 'DELETE']) {
    const res = await middleware(fakeMiddlewareRequest(metodo))
    assert(res.status === 401, `(10) middleware NÃO libera ${metodo} /api/internal/demo-reset sem sessão (401)`, res.status)
  }

  {
    // Outra rota qualquer sob /api/internal/ continua exigindo sessão
    // normalmente, mesmo em GET/POST — a isenção é do CAMINHO EXATO, não
    // de um prefixo.
    const resGet = await middleware(fakeMiddlewareRequest('GET', '/api/internal/outra-rota'))
    assert(resGet.status === 401, '(10) middleware continua exigindo sessão para GET /api/internal/outra-rota', resGet.status)

    const resPost = await middleware(fakeMiddlewareRequest('POST', '/api/internal/outra-rota'))
    assert(resPost.status === 401, '(10) middleware continua exigindo sessão para POST /api/internal/outra-rota', resPost.status)
  }

  console.log(`\n${failures === 0 ? '✅ Todos os testes passaram.' : `❌ ${failures} teste(s) falharam.`}`)
  if (failures > 0) process.exit(1)
}

main()
