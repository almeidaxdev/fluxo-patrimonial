// src/app/(dashboard)/relatorios/page.tsx
'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, LabelList,
} from 'recharts'
import {
  ClipboardList, Zap, Building2, MapPin, CheckCircle2, XCircle,
  Clock, PackageCheck, Truck, Undo2, Ban, Package as PackageIcon, Laptop, Wrench,
  TrendingUp, TrendingDown, Minus, ChevronRight, ChevronLeft, BarChart3, Users,
  Lightbulb, Search, SlidersHorizontal, ChevronDown, ChevronUp, Info, CalendarClock,
  Download, Loader2, FileSpreadsheet, AlertTriangle,
} from 'lucide-react'
import {
  CategoriaPatrimonio, TipoServico, StatusSolicitacao, TipoEmprestimo, OrigemSolicitacao,
  PeriodoSolicitacao, PERIODO_LABELS, STATUS_SOLICITACAO_LABELS, TIPO_EMPRESTIMO_LABELS,
} from '@/types'
import { StatusSolicitacaoBadge } from '@/components/ui/StatusBadge'
import { formatarAntecedencia } from '@/lib/prazo'
import { cn, formatDataCivil, formatDate, formatDateTime } from '@/utils'

// =============================================================================
// Tipos (espelham exatamente o payload de /api/relatorios/resumo e /operacional)
// =============================================================================

interface ResumoBasico {
  total: number
  internas: number
  externas: number
  reservasAntecipadas: number
  atendimentosImediatos: number
  dentroPrazo: number
  foraPrazo: number
  percentualDentroPrazo: number | null
}
interface DistribuicaoStatusItem { status: StatusSolicitacao; quantidade: number }
interface OperacaoResumo {
  retiradas: number; naoRetiradas: number; retiradasVencidasSemRegistro: number; emUtilizacao: number
  finalizadas: number; canceladas: number; prontasRetirada: number
}
interface PeriodoDistribuicaoItem { periodo: PeriodoSolicitacao; total: number; reservas: number; atendimentosImediatos: number }
interface ResumoAtendimentoImediato { total: number; percentualDemanda: number; comBens: number; comPapelaria: number; comServico: number }
interface AntecedenciaMedia { internasMinutos: number | null; externasMinutos: number | null }
interface RankingPatrimonio { patrimonioId: string; numero: string; marca: string; modelo: string; categoriaNome: string; utilizacoes: number }
interface RankingCategoria { categoriaId: string; categoriaNome: string; utilizacoes: number }
interface ResumoBens { totalBensMovimentados: number; rankingPatrimonios: RankingPatrimonio[]; rankingCategorias: RankingCategoria[] }
interface ItemPapelariaRanking { descricaoNormalizada: string; quantidadeTotal: number; ocorrencias: number }
interface ResumoPapelaria { solicitacoesComPapelaria: number; quantidadeTotalItens: number; atendimentosImediatosComPapelaria: number; itensMaisSolicitados: ItemPapelariaRanking[] }
interface RankingServico { tipoServicoId: string; nome: string; ocorrencias: number; quantidadeTotal: number | null }
interface ResumoServicos { solicitacoesComServico: number; totalServicosRealizados: number; ranking: RankingServico[] }
interface MesEvolucao extends ResumoBasico { mes: string }
interface ComparativoCampo { atual: number; anterior: number; variacaoPercentual: number | null }
interface ComparativoMesAnterior {
  mesAtual: string; mesAnteriorLabel: string
  total: ComparativoCampo; internas: ComparativoCampo; externas: ComparativoCampo
  atendimentosImediatos: ComparativoCampo; dentroPrazo: ComparativoCampo; foraPrazo: ComparativoCampo
  canceladas: ComparativoCampo; naoRetiradas: ComparativoCampo
}

interface ResumoPayload {
  resumo: ResumoBasico
  statusDist: DistribuicaoStatusItem[]
  operacao: OperacaoResumo
  distribuicaoPeriodo: PeriodoDistribuicaoItem[]
  atendimentoImediato: ResumoAtendimentoImediato
  antecedenciaMedia: AntecedenciaMedia
  bens: ResumoBens
  papelaria: ResumoPapelaria
  servicos: ResumoServicos
  evolucaoMensal: MesEvolucao[]
  comparativoMesAnterior: ComparativoMesAnterior | null
  resumoExecutivo: string
}

interface SolicitacaoOperacional {
  id: string; numero: number; tipoEmprestimo: TipoEmprestimo; origem: OrigemSolicitacao
  status: StatusSolicitacao; data: string; periodos: PeriodoSolicitacao[]
  ambiente: string | null; local: string | null; cidade: string | null; createdAt: string
  prazoHoras: number | null; antecedenciaMinutos: number | null; dentroDoPrazo: boolean | null
  retiradaEm: string | null; devolucaoEm: string | null
  solicitante: { id: string; nome: string; email: string }
  _count: { itensPatrimonio: number; itensPapelaria: number; itensServico: number }
}

const STATUS_ENCERRADOS: StatusSolicitacao[] = ['FINALIZADA', 'CANCELADA', 'REJEITADA_GESTOR', 'REJEITADA_PATRIMONIO', 'NAO_RETIRADA']
const ORIGEM_LABELS: Record<OrigemSolicitacao, string> = { RESERVA: 'Reserva antecipada', ATENDIMENTO_IMEDIATO: 'Atendimento imediato' }

function mesAtualISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function mesLabel(mesAno: string): string {
  const [ano, mes] = mesAno.split('-').map(Number)
  return new Date(ano, mes - 1, 1).toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' })
}

function mesLabelCompleto(mesAno: string): string {
  const [ano, mes] = mesAno.split('-').map(Number)
  return new Date(ano, mes - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })
}

function pct(n: number, total: number): string {
  return total > 0 ? `${((n / total) * 100).toFixed(1)}%` : '—'
}

function plural(n: number, singular: string, pluralForm: string): string {
  return n === 1 ? singular : pluralForm
}

export default function RelatoriosPage() {
  const [visao, setVisao] = useState<'gerencial' | 'operacional'>('gerencial')
  const [maisFiltrosAberto, setMaisFiltrosAberto] = useState(false)

  // Filtros
  const [modoData, setModoData] = useState<'mes' | 'personalizado'>('mes')
  const [mes, setMes] = useState(mesAtualISO())
  const [dataInicio, setDataInicio] = useState('')
  const [dataFim, setDataFim] = useState('')
  const [tipoEmprestimo, setTipoEmprestimo] = useState('')
  const [origem, setOrigem] = useState('')
  const [prazo, setPrazo] = useState('')
  const [status, setStatus] = useState('')
  const [categoriaId, setCategoriaId] = useState('')
  const [tipoServicoId, setTipoServicoId] = useState('')
  const [periodoFiltro, setPeriodoFiltro] = useState('')
  // Atalhos operacionais (Etapa 6 — refinamento): "Fora do prazo" e
  // "Atendimentos imediatos" reaproveitam os estados `prazo`/`origem` já
  // existentes. "Pendentes" e "Não retiradas" são dois novos toggles que
  // aplicam, no backend, exatamente a mesma regra já usada nas agregações.
  const [pendente, setPendente] = useState(false)
  const [naoRetirada, setNaoRetirada] = useState(false)
  const [busca, setBusca] = useState('')
  const [buscaDebounced, setBuscaDebounced] = useState('')

  const [categorias, setCategorias] = useState<CategoriaPatrimonio[]>([])
  const [tiposServico, setTiposServico] = useState<TipoServico[]>([])

  const [dados, setDados] = useState<ResumoPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [erroResumo, setErroResumo] = useState('')
  const [exportandoPdf, setExportandoPdf] = useState(false)
  const [erroPdf, setErroPdf] = useState('')
  const [exportandoExcel, setExportandoExcel] = useState(false)
  const [erroExcel, setErroExcel] = useState('')

  // Tabela operacional
  const [operacional, setOperacional] = useState<SolicitacaoOperacional[]>([])
  const [operacionalTotal, setOperacionalTotal] = useState(0)
  const [operacionalPage, setOperacionalPage] = useState(1)
  const [operacionalLimit, setOperacionalLimit] = useState(15)
  const [operacionalLoading, setOperacionalLoading] = useState(false)
  const [erroOperacional, setErroOperacional] = useState('')

  useEffect(() => {
    fetch('/api/categorias').then((r) => r.json()).then((d) => setCategorias(d.categorias || []))
    fetch('/api/tipos-servico').then((r) => r.json()).then((d) => setTiposServico(d.tiposServico || []))
  }, [])

  useEffect(() => {
    const t = setTimeout(() => setBuscaDebounced(busca.trim()), 350)
    return () => clearTimeout(t)
  }, [busca])

  const queryString = useMemo(() => {
    const params = new URLSearchParams()
    if (modoData === 'mes') {
      if (mes) params.set('mes', mes)
    } else {
      if (dataInicio) params.set('dataInicio', dataInicio)
      if (dataFim) params.set('dataFim', dataFim)
    }
    if (tipoEmprestimo) params.set('tipoEmprestimo', tipoEmprestimo)
    if (origem) params.set('origem', origem)
    if (prazo) params.set('prazo', prazo)
    if (status) params.set('status', status)
    if (categoriaId) params.set('categoriaId', categoriaId)
    if (tipoServicoId) params.set('tipoServicoId', tipoServicoId)
    if (periodoFiltro) params.set('periodo', periodoFiltro)
    if (pendente) params.set('pendente', 'true')
    if (naoRetirada) params.set('naoRetirada', 'true')
    return params.toString()
  }, [modoData, mes, dataInicio, dataFim, tipoEmprestimo, origem, prazo, status, categoriaId, tipoServicoId, periodoFiltro, pendente, naoRetirada])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setErroResumo('')
    fetch(`/api/relatorios/resumo?${queryString}`, { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) {
          const payload = await r.json().catch(() => null)
          throw new Error(payload?.message || 'Não foi possível carregar o relatório.')
        }
        return r.json()
      })
      .then((d) => setDados(d))
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setDados(null)
        setErroResumo(error instanceof Error ? error.message : 'Não foi possível carregar o relatório.')
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [queryString])

  useEffect(() => {
    if (visao !== 'operacional') return
    const controller = new AbortController()
    setOperacionalLoading(true)
    setErroOperacional('')
    const params = new URLSearchParams(queryString)
    params.set('page', String(operacionalPage))
    params.set('limit', String(operacionalLimit))
    if (buscaDebounced) params.set('busca', buscaDebounced)
    fetch(`/api/relatorios/operacional?${params}`, { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) {
          const payload = await r.json().catch(() => null)
          throw new Error(payload?.message || 'Não foi possível carregar a tabela operacional.')
        }
        return r.json()
      })
      .then((d) => { setOperacional(d.solicitacoes || []); setOperacionalTotal(d.total || 0) })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setOperacional([])
        setOperacionalTotal(0)
        setErroOperacional(error instanceof Error ? error.message : 'Não foi possível carregar a tabela operacional.')
      })
      .finally(() => {
        if (!controller.signal.aborted) setOperacionalLoading(false)
      })
    return () => controller.abort()
  }, [visao, queryString, operacionalPage, operacionalLimit, buscaDebounced])

  useEffect(() => { setOperacionalPage(1) }, [queryString, buscaDebounced, operacionalLimit])

  const emAndamento = useMemo(() => {
    if (!dados) return 0
    return dados.statusDist.filter((s) => !STATUS_ENCERRADOS.includes(s.status)).reduce((acc, s) => acc + s.quantidade, 0)
  }, [dados])

  const taxaRetirada = useMemo(() => {
    if (!dados) return null
    const denom = dados.operacao.retiradas + dados.operacao.naoRetiradas
    return denom > 0 ? (dados.operacao.retiradas / denom) * 100 : null
  }, [dados])

  const periodoLabelAtual = modoData === 'mes' ? mesLabelCompleto(mes) : (dataInicio && dataFim ? `${formatDate(dataInicio)} — ${formatDate(dataFim)}` : 'Período personalizado')

  async function exportarPdf() {
    if (exportandoPdf) return
    setExportandoPdf(true)
    setErroPdf('')
    try {
      const response = await fetch(`/api/relatorios/pdf?${queryString}`)
      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        throw new Error(payload?.message || 'Não foi possível gerar o PDF.')
      }
      const blob = await response.blob()
      const disposition = response.headers.get('content-disposition') || ''
      const nome = disposition.match(/filename="?([^";]+)"?/i)?.[1] || 'relatorio-gerencial.pdf'
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = nome
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch (error) {
      setErroPdf(error instanceof Error ? error.message : 'Não foi possível gerar o PDF.')
    } finally {
      setExportandoPdf(false)
    }
  }

  async function exportarExcel() {
    if (exportandoExcel) return
    setExportandoExcel(true)
    setErroExcel('')
    try {
      const response = await fetch(`/api/relatorios/excel?${queryString}`)
      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        throw new Error(payload?.message || 'Não foi possível gerar o Excel.')
      }
      const blob = await response.blob()
      const disposition = response.headers.get('content-disposition') || ''
      const nome = disposition.match(/filename="?([^";]+)"?/i)?.[1] || 'relatorio-patrimonio.xlsx'
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = nome
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch (error) {
      setErroExcel(error instanceof Error ? error.message : 'Não foi possível gerar o Excel.')
    } finally {
      setExportandoExcel(false)
    }
  }

  return (
    <div className="max-w-7xl space-y-6">
      {/* Cabeçalho executivo — só na Visão Gerencial */}
      {visao === 'gerencial' && (
        <div className="bg-gradient-to-r from-brand to-brand-dark rounded-2xl px-6 py-5 text-white flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <p className="text-xs uppercase tracking-wider text-blue-200 font-medium">Relatório Gerencial — Patrimônio</p>
            <h2 className="text-xl sm:text-2xl font-bold capitalize mt-0.5">{periodoLabelAtual}</h2>
          </div>
          <p className="text-sm text-blue-100">Fluxo Patrimonial</p>
        </div>
      )}

      {/* Toggle de visão */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex gap-2">
          <button
            onClick={() => setVisao('gerencial')}
            className={cn('flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium', visao === 'gerencial' ? 'bg-brand text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300')}
          >
            <BarChart3 size={16} /> Visão Gerencial
          </button>
          <button
            onClick={() => setVisao('operacional')}
            className={cn('flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium', visao === 'operacional' ? 'bg-brand text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300')}
          >
            <ClipboardList size={16} /> Visão Operacional
          </button>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={exportarPdf}
            disabled={exportandoPdf}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-brand text-white hover:bg-brand-dark disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {exportandoPdf ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
            {exportandoPdf ? 'Gerando PDF...' : 'Exportar PDF'}
          </button>
          <button
            type="button"
            onClick={exportarExcel}
            disabled={exportandoExcel}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-brand text-white hover:bg-brand-dark disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {exportandoExcel ? <Loader2 size={16} className="animate-spin" /> : <FileSpreadsheet size={16} />}
            {exportandoExcel ? 'Gerando Excel...' : 'Exportar Excel'}
          </button>
        </div>
      </div>
      {erroPdf && <div role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3">{erroPdf}</div>}
      {erroExcel && <div role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3">{erroExcel}</div>}
      {erroResumo && <div role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3">{erroResumo}</div>}
      {visao === 'operacional' && erroOperacional && <div role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3">{erroOperacional}</div>}

      {/* Filtros */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm p-4 sm:p-5 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
            <button onClick={() => setModoData('mes')} className={cn('px-3 py-1.5 rounded-md text-xs font-medium', modoData === 'mes' ? 'bg-white dark:bg-gray-700 shadow-sm' : 'text-gray-500')}>Mês/Ano</button>
            <button onClick={() => setModoData('personalizado')} className={cn('px-3 py-1.5 rounded-md text-xs font-medium', modoData === 'personalizado' ? 'bg-white dark:bg-gray-700 shadow-sm' : 'text-gray-500')}>Período personalizado</button>
          </div>

          {modoData === 'mes' ? (
            <input type="month" value={mes} onChange={(e) => setMes(e.target.value)} aria-label="Mês de referência" className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition" />
          ) : (
            <>
              <input type="date" value={dataInicio} onChange={(e) => setDataInicio(e.target.value)} aria-label="Data inicial" className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition" />
              <span className="text-gray-400 text-sm">até</span>
              <input type="date" value={dataFim} onChange={(e) => setDataFim(e.target.value)} aria-label="Data final" className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition" />
            </>
          )}

          {visao === 'gerencial' && (
            <button
              onClick={() => setMaisFiltrosAberto((v) => !v)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 ml-auto"
            >
              <SlidersHorizontal size={13} /> Mais filtros {maisFiltrosAberto ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </button>
          )}
        </div>

        {(visao === 'operacional' || maisFiltrosAberto) && (
          <FiltrosAvancados
            tipoEmprestimo={tipoEmprestimo} setTipoEmprestimo={setTipoEmprestimo}
            origem={origem} setOrigem={setOrigem}
            prazo={prazo} setPrazo={setPrazo}
            status={status} setStatus={setStatus}
            categoriaId={categoriaId} setCategoriaId={setCategoriaId}
            tipoServicoId={tipoServicoId} setTipoServicoId={setTipoServicoId}
            periodoFiltro={periodoFiltro} setPeriodoFiltro={setPeriodoFiltro}
            categorias={categorias} tiposServico={tiposServico}
          />
        )}

        {visao === 'operacional' && (
          <div className="pt-2 border-t border-gray-100 dark:border-gray-800 space-y-2.5">
            <div className="relative max-w-md">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                placeholder="Buscar por número, solicitante ou patrimônio"
                aria-label="Buscar por número, solicitante ou patrimônio"
                className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <ChipAtalho ativo={prazo === 'fora'} onClick={() => setPrazo(prazo === 'fora' ? '' : 'fora')} label="Fora do prazo" />
              <ChipAtalho ativo={naoRetirada} onClick={() => setNaoRetirada((v) => !v)} label="Retirada vencida" />
              <ChipAtalho ativo={pendente} onClick={() => setPendente((v) => !v)} label="Pendentes" />
              <ChipAtalho ativo={origem === 'ATENDIMENTO_IMEDIATO'} onClick={() => setOrigem(origem === 'ATENDIMENTO_IMEDIATO' ? '' : 'ATENDIMENTO_IMEDIATO')} label="Atendimentos imediatos" />
            </div>
          </div>
        )}
      </div>

      {loading ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[...Array(8)].map((_, i) => <div key={i} className="h-24 bg-gray-100 dark:bg-gray-800 rounded-2xl animate-pulse" />)}
        </div>
      ) : erroResumo ? (
        <div className="rounded-2xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/20 px-4 py-10 text-center text-sm text-red-700 dark:text-red-300">
          Não foi possível carregar os dados do relatório.
        </div>
      ) : !dados ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[...Array(8)].map((_, i) => <div key={i} className="h-24 bg-gray-100 dark:bg-gray-800 rounded-2xl animate-pulse" />)}
        </div>
      ) : visao === 'gerencial' ? (
        <VisaoGerencial dados={dados} emAndamento={emAndamento} taxaRetirada={taxaRetirada} />
      ) : (
        <VisaoOperacional
          solicitacoes={operacional}
          total={operacionalTotal}
          page={operacionalPage}
          limit={operacionalLimit}
          loading={operacionalLoading}
          onPageChange={setOperacionalPage}
          onLimitChange={setOperacionalLimit}
        />
      )}
    </div>
  )
}

// =============================================================================
// Filtros avançados (compartilhado entre Gerencial expansível e Operacional fixo)
// =============================================================================

function FiltrosAvancados({
  tipoEmprestimo, setTipoEmprestimo, origem, setOrigem, prazo, setPrazo, status, setStatus,
  categoriaId, setCategoriaId, tipoServicoId, setTipoServicoId, periodoFiltro, setPeriodoFiltro,
  categorias, tiposServico,
}: {
  tipoEmprestimo: string; setTipoEmprestimo: (v: string) => void
  origem: string; setOrigem: (v: string) => void
  prazo: string; setPrazo: (v: string) => void
  status: string; setStatus: (v: string) => void
  categoriaId: string; setCategoriaId: (v: string) => void
  tipoServicoId: string; setTipoServicoId: (v: string) => void
  periodoFiltro: string; setPeriodoFiltro: (v: string) => void
  categorias: CategoriaPatrimonio[]; tiposServico: TipoServico[]
}) {
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      <select value={tipoEmprestimo} onChange={(e) => setTipoEmprestimo(e.target.value)} aria-label="Filtrar por tipo de empréstimo" className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-xs focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition">
        <option value="">Tipo: Todos</option>
        <option value="interno">Interna</option>
        <option value="externo">Externa</option>
      </select>
      <select value={origem} onChange={(e) => setOrigem(e.target.value)} aria-label="Filtrar por origem" className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-xs focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition">
        <option value="">Origem: Todas</option>
        <option value="RESERVA">Reserva antecipada</option>
        <option value="ATENDIMENTO_IMEDIATO">Atendimento imediato</option>
      </select>
      <select value={prazo} onChange={(e) => setPrazo(e.target.value)} aria-label="Filtrar por prazo" className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-xs focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition">
        <option value="">Prazo: Todos</option>
        <option value="dentro">Dentro do prazo</option>
        <option value="fora">Fora do prazo</option>
      </select>
      <select value={periodoFiltro} onChange={(e) => setPeriodoFiltro(e.target.value)} aria-label="Filtrar por turno" className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-xs focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition">
        <option value="">Turno: Todos</option>
        {(['MANHA', 'TARDE', 'NOITE'] as PeriodoSolicitacao[]).map((p) => <option key={p} value={p}>{PERIODO_LABELS[p]}</option>)}
      </select>
      <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filtrar por status" className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-xs focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition">
        <option value="">Status: Todos</option>
        {Object.entries(STATUS_SOLICITACAO_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
      <select value={categoriaId} onChange={(e) => setCategoriaId(e.target.value)} aria-label="Filtrar por categoria" className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-xs focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition">
        <option value="">Categoria: Todas</option>
        {categorias.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
      </select>
      <select value={tipoServicoId} onChange={(e) => setTipoServicoId(e.target.value)} aria-label="Filtrar por tipo de serviço" className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-xs focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition">
        <option value="">Serviço: Todos</option>
        {tiposServico.map((t) => <option key={t.id} value={t.id}>{t.nome}</option>)}
      </select>
    </div>
  )
}

function ChipAtalho({ ativo, onClick, label }: { ativo: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'px-3 py-1.5 rounded-full text-xs font-medium border transition',
        ativo ? 'bg-highlight text-white border-highlight' : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700'
      )}
    >
      {label}
    </button>
  )
}

// =============================================================================
// VISÃO GERENCIAL
// =============================================================================

function VisaoGerencial({ dados, emAndamento, taxaRetirada }: {
  dados: ResumoPayload; emAndamento: number; taxaRetirada: number | null
}) {
  const { resumo, operacao, bens, papelaria, servicos, atendimentoImediato, antecedenciaMedia, distribuicaoPeriodo, evolucaoMensal, comparativoMesAnterior, resumoExecutivo } = dados

  // Prazo: registros sem classificação (criados antes do controle histórico
  // de prazo) — NUNCA recalculados, apenas exibidos como categoria própria.
  const semClassificacao = Math.max(0, resumo.reservasAntecipadas - resumo.dentroPrazo - resumo.foraPrazo)
  const baseClassificada = resumo.dentroPrazo + resumo.foraPrazo

  const evolucaoData = evolucaoMensal.map((m) => ({
    mes: mesLabel(m.mes),
    Total: m.total,
    Internas: m.internas,
    Externas: m.externas,
    'Atend. Imediato': m.atendimentosImediatos,
  }))
  const mesesComDados = evolucaoMensal.filter((m) => m.total > 0).length

  const evolucaoPrazoData = evolucaoMensal.map((m) => {
    const denom = m.dentroPrazo + m.foraPrazo
    return { mes: mesLabel(m.mes), '% Fora do prazo': denom > 0 ? Number(((m.foraPrazo / denom) * 100).toFixed(1)) : 0 }
  })

  const periodoData = distribuicaoPeriodo.map((p) => ({
    periodo: PERIODO_LABELS[p.periodo],
    Reservas: p.reservas,
    'Atend. Imediato': p.atendimentosImediatos,
  }))

  const categoriaData = bens.rankingCategorias.slice(0, 8).map((c) => ({ nome: c.categoriaNome, Utilizações: c.utilizacoes }))
  const servicoData = servicos.ranking.slice(0, 8).map((s) => ({ nome: s.nome, Ocorrências: s.ocorrencias }))

  // Destaques do mês — regras fixas, sem IA, máximo 3, só com base suficiente.
  const destaques: string[] = []
  if (baseClassificada > 0) {
    const p = (resumo.foraPrazo / baseClassificada) * 100
    destaques.push(`${p.toFixed(1)}% das reservas classificadas foram realizadas fora do prazo.`)
  }
  if (resumo.total > 0 && resumo.atendimentosImediatos > 0) {
    destaques.push(`${atendimentoImediato.percentualDemanda.toFixed(1)}% dos atendimentos do período ocorreram sem reserva prévia.`)
  }
  if (bens.rankingCategorias[0]) {
    destaques.push(`${bens.rankingCategorias[0].categoriaNome} foi a categoria patrimonial mais utilizada no período.`)
  }
  if (servicos.totalServicosRealizados > 0 && destaques.length < 3) {
    destaques.push(`Foram realizados ${servicos.totalServicosRealizados} ${plural(servicos.totalServicosRealizados, 'serviço/movimentação', 'serviços/movimentações')} pelo Patrimônio.`)
  }

  return (
    <div className="space-y-8">
      {/* KPIs hero — Total / Reservas / Atendimento imediato */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <KpiHero
          icon={<ClipboardList size={22} />} label="Total de atendimentos" value={resumo.total} color="blue"
          tendencia={comparativoMesAnterior ? { campo: comparativoMesAnterior.total, semantica: 'neutro' } : undefined}
        />
        <KpiHero
          icon={<CalendarClock size={22} />} label="Reservas antecipadas" value={resumo.reservasAntecipadas}
          sub={`${pct(resumo.reservasAntecipadas, resumo.total)} da demanda`} color="indigo"
        />
        <KpiHero
          icon={<Zap size={22} />} label="Atendimentos imediatos" value={resumo.atendimentosImediatos}
          sub={`${pct(resumo.atendimentosImediatos, resumo.total)} da demanda`} color="purple"
          tendencia={comparativoMesAnterior ? { campo: comparativoMesAnterior.atendimentosImediatos, semantica: 'neutro' } : undefined}
        />
      </div>

      {/* KPIs hero — Prazo */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <KpiHero
          icon={<CheckCircle2 size={22} />} label="Dentro do prazo" value={resumo.percentualDentroPrazo !== null ? `${resumo.percentualDentroPrazo.toFixed(1)}%` : '—'}
          sub={`${resumo.dentroPrazo} ${plural(resumo.dentroPrazo, 'reserva', 'reservas')}`} color="green"
          tendencia={comparativoMesAnterior ? { campo: comparativoMesAnterior.dentroPrazo, semantica: 'sobe-bom' } : undefined}
        />
        <KpiHero
          icon={<XCircle size={22} />} label="Fora do prazo" value={resumo.percentualDentroPrazo !== null ? `${(100 - resumo.percentualDentroPrazo).toFixed(1)}%` : '—'}
          sub={`${resumo.foraPrazo} ${plural(resumo.foraPrazo, 'reserva', 'reservas')}`} color="red"
          tendencia={comparativoMesAnterior ? { campo: comparativoMesAnterior.foraPrazo, semantica: 'desce-bom' } : undefined}
        />
      </div>

      {/* KPIs secundários */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiSecundario icon={<Building2 size={16} />} label="Internas" value={resumo.internas} />
        <KpiSecundario icon={<MapPin size={16} />} label="Externas" value={resumo.externas} />
        <KpiSecundario icon={<CheckCircle2 size={16} />} label="Finalizadas" value={operacao.finalizadas} />
        <KpiSecundario icon={<Clock size={16} />} label="Em andamento" value={emAndamento} />
        <KpiSecundario icon={<Ban size={16} />} label="Canceladas" value={operacao.canceladas} tendencia={comparativoMesAnterior ? tendenciaCampo(comparativoMesAnterior.canceladas, 'desce-bom') : undefined} />
        <KpiSecundario icon={<Undo2 size={16} />} label="Não retiradas" value={operacao.naoRetiradas} tendencia={comparativoMesAnterior ? tendenciaCampo(comparativoMesAnterior.naoRetiradas, 'desce-bom') : undefined} />
        <KpiSecundario icon={<Laptop size={16} />} label="Bens movimentados" value={bens.totalBensMovimentados} />
        <KpiSecundario icon={<PackageIcon size={16} />} label="Solicitações c/ papelaria" value={papelaria.solicitacoesComPapelaria} />
        <KpiSecundario icon={<Wrench size={16} />} label="Serviços/Movimentações" value={servicos.totalServicosRealizados} />
      </div>

      {/* Destaques do mês */}
      {destaques.length > 0 && (
        <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-2xl p-5 sm:p-6">
          <h3 className="font-semibold text-amber-900 dark:text-amber-300 mb-3 flex items-center gap-2"><Lightbulb size={18} /> Destaques do mês</h3>
          <ul className="space-y-1.5">
            {destaques.slice(0, 3).map((d, i) => (
              <li key={i} className="text-sm text-amber-800 dark:text-amber-200 flex gap-2">
                <span className="text-amber-400">•</span>{d}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Cumprimento do prazo detalhado */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm p-5 sm:p-6">
        <h3 className="font-semibold text-gray-900 dark:text-white mb-4">Cumprimento do prazo de solicitação</h3>

        {/* Barra de proporção: dentro / fora / sem classificação */}
        <div className="w-full h-4 rounded-full overflow-hidden flex bg-gray-100 dark:bg-gray-800 mb-4">
          {resumo.reservasAntecipadas > 0 && (
            <>
              <div className="bg-emerald-500 h-full" style={{ width: `${(resumo.dentroPrazo / resumo.reservasAntecipadas) * 100}%` }} title={`Dentro do prazo: ${resumo.dentroPrazo}`} />
              <div className="bg-red-500 h-full" style={{ width: `${(resumo.foraPrazo / resumo.reservasAntecipadas) * 100}%` }} title={`Fora do prazo: ${resumo.foraPrazo}`} />
              <div className="bg-gray-300 dark:bg-gray-600 h-full" style={{ width: `${(semClassificacao / resumo.reservasAntecipadas) * 100}%` }} title={`Sem classificação: ${semClassificacao}`} />
            </>
          )}
        </div>

        <div className="grid sm:grid-cols-3 gap-4 mb-2">
          <LegendaProporcao cor="bg-emerald-500" label="Dentro do prazo" valor={resumo.dentroPrazo} />
          <LegendaProporcao cor="bg-red-500" label="Fora do prazo" valor={resumo.foraPrazo} />
          <LegendaProporcao cor="bg-gray-300 dark:bg-gray-600" label="Sem classificação" valor={semClassificacao} />
        </div>
        <p className="text-xs text-gray-400 mb-4">
          Base considerada para o percentual: {baseClassificada} {plural(baseClassificada, 'reserva classificada', 'reservas classificadas')}.
          {semClassificacao > 0 && ' Solicitações sem classificação foram criadas antes da implantação do controle histórico de prazo e não são recalculadas retroativamente.'}
          {' '}Atendimentos imediatos ({resumo.atendimentosImediatos}) não entram neste cálculo — não há antecedência a medir.
        </p>

        <div className="pt-4 border-t border-gray-100 dark:border-gray-800">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Antecedência média</p>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div className="px-4 py-3 bg-gray-50 dark:bg-gray-800 rounded-xl">
              <p className="text-gray-500">Interna</p>
              <p className="font-semibold text-gray-900 dark:text-white">{antecedenciaMedia.internasMinutos !== null ? formatarAntecedencia(antecedenciaMedia.internasMinutos) : '—'}</p>
            </div>
            <div className="px-4 py-3 bg-gray-50 dark:bg-gray-800 rounded-xl">
              <p className="text-gray-500">Externa</p>
              <p className="font-semibold text-gray-900 dark:text-white">{antecedenciaMedia.externasMinutos !== null ? formatarAntecedencia(antecedenciaMedia.externasMinutos) : '—'}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Gráficos */}
      <div className="grid lg:grid-cols-2 gap-6">
        <GraficoCard titulo="Evolução das solicitações (12 meses)">
          {mesesComDados < 3 ? (
            <EstadoHistoricoFormacao />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={evolucaoData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="mes" fontSize={12} />
                <YAxis fontSize={12} allowDecimals={false} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="Total" stroke="#0F6B63" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="Internas" stroke="#3D8F86" strokeWidth={1.5} dot={false} />
                <Line type="monotone" dataKey="Externas" stroke="#C08A2E" strokeWidth={1.5} dot={false} />
                <Line type="monotone" dataKey="Atend. Imediato" stroke="#7c3aed" strokeWidth={1.5} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </GraficoCard>

        <GraficoCard titulo="Evolução do % fora do prazo">
          {mesesComDados < 3 ? (
            <EstadoHistoricoFormacao />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={evolucaoPrazoData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="mes" fontSize={12} />
                <YAxis fontSize={12} unit="%" />
                <Tooltip />
                <Line type="monotone" dataKey="% Fora do prazo" stroke="#dc2626" strokeWidth={2} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </GraficoCard>

        <GraficoCard titulo="Atendimentos por período (turno)">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={periodoData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="periodo" fontSize={12} />
              <YAxis fontSize={12} allowDecimals={false} />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="Reservas" fill="#0F6B63" radius={[4, 4, 0, 0]} />
              <Bar dataKey="Atend. Imediato" fill="#C08A2E" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </GraficoCard>

        <GraficoCard titulo="Categorias patrimoniais mais utilizadas">
          {categoriaData.length === 0 ? <EstadoVazioGrafico /> : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={categoriaData} layout="vertical" margin={{ left: 20, right: 24 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis type="number" fontSize={12} allowDecimals={false} hide />
                <YAxis type="category" dataKey="nome" fontSize={12} width={110} />
                <Tooltip />
                <Bar dataKey="Utilizações" fill="#0F6B63" radius={[0, 4, 4, 0]}>
                  <LabelList dataKey="Utilizações" position="right" fontSize={12} fill="#374151" />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </GraficoCard>
      </div>

      {/* Patrimônios mais utilizados + Serviços */}
      <div className="grid lg:grid-cols-2 gap-6">
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm p-5 sm:p-6">
          <h3 className="font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2"><Laptop size={18} className="text-brand" /> Equipamentos mais movimentados</h3>
          {bens.rankingPatrimonios.length === 0 ? <EstadoVazioGrafico /> : (
            <ol className="space-y-2">
              {bens.rankingPatrimonios.slice(0, 8).map((p, i) => (
                <li key={p.patrimonioId} className="flex items-center justify-between text-sm px-3 py-2 bg-gray-50 dark:bg-gray-800 rounded-lg">
                  <span className="text-gray-700 dark:text-gray-300 truncate"><span className="text-gray-400 mr-2">{i + 1}.</span>{p.numero} — {p.marca} {p.modelo}</span>
                  <span className="font-semibold text-brand shrink-0 ml-2">{p.utilizacoes}x</span>
                </li>
              ))}
            </ol>
          )}
        </div>

        <GraficoCard titulo="Serviços / Movimentações mais realizados">
          {servicoData.length === 0 ? <EstadoVazioGrafico /> : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={servicoData} layout="vertical" margin={{ left: 20, right: 24 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis type="number" fontSize={12} allowDecimals={false} hide />
                <YAxis type="category" dataKey="nome" fontSize={12} width={130} />
                <Tooltip />
                <Bar dataKey="Ocorrências" fill="#C08A2E" radius={[0, 4, 4, 0]}>
                  <LabelList dataKey="Ocorrências" position="right" fontSize={12} fill="#374151" />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </GraficoCard>
      </div>

      {/* Atendimento Imediato */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm p-5 sm:p-6">
        <h3 className="font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2"><Zap size={18} className="text-purple-600" /> Atendimentos sem reserva prévia</h3>
        <div className="grid sm:grid-cols-2 gap-6">
          <div className="flex items-center gap-4">
            <div className="w-16 h-16 rounded-full bg-purple-50 dark:bg-purple-950 flex items-center justify-center text-purple-600 font-bold text-xl shrink-0">
              {atendimentoImediato.total}
            </div>
            <div>
              <p className="text-sm font-medium text-gray-900 dark:text-white">Atendimentos imediatos</p>
              <p className="text-xs text-gray-500">{atendimentoImediato.percentualDemanda.toFixed(1)}% da demanda total do período</p>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="px-2 py-3 bg-gray-50 dark:bg-gray-800 rounded-xl">
              <p className="text-lg font-bold text-gray-900 dark:text-white">{atendimentoImediato.comBens}</p>
              <p className="text-xs text-gray-500">com bens</p>
            </div>
            <div className="px-2 py-3 bg-gray-50 dark:bg-gray-800 rounded-xl">
              <p className="text-lg font-bold text-gray-900 dark:text-white">{atendimentoImediato.comPapelaria}</p>
              <p className="text-xs text-gray-500">com papelaria</p>
            </div>
            <div className="px-2 py-3 bg-gray-50 dark:bg-gray-800 rounded-xl">
              <p className="text-lg font-bold text-gray-900 dark:text-white">{atendimentoImediato.comServico}</p>
              <p className="text-xs text-gray-500">com serviço</p>
            </div>
          </div>
        </div>
        <p className="text-xs text-gray-400 mt-4 flex items-start gap-1.5">
          <Info size={13} className="mt-0.5 shrink-0" />
          Um atendimento pode conter bens, papelaria e serviços simultaneamente; por isso essas categorias não são mutuamente exclusivas.
        </p>
      </div>

      {/* Papelaria + Eficiência operacional */}
      <div className="grid lg:grid-cols-2 gap-6">
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm p-5 sm:p-6">
          <h3 className="font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2"><PackageIcon size={18} className="text-brand" /> Papelaria</h3>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div className="px-3 py-3 bg-gray-50 dark:bg-gray-800 rounded-xl">
              <p className="text-xl font-bold text-gray-900 dark:text-white">{papelaria.solicitacoesComPapelaria}</p>
              <p className="text-xs text-gray-500">solicitações c/ papelaria</p>
            </div>
            <div className="px-3 py-3 bg-gray-50 dark:bg-gray-800 rounded-xl">
              <p className="text-xl font-bold text-gray-900 dark:text-white">{papelaria.quantidadeTotalItens}</p>
              <p className="text-xs text-gray-500">itens solicitados</p>
            </div>
          </div>
          {papelaria.itensMaisSolicitados.length > 0 && (
            <ul className="space-y-1.5 text-sm">
              {papelaria.itensMaisSolicitados.slice(0, 6).map((i) => (
                <li key={i.descricaoNormalizada} className="flex justify-between px-3 py-1.5 bg-gray-50 dark:bg-gray-800 rounded-lg text-gray-700 dark:text-gray-300">
                  <span className="capitalize">{i.descricaoNormalizada}</span>
                  <span className="font-medium">{i.quantidadeTotal}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm p-5 sm:p-6">
          <h3 className="font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2"><Truck size={18} className="text-brand" /> Eficiência operacional</h3>
          <div className="grid grid-cols-2 gap-3">
            <MiniStat icon={<PackageCheck size={14} />} label="Prontas p/ retirada" value={operacao.prontasRetirada} />
            <MiniStat icon={<Truck size={14} />} label="Retiradas" value={operacao.retiradas} />
            <MiniStat icon={<Undo2 size={14} />} label="Não retiradas" value={operacao.naoRetiradas} />
            <MiniStat icon={<Clock size={14} />} label="Em utilização" value={operacao.emUtilizacao} />
            <MiniStat icon={<CheckCircle2 size={14} />} label="Finalizadas" value={operacao.finalizadas} />
            <MiniStat icon={<Ban size={14} />} label="Canceladas" value={operacao.canceladas} />
          </div>
          <div
            className="mt-3 px-3 py-2.5 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900 rounded-xl flex items-center justify-between cursor-help"
            title="Solicitações PRONTA_RETIRADA cuja data de utilização já passou e que ainda não tiveram retirada nem 'não retirado' registrados — alerta operacional, não soma ao KPI 'Não retiradas'."
          >
            <span className="text-sm text-amber-800 dark:text-amber-300 flex items-center gap-1.5"><AlertTriangle size={13} /> Retirada vencida s/ registro <Info size={12} className="text-amber-500" /></span>
            <span className="font-semibold text-amber-700 dark:text-amber-400">{operacao.retiradasVencidasSemRegistro}</span>
          </div>
          <div
            className="mt-2 px-3 py-2.5 bg-brand/5 border border-brand/20 rounded-xl flex items-center justify-between cursor-help"
            title="Percentual de reservas elegíveis para retirada (retiradas + não retiradas registradas) que tiveram retirada registrada."
          >
            <span className="text-sm text-gray-700 dark:text-gray-300 flex items-center gap-1.5">Taxa de retirada <Info size={12} className="text-gray-400" /></span>
            <span className="font-semibold text-brand">{taxaRetirada !== null ? `${taxaRetirada.toFixed(1)}%` : '—'}</span>
          </div>
        </div>
      </div>

      {/* Resumo executivo */}
      <div className="bg-gradient-to-br from-brand to-brand-dark rounded-2xl p-6 sm:p-7 text-white">
        <h3 className="font-semibold mb-3 flex items-center gap-2"><Users size={18} /> Resumo executivo</h3>
        <p className="text-sm leading-relaxed text-blue-50">{resumoExecutivo}</p>
      </div>
    </div>
  )
}

// =============================================================================
// VISÃO OPERACIONAL
// =============================================================================

function VisaoOperacional({ solicitacoes, total, page, limit, loading, onPageChange, onLimitChange }: {
  solicitacoes: SolicitacaoOperacional[]; total: number; page: number; limit: number; loading: boolean
  onPageChange: (p: number) => void; onLimitChange: (l: number) => void
}) {
  const totalPaginas = Math.max(1, Math.ceil(total / limit))
  const inicio = total === 0 ? 0 : (page - 1) * limit + 1
  const fim = Math.min(total, page * limit)

  const paginas = useMemo(() => {
    const arr: number[] = []
    const start = Math.max(1, page - 2)
    const end = Math.min(totalPaginas, start + 4)
    for (let i = start; i <= end; i++) arr.push(i)
    return arr
  }, [page, totalPaginas])

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-gray-500">
          {loading ? 'Carregando...' : total === 0 ? '0 registros encontrados' : total <= limit ? `${total} ${plural(total, 'registro encontrado', 'registros encontrados')}` : `Mostrando ${inicio}–${fim} de ${total} registros`}
        </p>
        <p className="sm:hidden text-xs text-gray-400 flex items-center gap-1 shrink-0">
          <span aria-hidden="true">↔</span> Arraste para o lado
        </p>
      </div>

      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800 text-left text-xs text-gray-500 uppercase">
              <tr>
                {['Nº', 'Solicitante', 'Data da utilização', 'Tipo', 'Origem', 'Período', 'Status', 'Prazo', 'Bens', 'Papelaria', 'Serviços', 'Retirada', 'Devolução'].map((h) => (
                  <th key={h} className="px-3 py-3 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {loading ? (
                [...Array(6)].map((_, i) => (
                  <tr key={i}>
                    {[...Array(13)].map((_, j) => (
                      <td key={j} className="px-3 py-3"><div className="h-3 bg-gray-100 dark:bg-gray-800 rounded animate-pulse" /></td>
                    ))}
                  </tr>
                ))
              ) : solicitacoes.length === 0 ? (
                <tr><td colSpan={13} className="px-4 py-10 text-center text-gray-400">Nenhuma solicitação encontrada para os filtros aplicados.</td></tr>
              ) : (
                solicitacoes.map((s) => (
                  <tr key={s.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                    <td className="px-3 py-2.5">
                      <Link href={`/solicitacoes/${s.id}`} className="flex items-center gap-1 font-medium text-brand hover:underline">
                        #{s.numero} <ChevronRight size={12} />
                      </Link>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">{s.solicitante.nome}</td>
                    {/* s.data é a DATA CIVIL da reserva (@db.Date) — formatDataCivil(), não formatDate()
                        (ver Etapa D.3.FOLLOW-UP). createdAt (título) e retiradaEm/devolucaoEm abaixo
                        continuam com formatDateTime()/formatDate(): são instantes reais, fora do
                        escopo desta correção (ver item 3 do pedido desta etapa). */}
                    <td className="px-3 py-2.5 whitespace-nowrap" title={`Criada em: ${formatDateTime(s.createdAt)}`}>{formatDataCivil(s.data)}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap">{TIPO_EMPRESTIMO_LABELS[s.tipoEmprestimo]}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap">{ORIGEM_LABELS[s.origem]}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      {s.periodos.length > 0 ? s.periodos.map((p) => PERIODO_LABELS[p]).join(', ') : (
                        <span className="text-gray-400 cursor-help" title="Período não registrado neste atendimento.">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="max-w-[150px] truncate" title={STATUS_SOLICITACAO_LABELS[s.status]}>
                        <StatusSolicitacaoBadge status={s.status} />
                      </div>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      {s.dentroDoPrazo === null ? (
                        <span className="text-gray-400 cursor-help" title="Solicitação criada antes da implantação do controle de prazo.">Não disponível</span>
                      ) : s.dentroDoPrazo ? (
                        <span className="text-emerald-600 font-medium">Dentro</span>
                      ) : (
                        <span className="text-red-600 font-medium">Fora</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-center">{s._count.itensPatrimonio || '—'}</td>
                    <td className="px-3 py-2.5 text-center">{s._count.itensPapelaria || '—'}</td>
                    <td className="px-3 py-2.5 text-center">{s._count.itensServico || '—'}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap">{s.retiradaEm ? formatDate(s.retiradaEm) : '—'}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap">{s.devolucaoEm ? formatDate(s.devolucaoEm) : '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-4 py-3 border-t border-gray-100 dark:border-gray-800">
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span>Itens por página:</span>
            {[15, 30, 50].map((n) => (
              <button key={n} onClick={() => onLimitChange(n)} className={cn('px-2 py-1 rounded-md', limit === n ? 'bg-brand text-white' : 'bg-gray-100 dark:bg-gray-800')}>{n}</button>
            ))}
          </div>

          {totalPaginas > 1 && (
            <div className="flex items-center gap-1">
              <button onClick={() => onPageChange(Math.max(1, page - 1))} disabled={page <= 1} className="p-1.5 rounded-lg bg-gray-100 dark:bg-gray-800 disabled:opacity-40">
                <ChevronLeft size={14} />
              </button>
              {paginas[0] > 1 && <span className="text-xs text-gray-400 px-1">…</span>}
              {paginas.map((p) => (
                <button key={p} onClick={() => onPageChange(p)} className={cn('w-7 h-7 rounded-lg text-xs font-medium', p === page ? 'bg-brand text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300')}>{p}</button>
              ))}
              {paginas[paginas.length - 1] < totalPaginas && <span className="text-xs text-gray-400 px-1">…</span>}
              <button onClick={() => onPageChange(Math.min(totalPaginas, page + 1))} disabled={page >= totalPaginas} className="p-1.5 rounded-lg bg-gray-100 dark:bg-gray-800 disabled:opacity-40">
                <ChevronRight size={14} />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// =============================================================================
// Subcomponentes
// =============================================================================

function KpiHero({ icon, label, value, sub, color, tendencia }: {
  icon: React.ReactNode; label: string; value: string | number; sub?: string
  color: 'blue' | 'green' | 'red' | 'purple' | 'indigo'
  tendencia?: { campo: ComparativoCampo; semantica: 'sobe-bom' | 'desce-bom' | 'neutro' }
}) {
  const cores: Record<string, string> = {
    blue: 'bg-brand/10 text-brand',
    green: 'bg-emerald-100 dark:bg-emerald-950 text-emerald-600',
    red: 'bg-red-100 dark:bg-red-950 text-red-600',
    purple: 'bg-purple-100 dark:bg-purple-950 text-purple-600',
    indigo: 'bg-indigo-100 dark:bg-indigo-950 text-indigo-600',
  }
  return (
    <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm p-5">
      <div className="flex items-start justify-between">
        <div className={cn('w-11 h-11 rounded-xl flex items-center justify-center mb-3', cores[color])}>{icon}</div>
        {tendencia && <TrendMini campo={tendencia.campo} semantica={tendencia.semantica} />}
      </div>
      <p className="text-2xl sm:text-3xl font-bold text-gray-900 dark:text-white">{value}</p>
      <p className="text-sm text-gray-500 mt-0.5">{label}</p>
      {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
    </div>
  )
}

function TrendMini({ campo, semantica }: { campo: ComparativoCampo; semantica: 'sobe-bom' | 'desce-bom' | 'neutro' }) {
  if (campo.variacaoPercentual === null) return null
  const subiu = campo.variacaoPercentual > 0
  const zerado = campo.variacaoPercentual === 0
  const Icone = zerado ? Minus : subiu ? TrendingUp : TrendingDown

  let cor = 'text-gray-400'
  if (!zerado && semantica !== 'neutro') {
    const bom = semantica === 'sobe-bom' ? subiu : !subiu
    cor = bom ? 'text-emerald-600' : 'text-red-600'
  }

  return (
    <div className={cn('flex items-center gap-0.5 text-xs font-medium', cor)}>
      <Icone size={13} />
      {Math.abs(campo.variacaoPercentual).toFixed(1)}%
    </div>
  )
}

function KpiSecundario({ icon, label, value, tendencia }: { icon: React.ReactNode; label: string; value: number; tendencia?: 'bom' | 'ruim' | 'neutro' }) {
  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-sm p-3.5">
      <div className="flex items-center gap-1.5 text-gray-400 mb-1.5">{icon}<span className="text-xs">{label}</span></div>
      <div className="flex items-center gap-2">
        <p className="text-lg font-bold text-gray-900 dark:text-white">{value}</p>
        {tendencia && tendencia !== 'neutro' && (
          tendencia === 'bom' ? <TrendingDown size={14} className="text-emerald-500" /> : <TrendingUp size={14} className="text-red-500" />
        )}
      </div>
    </div>
  )
}

function MiniStat({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2.5 bg-gray-50 dark:bg-gray-800 rounded-xl">
      <div className="text-gray-400">{icon}</div>
      <div>
        <p className="text-sm font-semibold text-gray-900 dark:text-white leading-none">{value}</p>
        <p className="text-[11px] text-gray-500 mt-0.5">{label}</p>
      </div>
    </div>
  )
}

function LegendaProporcao({ cor, label, valor }: { cor: string; label: string; valor: number }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className={cn('w-2.5 h-2.5 rounded-full shrink-0', cor)} />
      <span className="text-gray-600 dark:text-gray-400">{label}:</span>
      <span className="font-semibold text-gray-900 dark:text-white">{valor}</span>
    </div>
  )
}

function GraficoCard({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm p-5 sm:p-6">
      <h3 className="font-semibold text-gray-900 dark:text-white mb-4">{titulo}</h3>
      {children}
    </div>
  )
}

function EstadoVazioGrafico() {
  return <div className="h-[200px] flex items-center justify-center text-sm text-gray-400">Sem dados suficientes para o período.</div>
}

function EstadoHistoricoFormacao() {
  return (
    <div className="h-[200px] flex flex-col items-center justify-center gap-2 text-center px-6">
      <CalendarClock size={28} className="text-gray-300" />
      <p className="text-sm font-medium text-gray-500">Histórico em formação</p>
      <p className="text-xs text-gray-400">O gráfico ficará completo conforme o sistema acumular meses de dados.</p>
    </div>
  )
}

// Semântica de tendência (item 7 do pedido): para alguns indicadores, CAIR é
// bom (fora do prazo, não retiradas, canceladas); para outros, SUBIR é bom
// (volume geral, tratado como neutro). O backend só devolve a variação
// percentual matemática — a interpretação de "bom/ruim" é desta camada.
type Polaridade = 'sobe-bom' | 'desce-bom'

function tendenciaCampo(campo: ComparativoCampo, polaridade: Polaridade): 'bom' | 'ruim' | 'neutro' {
  if (campo.variacaoPercentual === null || campo.variacaoPercentual === 0) return 'neutro'
  const subiu = campo.variacaoPercentual > 0
  if (polaridade === 'sobe-bom') return subiu ? 'bom' : 'ruim'
  return subiu ? 'ruim' : 'bom'
}
