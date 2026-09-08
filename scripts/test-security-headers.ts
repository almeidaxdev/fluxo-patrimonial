// scripts/test-security-headers.ts
//
// Etapa security/headers — valida a configuração de `headers()` em
// next.config.js de forma ESTÁVEL e sem rede: chama diretamente a função
// exportada pelo config (nunca sobe um servidor Next nem depende de acesso
// externo à Vercel). Roda em modo "worker" dentro de subprocessos com
// NODE_ENV controlado (mesmo padrão de scripts/test-data-civil.ts), porque
// `process.env.NODE_ENV === 'production'` em next.config.js é avaliado uma
// única vez, no topo do módulo, na primeira vez que ele é importado — testar
// os dois cenários (dev e produção) no MESMO processo exigiria mutar
// NODE_ENV e reimportar com cache quebrado, o que não reflete como o
// Next.js real carrega o config.
//
// Executar com: npm run test:security-headers

import { execFileSync } from 'child_process'
import path from 'path'

interface HeaderEntry {
  key: string
  value: string
}

interface HeadersRule {
  source: string
  headers: HeaderEntry[]
}

// --- Modo worker ---------------------------------------------------------

if (process.argv[2] === '--worker') {
  ;(async () => {
    // require (não import) — next.config.js é CommonJS puro, sem exports
    // TypeScript; carregado fresh a cada subprocesso (module cache isolado).
    const nextConfig = require(path.join(__dirname, '..', 'next.config.js'))
    const rules: HeadersRule[] = await nextConfig.headers()
    process.stdout.write(JSON.stringify(rules))
  })()
} else {
  // --- Modo suíte principal -----------------------------------------------

  let failures = 0

  function assert(condition: boolean, label: string, detalhe?: unknown) {
    if (condition) {
      console.log(`OK   - ${label}`)
    } else {
      failures++
      console.error(`FALHA - ${label}${detalhe !== undefined ? ` (${JSON.stringify(detalhe)})` : ''}`)
    }
  }

  const TS_NODE_BIN = require.resolve('ts-node/dist/bin.js')

  function rodarComNodeEnv(nodeEnv: 'development' | 'production'): HeadersRule[] {
    // NODE_ENV é tipado como um union literal não-opcional (augmentation do
    // próprio Next.js em NodeJS.ProcessEnv) — reatribuir exige o mesmo tipo
    // estrito do parâmetro, nunca uma `string` genérica.
    const env = { ...process.env, NODE_ENV: nodeEnv }
    const saida = execFileSync(
      process.execPath,
      [TS_NODE_BIN, '--project', 'scripts/tsconfig.json', __filename, '--worker'],
      { env, encoding: 'utf-8' }
    )
    return JSON.parse(saida) as HeadersRule[]
  }

  function encontrarHeader(headers: HeaderEntry[], key: string): string | undefined {
    return headers.find((h) => h.key === key)?.value
  }

  function main() {
    const casos: { label: string; nodeEnv: 'development' | 'production'; esperaHsts: boolean }[] = [
      { label: 'development', nodeEnv: 'development', esperaHsts: false },
      { label: 'production', nodeEnv: 'production', esperaHsts: true },
    ]

    for (const caso of casos) {
      const regras = rodarComNodeEnv(caso.nodeEnv)

      assert(regras.length === 1, `[${caso.label}] headers() devolve exatamente 1 regra`, regras)
      const regra = regras[0]

      assert(regra?.source === '/(.*)', `[${caso.label}] regra aplica a TODAS as rotas ('/(.*)')`, regra?.source)

      const headers = regra?.headers ?? []

      assert(
        encontrarHeader(headers, 'X-Content-Type-Options') === 'nosniff',
        `[${caso.label}] X-Content-Type-Options: nosniff`,
        encontrarHeader(headers, 'X-Content-Type-Options')
      )
      assert(
        encontrarHeader(headers, 'Referrer-Policy') === 'strict-origin-when-cross-origin',
        `[${caso.label}] Referrer-Policy: strict-origin-when-cross-origin`,
        encontrarHeader(headers, 'Referrer-Policy')
      )
      assert(
        encontrarHeader(headers, 'X-Frame-Options') === 'DENY',
        `[${caso.label}] X-Frame-Options: DENY`,
        encontrarHeader(headers, 'X-Frame-Options')
      )

      const permissionsPolicy = encontrarHeader(headers, 'Permissions-Policy') ?? ''
      for (const feature of ['camera=()', 'microphone=()', 'geolocation=()', 'payment=()', 'usb=()', 'fullscreen=()', 'clipboard-read=()', 'clipboard-write=()']) {
        assert(permissionsPolicy.includes(feature), `[${caso.label}] Permissions-Policy bloqueia "${feature}"`, permissionsPolicy)
      }

      // Nenhuma diretiva CSP nesta etapa — decisão explícita (ver comentário
      // no topo de next.config.js e docs/MANUTENCAO.md).
      assert(
        encontrarHeader(headers, 'Content-Security-Policy') === undefined,
        `[${caso.label}] Content-Security-Policy NÃO é enviado nesta etapa`,
        encontrarHeader(headers, 'Content-Security-Policy')
      )
      assert(
        encontrarHeader(headers, 'Content-Security-Policy-Report-Only') === undefined,
        `[${caso.label}] Content-Security-Policy-Report-Only NÃO é enviado nesta etapa`,
        encontrarHeader(headers, 'Content-Security-Policy-Report-Only')
      )

      const hsts = encontrarHeader(headers, 'Strict-Transport-Security')
      if (caso.esperaHsts) {
        assert(hsts === 'max-age=31536000; includeSubDomains', `[${caso.label}] Strict-Transport-Security presente e sem "preload"`, hsts)
        assert(!hsts?.includes('preload'), `[${caso.label}] HSTS não inclui "preload" (fora do escopo desta etapa)`, hsts)
      } else {
        assert(hsts === undefined, `[${caso.label}] Strict-Transport-Security AUSENTE fora de produção`, hsts)
      }
    }

    console.log('')
    if (failures > 0) {
      console.error(`${failures} teste(s) de security headers falharam.`)
      process.exit(1)
    }
    console.log('Todos os testes de security headers passaram (dev e produção).')
  }

  main()
}
