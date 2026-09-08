// src/app/(dashboard)/todas-solicitacoes/page.tsx
'use client'

import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ChevronRight, CalendarRange, List, X } from 'lucide-react'
import { Solicitacao, StatusSolicitacao, STATUS_SOLICITACAO_LABELS, TIPO_EMPRESTIMO_LABELS } from '@/types'
import { StatusSolicitacaoBadge } from '@/components/ui/StatusBadge'
import { cn, formatDataCivil, formatPeriodos, todayISO } from '@/utils'
import { statusValidoDaUrl, montarParametrosBusca, type Modo } from './filtros'

// Etapa feat/patrimonio-operational-ux (correção pós-homologação): a versão
// anterior lia `status` da URL uma única vez, num inicializador de
// `useState(() => ...)` que consultava `window.location.search` — isso só
// funciona de forma confiável no PRIMEIRO mount do componente. Ao navegar
// de um card do Painel do Patrimônio (ex.: "Em utilização") para ESTA MESMA
// página já visitada antes na sessão (ex.: pelo Sidebar), o Next.js App
// Router pode reaproveitar/transicionar a navegação sem que
// `window.location.search` esteja garantidamente atualizado no exato
// instante em que aquele inicializador roda — o `status` ficava com o
// valor de uma visita anterior (vazio), reproduzindo o bug observado na
// homologação: card linka certo, mas o filtro não é aplicado.
//
// Correção: `useSearchParams()` (API reativa oficial do Next para isso) é
// agora a ÚNICA fonte de verdade do filtro `status` — nenhum `useState`
// paralelo para ele. Cada navegação (deep link, F5, back/forward, ou o
// próprio `<select>` abaixo) atualiza a URL via `router.replace`, e
// `useSearchParams()` sempre reflete o valor ATUAL da URL no render atual,
// eliminando a classe inteira de bug de dessincronização. `useSearchParams()`
// exige `<Suspense>` ao redor (ver export default no fim do arquivo) — a
// página já é 100% dinâmica/client-side (atrás de autenticação), então isso
// não afeta nada de SSR/geração estática.
function TodasSolicitacoesContent() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [modo, setModo] = useState<Modo>('lista')
  const [solicitacoes, setSolicitacoes] = useState<Solicitacao[]>([])
  const [loading, setLoading] = useState(true)

  const status = statusValidoDaUrl(searchParams)

  /** Atualiza o filtro de status escrevendo DIRETO na URL — nunca um `setState` paralelo (ver comentário acima). */
  function atualizarStatus(novoStatus: string) {
    const params = new URLSearchParams(searchParams.toString())
    if (novoStatus) params.set('status', novoStatus)
    else params.delete('status')
    const query = params.toString()
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }

  const [tipoEmprestimo, setTipoEmprestimo] = useState('')
  const [numero, setNumero] = useState('')
  const [data, setData] = useState('')
  // Etapa perf/system-optimization: a API sempre paginou (default limit=20),
  // mas esta tela nunca enviava page/limit nem oferecia forma de ver a
  // página seguinte — qualquer solicitação além da 20ª (pela ordenação
  // data asc/número desc) ficava invisível aqui, sem nenhum aviso. Mesmo
  // padrão de estado/paginação já homologado em colaboradores/page.tsx e
  // patrimonios/page.tsx.
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const LIMIT = 20

  useEffect(() => {
    setLoading(true)
    const params = montarParametrosBusca({ status, tipoEmprestimo, numero, modo, data, page, limit: LIMIT })
    fetch(`/api/solicitacoes?${params}`)
      .then((r) => r.json())
      .then((d) => { setSolicitacoes(d.solicitacoes || []); setTotal(d.total || 0) })
      .finally(() => setLoading(false))
  }, [status, tipoEmprestimo, numero, modo, data, page])

  // Trocar qualquer filtro sempre volta para a página 1 — nunca deixar o
  // usuário "preso" numa página que o novo filtro não tem mais (mesmo
  // padrão de colaboradores/page.tsx e patrimonios/page.tsx).
  useEffect(() => { setPage(1) }, [status, tipoEmprestimo, numero, modo, data])

  const totalPages = Math.max(1, Math.ceil(total / LIMIT))

  function atalho(dias: number) {
    const d = new Date()
    d.setDate(d.getDate() + dias)
    setData(d.toISOString().split('T')[0])
  }

  const agrupadasPorDia = solicitacoes.reduce<Record<string, Solicitacao[]>>((acc, s) => {
    const key = s.data.split('T')[0]
    acc[key] = acc[key] || []
    acc[key].push(s)
    return acc
  }, {})

  return (
    <div className="space-y-4">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="flex gap-2">
          <button onClick={() => setModo('lista')} className={cn('flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium', modo === 'lista' ? 'bg-brand text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300')}>
            <List size={16} /> Lista completa
          </button>
          <button onClick={() => setModo('data')} className={cn('flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium', modo === 'data' ? 'bg-brand text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300')}>
            <CalendarRange size={16} /> Por data
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          <input value={numero} onChange={(e) => setNumero(e.target.value)} placeholder="Nº" className="w-20 px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm" />
          <select value={status} onChange={(e) => atualizarStatus(e.target.value)} className="px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm">
            <option value="">Status</option>
            {Object.entries(STATUS_SOLICITACAO_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select value={tipoEmprestimo} onChange={(e) => setTipoEmprestimo(e.target.value)} className="px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm">
            <option value="">Interno/Externo</option>
            <option value="interno">Interno</option>
            <option value="externo">Externo</option>
          </select>
        </div>
      </div>

      {/* Filtro ativo (Etapa feat/patrimonio-operational-ux): indicação
          visual explícita — o <select> acima já reflete o status
          selecionado, mas um deep link (ex.: card "Não retiradas" do Painel
          do Patrimônio) precisa deixar claro, de forma óbvia, QUAL filtro
          trouxe o usuário para cá, com uma forma de limpar sem precisar
          reabrir o select e procurar "Status" na lista. */}
      {status && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 dark:text-gray-400">Filtrando por:</span>
          <button
            onClick={() => atualizarStatus('')}
            className="inline-flex items-center gap-1.5 pl-3 pr-2 py-1 rounded-full text-xs font-medium bg-brand/10 text-brand dark:bg-blue-950 dark:text-blue-300 hover:bg-brand/20 dark:hover:bg-blue-900 transition"
          >
            {STATUS_SOLICITACAO_LABELS[status as StatusSolicitacao]}
            <X size={13} />
          </button>
        </div>
      )}

      {modo === 'data' && (
        <div className="flex flex-wrap items-center gap-2">
          <input type="date" value={data} onChange={(e) => setData(e.target.value)} className="px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm" />
          <button onClick={() => setData(todayISO())} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-100 dark:bg-gray-800">Hoje</button>
          <button onClick={() => atalho(1)} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-100 dark:bg-gray-800">Amanhã</button>
          <button onClick={() => atalho(7)} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-100 dark:bg-gray-800">Próxima semana</button>
          <button onClick={() => setData('')} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-100 dark:bg-gray-800">Todas</button>
        </div>
      )}

      {loading ? (
        <div className="text-center py-16 text-gray-400">Carregando...</div>
      ) : solicitacoes.length === 0 ? (
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-10 text-center text-gray-500">
          Nenhuma solicitação encontrada.
        </div>
      ) : modo === 'lista' ? (
        <div className="space-y-3">
          {solicitacoes.map((s) => <LinhaSolicitacao key={s.id} s={s} />)}
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(agrupadasPorDia).map(([dia, itens]) => (
            <div key={dia}>
              {/* `dia` (chave de agrupamento, "YYYY-MM-DD" — ver agrupadasPorDia acima)
                  e cada `s.data` abaixo (LinhaSolicitacao) são a MESMA DATA CIVIL da
                  reserva (@db.Date) — ambos via formatDataCivil() agora, para nunca
                  mais divergirem entre cabeçalho de grupo e linha do item (ver
                  Etapa D.3.FOLLOW-UP: antes, o item usava formatDate(), sensível ao
                  timezone do processo, e podia mostrar um dia diferente do cabeçalho). */}
              <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">{formatDataCivil(dia)}</h3>
              <div className="space-y-3">{itens.map((s) => <LinhaSolicitacao key={s.id} s={s} />)}</div>
            </div>
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

// `useSearchParams()` (usado dentro de TodasSolicitacoesContent) exige um
// limite de `<Suspense>` acima na árvore — ver comentário no topo do
// arquivo. Fallback simples, mesmo texto/estilo já usado para o loading da
// lista logo abaixo, para não introduzir um segundo padrão visual de
// carregamento só para esta fração de segundo.
export default function TodasSolicitacoesPage() {
  return (
    <Suspense fallback={<div className="text-center py-16 text-gray-400">Carregando...</div>}>
      <TodasSolicitacoesContent />
    </Suspense>
  )
}

function LinhaSolicitacao({ s }: { s: Solicitacao }) {
  return (
    <Link
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
          {s.solicitante?.nome} • {formatDataCivil(s.data)} • {formatPeriodos(s.periodos)}
        </p>
      </div>
      <ChevronRight size={18} className="text-gray-300 shrink-0" />
    </Link>
  )
}
