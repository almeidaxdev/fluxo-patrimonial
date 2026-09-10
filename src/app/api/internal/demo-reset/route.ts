// src/app/api/internal/demo-reset/route.ts
//
// Reset periódico/manual do dataset da demo pública (Fluxo Patrimonial —
// Demo). NUNCA acionado por um botão no navegador nem por sessão de
// usuário comum — só por automação server-side que conheça
// DEMO_RESET_SECRET (Vercel Cron configurado futuramente, ou
// `npm run demo:reset` localmente, ver scripts/demo-reset.ts). Qualquer
// visitante da demo (inclusive alguém autenticado como Administrador Demo
// via POST /api/demo/entrar) NUNCA consegue disparar isto — a sessão é
// deliberadamente ignorada aqui; a única credencial válida é o secret.
//
// Superfície de ataque reduzida de propósito:
//   - 404 (não 401/403) fora de DEMO_MODE — o endpoint não existe de
//     verdade fora da demo, mesmo para quem tenha o secret certo.
//   - Secret exigido em HEADER (`x-demo-reset-secret`), nunca em query
//     string (evita vazar em logs de acesso/histórico do navegador/Referer).
//   - Comparação em tempo constante (crypto.timingSafeEqual sobre hash
//     SHA-256 de tamanho fixo) — nunca `===` direto, que vazaria por
//     temporização quanto do secret já bate.
//   - DEMO_RESET_SECRET ausente/vazio = fail-closed (nunca "aceita
//     qualquer coisa" por omissão de configuração).
//   - Rate limit próprio (namespace 'demo-reset'), mesma infraestrutura de
//     src/lib/rate-limit.ts.
import { createHash, timingSafeEqual } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { isDemoModeAtivo } from '@/lib/demo-mode'
import { resetarDatasetDemo } from '@/lib/demo/dataset'
import { checkSensitiveRateLimit, extrairIpCliente, RATE_LIMIT_RETRY_AFTER_SECONDS, RATE_LIMIT_RESPONSE_BODY } from '@/lib/rate-limit'

const HEADER_SECRET = 'x-demo-reset-secret'

/** SHA-256 do valor, sempre 32 bytes — usado para que timingSafeEqual nunca receba buffers de tamanho diferente (o que lançaria, revelando por exceção — não por tempo — que os tamanhos brutos diferem). */
function hashSecret(valor: string): Buffer {
  return createHash('sha256').update(valor, 'utf8').digest()
}

function secretConfereEmTempoConstante(recebido: string, esperado: string): boolean {
  return timingSafeEqual(hashSecret(recebido), hashSecret(esperado))
}

export async function POST(req: NextRequest) {
  if (!isDemoModeAtivo()) {
    return NextResponse.json({ message: 'Não encontrado.' }, { status: 404 })
  }

  const { limited } = await checkSensitiveRateLimit({ request: req, namespace: 'demo-reset', identifier: extrairIpCliente(req) })
  if (limited) {
    return NextResponse.json(RATE_LIMIT_RESPONSE_BODY, {
      status: 429,
      headers: { 'Retry-After': String(RATE_LIMIT_RETRY_AFTER_SECONDS) },
    })
  }

  const secretConfigurado = process.env.DEMO_RESET_SECRET
  if (!secretConfigurado || secretConfigurado.trim().length === 0) {
    // Fail-closed: sem secret configurado, o reset nunca é permitido — nem
    // por engano, nem "porque é só demo". Erro de ambiente, não do chamador.
    console.error('[DemoReset] DEMO_RESET_SECRET ausente — reset bloqueado por segurança.')
    return NextResponse.json({ message: 'Reset indisponível: configuração ausente.' }, { status: 503 })
  }

  // Deliberadamente só HEADER — nunca `new URL(req.url).searchParams`.
  const secretRecebido = req.headers.get(HEADER_SECRET)
  if (!secretRecebido || !secretConfereEmTempoConstante(secretRecebido, secretConfigurado)) {
    return NextResponse.json({ message: 'Não autorizado.' }, { status: 401 })
  }

  try {
    // Timeout generoso (padrão do Prisma é 5s): o reset faz dezenas de
    // idas e vindas sequenciais ao banco (apagar + restaurar/recriar todo o
    // dataset) — em rede real (Supabase/pooler), 5s é curto demais e
    // abortaria a transação no meio, potencialmente deixando o dataset
    // pela metade se o retry não acontecer. 30s (valor original) já se
    // provou curto demais em teste real contra o pooler (P2028 — timeout
    // estourado a 30161ms, dentro do laço de recriação das solicitações,
    // já depois de usuários/categorias/tipos de serviço/patrimônios
    // concluídos) — rollback ATÔMICO confirmado nesse teste (nenhuma
    // escrita parcial ficou no banco), mas o reset simplesmente não
    // terminava a tempo. 60s dá margem folgada sobre o pior caso
    // observado.
    await prisma.$transaction(async (tx) => {
      await resetarDatasetDemo(tx)
    }, { timeout: 60_000, maxWait: 15_000 })

    return NextResponse.json({ message: 'Dataset da demo restaurado.', resetadoEm: new Date().toISOString() }, { status: 200 })
  } catch (e) {
    console.error('[DemoReset] Falha ao restaurar o dataset da demo:', e instanceof Error ? e.message : e)
    return NextResponse.json({ message: 'Falha ao restaurar o dataset da demo.' }, { status: 500 })
  }
}
