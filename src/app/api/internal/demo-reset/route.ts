// src/app/api/internal/demo-reset/route.ts
//
// Reset periódico/manual do dataset da demo pública (Fluxo Patrimonial —
// Demo). NUNCA acionado por um botão no navegador nem por sessão de
// usuário comum — só por automação server-side. Qualquer visitante da
// demo (inclusive alguém autenticado como Administrador Demo via
// POST /api/demo/entrar) NUNCA consegue disparar isto — a sessão é
// deliberadamente ignorada aqui; a única credencial válida em cada verbo é
// o secret correspondente.
//
// DOIS mecanismos independentes, cada um com sua própria credencial —
// nunca compartilham nem aceitam o secret um do outro:
//   - POST + header `x-demo-reset-secret` == DEMO_RESET_SECRET: reset
//     manual/server-to-server (`npm run demo:reset`, ver
//     scripts/demo-reset.ts). Continua exatamente como antes.
//   - GET + header `Authorization: Bearer <CRON_SECRET>` == CRON_SECRET:
//     exclusivo do Vercel Cron (ver vercel.json), que só sabe chamar GET
//     com esse formato de header — nunca envia `x-demo-reset-secret`.
// As duas trilhas só convergem depois de autenticadas, na mesma função
// central de reset (`executarResetDataset` abaixo) — a lógica de
// restauração do dataset nunca é duplicada.
//
// Superfície de ataque reduzida de propósito:
//   - 404 (não 401/403) fora de DEMO_MODE — o endpoint não existe de
//     verdade fora da demo, mesmo para quem tenha o secret certo.
//   - Secret exigido em HEADER (nunca em query string, o que evita vazar
//     em logs de acesso/histórico do navegador/Referer) — `x-demo-reset-
//     secret` para o POST, `Authorization: Bearer` (padrão Vercel Cron)
//     para o GET.
//   - Comparação em tempo constante (crypto.timingSafeEqual sobre hash
//     SHA-256 de tamanho fixo) — nunca `===` direto, que vazaria por
//     temporização quanto do secret já bate.
//   - DEMO_RESET_SECRET/CRON_SECRET ausente/vazio = fail-closed (nunca
//     "aceita qualquer coisa" por omissão de configuração) — cada verbo só
//     valida o seu próprio secret, nunca cai no outro por engano.
//   - Rate limit próprio (namespace 'demo-reset'), mesma infraestrutura de
//     src/lib/rate-limit.ts — aplicado ao POST, como já era; o GET é
//     exclusivo do Vercel Cron (schedule fixo, sem superfície de abuso por
//     volume) e não recebe rate limit adicional aqui.
import { createHash, timingSafeEqual } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { isDemoModeAtivo } from '@/lib/demo-mode'
import { resetarDatasetDemo } from '@/lib/demo/dataset'
import { checkSensitiveRateLimit, extrairIpCliente, RATE_LIMIT_RETRY_AFTER_SECONDS, RATE_LIMIT_RESPONSE_BODY } from '@/lib/rate-limit'

const HEADER_SECRET = 'x-demo-reset-secret'
const BEARER_PREFIX = 'Bearer '

/** SHA-256 do valor, sempre 32 bytes — usado para que timingSafeEqual nunca receba buffers de tamanho diferente (o que lançaria, revelando por exceção — não por tempo — que os tamanhos brutos diferem). */
function hashSecret(valor: string): Buffer {
  return createHash('sha256').update(valor, 'utf8').digest()
}

function secretConfereEmTempoConstante(recebido: string, esperado: string): boolean {
  return timingSafeEqual(hashSecret(recebido), hashSecret(esperado))
}

/** Extrai o token de um header `Authorization: Bearer <token>` — formato exato usado pelo Vercel Cron. Qualquer outro formato (esquema diferente, ausente) retorna null, nunca uma string vazia que pudesse colidir com um CRON_SECRET vazio. */
function extrairBearerToken(headerAuthorization: string | null): string | null {
  if (!headerAuthorization || !headerAuthorization.startsWith(BEARER_PREFIX)) {
    return null
  }
  return headerAuthorization.slice(BEARER_PREFIX.length)
}

/**
 * Função central de restauração do dataset — única implementação, chamada
 * pelo POST (secret manual) e pelo GET (Vercel Cron) só depois de cada um
 * validar sua própria credencial. Nunca duplicar esta lógica.
 */
async function executarResetDataset(): Promise<NextResponse> {
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

  return executarResetDataset()
}

// GET — exclusivo do Vercel Cron (ver vercel.json). Credencial própria
// (CRON_SECRET via `Authorization: Bearer`), nunca DEMO_RESET_SECRET nem
// o header x-demo-reset-secret do POST — os dois mecanismos são
// deliberadamente independentes (ver comentário no topo do arquivo).
export async function GET(req: NextRequest) {
  if (!isDemoModeAtivo()) {
    return NextResponse.json({ message: 'Não encontrado.' }, { status: 404 })
  }

  const secretConfigurado = process.env.CRON_SECRET
  if (!secretConfigurado || secretConfigurado.trim().length === 0) {
    // Fail-closed: sem CRON_SECRET configurado, o Cron nunca consegue
    // resetar — nem por engano, nem "porque é só demo". Erro de ambiente,
    // não do chamador.
    console.error('[DemoReset] CRON_SECRET ausente — reset via Cron bloqueado por segurança.')
    return NextResponse.json({ message: 'Reset indisponível: configuração ausente.' }, { status: 503 })
  }

  // Padrão Vercel Cron: `Authorization: Bearer <CRON_SECRET>`.
  const tokenRecebido = extrairBearerToken(req.headers.get('authorization'))
  if (!tokenRecebido || !secretConfereEmTempoConstante(tokenRecebido, secretConfigurado)) {
    return NextResponse.json({ message: 'Não autorizado.' }, { status: 401 })
  }

  return executarResetDataset()
}
