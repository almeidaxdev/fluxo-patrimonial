// src/app/(dashboard)/minhas-solicitacoes/filtros.ts
//
// Etapa feat/admin-dashboard-operational (homologação) — mesma extração já
// usada em todas-solicitacoes/filtros.ts: lógica PURA de filtro, sem
// React/JSX, testável diretamente por scripts/*.ts. Prova que um card
// pessoal do Dashboard (ex.: "Prontas para retirada" → `?status=PRONTA_
// RETIRADA`, "Minhas solicitações em andamento" → `?status=EM_ANDAMENTO`)
// resulta num filtro REAL aplicado em GET /api/solicitacoes — não só que o
// href contém a string certa.
import { StatusSolicitacao, STATUS_SOLICITACAO_LABELS } from '@/types'

/**
 * Sentinela de URL para o preset "em andamento" — nunca um StatusSolicitacao
 * real. A fonte real do conjunto de status agrupado é
 * `STATUS_EM_ANDAMENTO_SOLICITANTE` (src/lib/status.ts), usada tanto pelo
 * contador (`GET /api/dashboard`) quanto pelo filtro de verdade
 * (`GET /api/solicitacoes?filtro=em_andamento`, ver montarParametrosBuscaPessoal
 * abaixo) — nunca duas definições divergentes.
 */
export const FILTRO_EM_ANDAMENTO = 'EM_ANDAMENTO' as const

export type FiltroPessoal = '' | typeof FILTRO_EM_ANDAMENTO | StatusSolicitacao

/**
 * Deriva o filtro pessoal a partir de um `URLSearchParams` (compatível com
 * `ReadonlyURLSearchParams`, o tipo real devolvido por `useSearchParams()`).
 * Aceita tanto o preset `EM_ANDAMENTO` quanto qualquer StatusSolicitacao real
 * (ex.: `AGUARDANDO_ASSINATURA`, `PRONTA_RETIRADA`). Um valor fora dessas
 * duas possibilidades cai no default (sem filtro) — nunca repassado cru ao
 * fetch em `montarParametrosBuscaPessoal` abaixo.
 */
export function filtroPessoalValidoDaUrl(searchParams: Pick<URLSearchParams, 'get'>): FiltroPessoal {
  const bruto = searchParams.get('status')
  if (bruto === FILTRO_EM_ANDAMENTO) return FILTRO_EM_ANDAMENTO
  return bruto && bruto in STATUS_SOLICITACAO_LABELS ? (bruto as StatusSolicitacao) : ''
}

/**
 * Monta os query params de `GET /api/solicitacoes` a partir do filtro
 * pessoal atual — sempre `escopo=minhas` (nunca outro escopo nesta tela).
 * `EM_ANDAMENTO` vira o preset semântico `filtro=em_andamento`; qualquer
 * outro valor não vazio vira o `status` exato correspondente.
 */
export function montarParametrosBuscaPessoal(input: {
  filtro: FiltroPessoal
  page: number
  limit: number
}): URLSearchParams {
  const params = new URLSearchParams({ escopo: 'minhas', page: String(input.page), limit: String(input.limit) })
  if (input.filtro === FILTRO_EM_ANDAMENTO) params.set('filtro', 'em_andamento')
  else if (input.filtro) params.set('status', input.filtro)
  return params
}
