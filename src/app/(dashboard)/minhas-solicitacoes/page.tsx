// src/app/(dashboard)/minhas-solicitacoes/page.tsx
'use client'

import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ClipboardList, ChevronRight, FilePlus2, X } from 'lucide-react'
import { Solicitacao, StatusSolicitacao, STATUS_SOLICITACAO_LABELS, TIPO_EMPRESTIMO_LABELS } from '@/types'
import { StatusSolicitacaoBadge } from '@/components/ui/StatusBadge'
import { formatDataCivil, formatPeriodos } from '@/utils'
import { FILTRO_EM_ANDAMENTO, filtroPessoalValidoDaUrl, montarParametrosBuscaPessoal } from './filtros'

// Etapa feat/admin-dashboard-operational (homologação) — mesma correção já
// aplicada a todas-solicitacoes/page.tsx: antes, o filtro vivia só em
// `useState` local, nunca refletido na URL — um card do Dashboard pessoal
// (ex.: "?status=PRONTA_RETIRADA") abria a tela, mas o filtro nunca era
// aplicado, o F5 sempre voltava para "Todos os status", e não havia como
// compartilhar/voltar a um filtro específico. `useSearchParams()` é agora a
// ÚNICA fonte de verdade do filtro — nenhum `useState` paralelo — exige
// `<Suspense>` ao redor (ver export default no fim do arquivo).
function MinhasSolicitacoesContent() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [solicitacoes, setSolicitacoes] = useState<Solicitacao[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const LIMIT = 20

  const filtro = filtroPessoalValidoDaUrl(searchParams)

  /** Atualiza o filtro escrevendo DIRETO na URL — nunca um `setState` paralelo (ver comentário acima). */
  function atualizarFiltro(novoFiltro: string) {
    const params = new URLSearchParams(searchParams.toString())
    if (novoFiltro) params.set('status', novoFiltro)
    else params.delete('status')
    const query = params.toString()
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }

  useEffect(() => {
    setLoading(true)
    const params = montarParametrosBuscaPessoal({ filtro, page, limit: LIMIT })
    fetch(`/api/solicitacoes?${params}`)
      .then((r) => r.json())
      .then((d) => { setSolicitacoes(d.solicitacoes || []); setTotal(d.total || 0) })
      .finally(() => setLoading(false))
  }, [filtro, page])

  // Trocar o filtro sempre volta para a página 1 — mesmo padrão já
  // homologado em todas-solicitacoes/page.tsx.
  useEffect(() => { setPage(1) }, [filtro])

  const totalPages = Math.max(1, Math.ceil(total / LIMIT))

  const labelFiltroAtivo = filtro === FILTRO_EM_ANDAMENTO ? 'Em andamento' : filtro ? STATUS_SOLICITACAO_LABELS[filtro] : ''

  return (
    <div className="max-w-4xl space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <select
          value={filtro}
          onChange={(e) => atualizarFiltro(e.target.value)}
          aria-label="Filtrar por status"
          className="px-4 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition"
        >
          <option value="">Todos os status</option>
          <option value={FILTRO_EM_ANDAMENTO}>Em andamento</option>
          {Object.entries(STATUS_SOLICITACAO_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        <Link href="/nova-solicitacao" className="flex items-center justify-center gap-2 px-4 py-2.5 bg-brand hover:bg-brand-dark text-white rounded-xl text-sm font-medium shadow-md hover:shadow-lg hover:-translate-y-0.5 transition-all">
          <FilePlus2 size={16} /> Nova Solicitação
        </Link>
      </div>

      {/* Filtro ativo — mesmo padrão visual já homologado em
          todas-solicitacoes/page.tsx: um deep link (ex.: card "Assinaturas
          pendentes" do Dashboard) precisa deixar claro QUAL filtro trouxe o
          usuário para cá, com uma forma de limpar sem reabrir o select. */}
      {filtro && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 dark:text-gray-400">Filtrando por:</span>
          <button
            onClick={() => atualizarFiltro('')}
            className="inline-flex items-center gap-1.5 pl-3 pr-2 py-1 rounded-full text-xs font-medium bg-brand/10 text-brand dark:bg-blue-950 dark:text-blue-300 hover:bg-brand/20 dark:hover:bg-blue-900 transition"
          >
            {labelFiltroAtivo}
            <X size={13} />
          </button>
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => <div key={i} className="h-20 bg-gray-100 dark:bg-gray-800 rounded-2xl animate-pulse" />)}
        </div>
      ) : solicitacoes.length === 0 ? (
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-10 text-center text-gray-500">
          <ClipboardList size={40} className="mx-auto mb-3 opacity-30" />
          <p>{filtro ? 'Nenhuma solicitação encontrada para este filtro.' : 'Você ainda não possui solicitações.'}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {solicitacoes.map((s) => (
            <Link
              key={s.id}
              href={`/solicitacoes/${s.id}`}
              className="flex items-center justify-between gap-3 bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm p-4 hover:border-brand/40 transition"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className="font-semibold text-gray-900 dark:text-white text-sm">#{s.numero}</span>
                  <StatusSolicitacaoBadge status={s.status as StatusSolicitacao} />
                  <span className="text-xs text-gray-500">{TIPO_EMPRESTIMO_LABELS[s.tipoEmprestimo]}</span>
                </div>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  {/* s.data é a DATA CIVIL da reserva (@db.Date) — formatDataCivil(), não formatDate() (ver Etapa D.3.FOLLOW-UP). */}
                  {formatDataCivil(s.data)} • {formatPeriodos(s.periodos)}
                </p>
              </div>
              <ChevronRight size={18} className="text-gray-300 shrink-0" />
            </Link>
          ))}
        </div>
      )}

      {!loading && totalPages > 1 && (
        <div className="flex items-center justify-between px-1">
          <p className="text-xs text-gray-500 dark:text-gray-400">Página {page} de {totalPages} ({total} no total)</p>
          <div className="flex gap-2">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-xs text-gray-600 dark:text-gray-400 disabled:opacity-40 hover:bg-gray-50 dark:hover:bg-gray-800 transition">Anterior</button>
            <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-xs text-gray-600 dark:text-gray-400 disabled:opacity-40 hover:bg-gray-50 dark:hover:bg-gray-800 transition">Próxima</button>
          </div>
        </div>
      )}
    </div>
  )
}

// `useSearchParams()` (usado dentro de MinhasSolicitacoesContent) exige um
// limite de `<Suspense>` acima na árvore — mesmo padrão já usado em
// todas-solicitacoes/page.tsx.
export default function MinhasSolicitacoesPage() {
  return (
    <Suspense fallback={<div className="text-center py-16 text-gray-400">Carregando...</div>}>
      <MinhasSolicitacoesContent />
    </Suspense>
  )
}
