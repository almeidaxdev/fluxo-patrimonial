// scripts/demo-reset.ts
//
// Reset manual do dataset da demo, para rodar ANTES de uma apresentação ao
// vivo sem esperar o cron periódico (ainda não configurado — ver
// docs/DEMO_MODE.md). Chama POST /api/internal/demo-reset autenticado com
// DEMO_RESET_SECRET lido do ambiente — o secret nunca aparece em código,
// nunca é logado, e não existe nenhum caminho que o exponha ao navegador
// (este script roda só localmente/CI, nunca no client).
//
// Executar com: npm run demo:reset
// Requer no ambiente (ex.: .env.local, nunca commitado):
//   APP_URL            — base da demo (ex.: http://localhost:3000, ou a URL
//                         de produção da demo quando disparado manualmente
//                         contra ela).
//   DEMO_RESET_SECRET   — o mesmo valor configurado na Vercel do projeto da
//                         demo.

export {}

async function main() {
  const appUrl = process.env.APP_URL
  const secret = process.env.DEMO_RESET_SECRET

  if (!appUrl) {
    console.error('❌ APP_URL não configurado no ambiente. Abortando.')
    process.exit(1)
  }
  if (!secret) {
    console.error('❌ DEMO_RESET_SECRET não configurado no ambiente. Abortando.')
    process.exit(1)
  }

  const url = `${appUrl.replace(/\/+$/, '')}/api/internal/demo-reset`
  console.log(`🔄 Disparando reset da demo em ${url} ...`)

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'x-demo-reset-secret': secret },
  })

  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = null
  }

  if (!res.ok) {
    console.error(`❌ Reset falhou (HTTP ${res.status}):`, body)
    process.exit(1)
  }

  console.log('✅ Reset concluído:', body)
}

main().catch((e) => {
  console.error('❌ Erro inesperado ao rodar o reset:', e instanceof Error ? e.message : e)
  process.exit(1)
})
