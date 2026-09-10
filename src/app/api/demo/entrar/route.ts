// src/app/api/demo/entrar/route.ts
//
// "Acessar demonstração" (Fluxo Patrimonial — Demo, opção B aprovada):
// autentica diretamente na conta demonstrativa pública, sem exigir e-mail/
// senha do visitante. Só existe de verdade quando DEMO_MODE=true — fora
// desse modo, devolve 404 (não 403/401), para não revelar nem a existência
// do endpoint num ambiente de produção normal (nunca um backdoor
// utilizável fora da demo).
//
// A senha da conta demo NUNCA aparece aqui: nenhuma comparação de senha
// acontece nesta rota — ela usa exatamente o mesmo mecanismo de sessão de
// src/lib/auth.ts (setSession/signToken), pulando só a etapa de
// autenticação por credencial (que não faz sentido para um botão público).
// Nenhum hash, nenhuma senha em texto puro e nenhum segredo trafega para o
// client em nenhum momento — a resposta tem exatamente o mesmo formato de
// POST /api/auth/login.
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { setSession } from '@/lib/auth'
import { isDemoModeAtivo, getDemoAccountEmail } from '@/lib/demo-mode'
import { checkSensitiveRateLimit, extrairIpCliente, RATE_LIMIT_RETRY_AFTER_SECONDS, RATE_LIMIT_RESPONSE_BODY } from '@/lib/rate-limit'

export async function POST(req: NextRequest) {
  if (!isDemoModeAtivo()) {
    return NextResponse.json({ message: 'Não encontrado.' }, { status: 404 })
  }

  // Rate limit por IP (mesmo padrão de POST /api/auth/cadastro) — namespace
  // próprio ('demo-entrar'), nunca soma com o contador de 'login'/
  // 'cadastro'. Protege contra automação gerando sessões em massa contra o
  // ambiente de demonstração público.
  const { limited } = await checkSensitiveRateLimit({ request: req, namespace: 'demo-entrar', identifier: extrairIpCliente(req) })
  if (limited) {
    return NextResponse.json(RATE_LIMIT_RESPONSE_BODY, {
      status: 429,
      headers: { 'Retry-After': String(RATE_LIMIT_RETRY_AFTER_SECONDS) },
    })
  }

  try {
    const user = await prisma.user.findUnique({ where: { email: getDemoAccountEmail() } })
    if (!user || !user.ativo) {
      // Configuração incompleta (DEMO_ACCOUNT_EMAIL aponta para um usuário
      // inexistente/desativado) — erro de ambiente, não do visitante.
      console.error('[Demo] Conta demonstrativa configurada em DEMO_ACCOUNT_EMAIL não existe ou está inativa.')
      return NextResponse.json({ message: 'Ambiente de demonstração indisponível no momento.' }, { status: 503 })
    }

    const sessionUser = {
      id: user.id,
      nome: user.nome,
      email: user.email,
      permissao: user.permissao,
      podeSerGestor: user.podeSerGestor,
      podeSolicitarParaOutro: user.podeSolicitarParaOutro,
      versaoSessao: user.versaoSessao,
    }
    await setSession(sessionUser)

    return NextResponse.json({ user: sessionUser }, { status: 200 })
  } catch (e) {
    console.error(e)
    return NextResponse.json({ message: 'Erro interno no servidor.' }, { status: 500 })
  }
}
