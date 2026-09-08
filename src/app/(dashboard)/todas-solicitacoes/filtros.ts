// src/app/(dashboard)/todas-solicitacoes/filtros.ts
//
// Etapa feat/patrimonio-operational-ux (correção pós-homologação) — lógica
// PURA de filtro extraída de page.tsx para um módulo à parte: Next.js
// valida em build time que um arquivo `page.tsx` só exporta os campos que
// ele reconhece (`default`, `metadata` etc.) — qualquer export extra
// (mesmo uma função utilitária) quebra a checagem de tipos gerada
// (`.next/types/app/.../page.ts`). Sem esse problema aqui, por não ser uma
// página.
//
// As duas funções abaixo existem para serem TESTÁVEIS diretamente (ver
// scripts/test-patrimonio-operational-ux.ts), provando que um card do
// Painel do Patrimônio (`?status=EM_UTILIZACAO`) realmente resulta num
// filtro aplicado de verdade — não só que o href contém a string certa.
import { STATUS_SOLICITACAO_LABELS } from '@/types'

export type Modo = 'lista' | 'data'

/**
 * Deriva o filtro `status` a partir de um `URLSearchParams` (compatível com
 * `ReadonlyURLSearchParams`, o tipo real devolvido por `useSearchParams()`).
 * Um valor fora do enum (`STATUS_SOLICITACAO_LABELS`) cai no default (sem
 * filtro) — nunca repassado cru ao fetch em `montarParametrosBusca` abaixo.
 */
export function statusValidoDaUrl(searchParams: Pick<URLSearchParams, 'get'>): string {
  const bruto = searchParams.get('status')
  return bruto && bruto in STATUS_SOLICITACAO_LABELS ? bruto : ''
}

/** Monta os query params de `GET /api/solicitacoes` a partir dos filtros atuais. */
export function montarParametrosBusca(input: {
  status: string
  tipoEmprestimo: string
  numero: string
  modo: Modo
  data: string
  page: number
  limit: number
}): URLSearchParams {
  const params = new URLSearchParams({ escopo: 'todas', page: String(input.page), limit: String(input.limit) })
  if (input.status) params.set('status', input.status)
  if (input.tipoEmprestimo) params.set('tipoEmprestimo', input.tipoEmprestimo)
  if (input.numero) params.set('numero', input.numero)
  if (input.modo === 'data' && input.data) params.set('data', input.data)
  return params
}
