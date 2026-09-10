// src/lib/demo-mode.ts
//
// Ponto único de proteção do ambiente de demonstração pública (Fluxo
// Patrimonial — Demo). Nenhuma rota deve checar `process.env.DEMO_MODE`
// diretamente — sempre chamar `assertDemoActionAllowed(acao)` aqui.
//
// DEMO_MODE=false (ou variável ausente): `assertDemoActionAllowed()` sempre
// devolve `null` (nada bloqueado) — o comportamento do sistema em produção
// normal permanece 100% inalterado, byte a byte, em relação a antes desta
// etapa.
//
// DEMO_MODE=true: cada `DemoAction` do union abaixo é bloqueada
// incondicionalmente, com 403 e a mensagem fixa exigida — mesmo que a
// sessão que fez a chamada seja `administrador`. O perfil da conta NUNCA
// tem prioridade sobre DEMO_MODE; a checagem é sempre feita server-side,
// nunca inferida a partir do que o frontend esconde/desabilita.

import { NextResponse } from 'next/server'

/**
 * Ações conhecidas, bloqueadas em DEMO_MODE=true. União fechada de
 * propósito — força qualquer nova rota potencialmente destrutiva a ser
 * adicionada aqui explicitamente, nunca inferida por convenção de nome de
 * rota/verbo HTTP.
 *
 * Modelo "dados mestres somente leitura" (revisão de hardening): as telas
 * administrativas de colaboradores/patrimônios/categorias permanecem
 * VISÍVEIS na demo (o visitante navega e vê os dados fictícios), mas TODA
 * mutação nelas — criar, editar ou excluir, sem exceção de campo — é
 * bloqueada. Não existe mais uma lista de "campos sensíveis"; o bloqueio é
 * por RECURSO inteiro, sempre no verbo (POST/PATCH/DELETE) da rota
 * correspondente. Isso também cobre automaticamente a conta demonstrativa
 * (DEMO_ACCOUNT_EMAIL) — nenhum caso especial adicional é necessário: ela é
 * só mais um colaborador, e todo colaborador é somente-leitura na demo.
 */
export type DemoAction =
  | 'colaborador:mutar'
  | 'patrimonio:mutar'
  | 'categoria:mutar'
  | 'auth:alterar-senha-propria'
  | 'auth:autocadastro'

const MENSAGEM_BLOQUEIO_DEMO = 'Ação desabilitada no ambiente de demonstração.'

/**
 * Único ponto de leitura de `DEMO_MODE`. Comparação literal (`=== 'true'`),
 * mesmo padrão de EMAIL_TEST_MODE (src/lib/email/config.ts) — qualquer valor
 * diferente do literal exato (ausente, `"1"`, `"TRUE"`, `"false"`) é tratado
 * como "não é demo", nunca como erro de configuração: DEMO_MODE é uma
 * opção, não uma variável obrigatória, e sua ausência deve ser exatamente
 * equivalente a "ambiente normal".
 */
export function isDemoModeAtivo(): boolean {
  return process.env.DEMO_MODE === 'true'
}

/**
 * E-mail da conta demonstrativa pública (ver POST /api/demo/entrar).
 * Configurável via DEMO_ACCOUNT_EMAIL; `admin@example.com` como padrão para
 * não exigir configuração extra em ambientes de desenvolvimento local.
 */
export function getDemoAccountEmail(): string {
  const raw = process.env.DEMO_ACCOUNT_EMAIL
  return raw && raw.trim().length > 0 ? raw.trim().toLowerCase() : 'admin@example.com'
}

/**
 * Retorna uma resposta 403 pronta quando `acao` deve ser bloqueada no
 * ambiente atual, ou `null` quando a chamada pode prosseguir normalmente
 * (DEMO_MODE inativo). Nunca lança. Uso:
 *
 *   const bloqueio = assertDemoActionAllowed('colaborador:mutar')
 *   if (bloqueio) return bloqueio
 */
export function assertDemoActionAllowed(_acao: DemoAction): NextResponse | null {
  if (!isDemoModeAtivo()) return null
  return NextResponse.json({ message: MENSAGEM_BLOQUEIO_DEMO }, { status: 403 })
}

// ---------------------------------------------------------------------------
// Limite global de solicitações (defesa em profundidade — hardening
// adicional). O rate limit em src/lib/rate-limit.ts (Vercel Firewall) é
// best-effort e fail-open (ver docs/DEMO_MODE.md) — este limite é uma
// segunda proteção, totalmente independente, que não depende de nenhuma
// configuração externa nem de infraestrutura nova: só conta linhas já
// existentes no próprio banco da demo.
// ---------------------------------------------------------------------------

/** Default aplicado quando DEMO_MAX_SOLICITACOES está ausente ou inválido. */
const DEMO_MAX_SOLICITACOES_PADRAO = 200

/**
 * Lê DEMO_MAX_SOLICITACOES: só um inteiro positivo é aceito; qualquer outro
 * valor (ausente, não numérico, zero, negativo, decimal) cai no default
 * seguro — nunca "sem limite" por omissão/erro de configuração (mesmo
 * espírito fail-safe de EMAIL_TEST_MODE/DEMO_MODE: uma variável de proteção
 * malformada nunca deve DESLIGAR a proteção).
 */
export function getDemoMaxSolicitacoes(): number {
  const raw = process.env.DEMO_MAX_SOLICITACOES
  if (!raw) return DEMO_MAX_SOLICITACOES_PADRAO

  const valor = Number(raw)
  if (!Number.isInteger(valor) || valor <= 0) return DEMO_MAX_SOLICITACOES_PADRAO

  return valor
}

const MENSAGEM_LIMITE_SOLICITACOES_DEMO = 'Limite temporário da demonstração atingido. Tente novamente após a restauração do ambiente.'

/** Resposta 429 padronizada para o limite global de solicitações da demo — nunca reaproveitar RATE_LIMIT_RESPONSE_BODY (mensagens/motivos diferentes). */
export function respostaLimiteSolicitacoesDemo(): NextResponse {
  return NextResponse.json({ message: MENSAGEM_LIMITE_SOLICITACOES_DEMO }, { status: 429 })
}
