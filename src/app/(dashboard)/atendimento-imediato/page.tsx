// src/app/(dashboard)/atendimento-imediato/page.tsx
'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Search, Plus, Trash2, Loader2, CheckCircle2, User as UserIcon, Laptop, Package, Wrench, Clock } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { CategoriaPatrimonio, Patrimonio, PeriodoSolicitacao, PERIODO_LABELS, TipoServico } from '@/types'
import { cn } from '@/utils'
import { sugerirPeriodoAtual } from '@/lib/prazo'
import { parseQuantidadeServico } from '@/lib/servico-form'

// Registro de Atendimento Imediato (Fase 3 — Etapa 4): o solicitante chega
// diretamente ao Patrimônio, sem reserva antecipada, e é atendido na hora.
// Reaproveita a mesma API de criação de solicitações (POST /api/solicitacoes)
// com origem=ATENDIMENTO_IMEDIATO — nenhuma lógica de negócio duplicada.
// Não passa por aprovação, não entra no cálculo de prazo/antecedência.

interface ColaboradorBusca { id: string; nome: string; email: string }
interface ItemPapelariaForm { descricao: string; quantidade: number }
interface ItemServicoForm { tipoServicoId: string; tipoServicoNome: string; quantidade: number; ambiente: string; observacao?: string }

export default function AtendimentoImediatoPage() {
  const { toast } = useToast()
  const router = useRouter()

  // Solicitante
  const [buscaColab, setBuscaColab] = useState('')
  const [resultadosColab, setResultadosColab] = useState<ColaboradorBusca[]>([])
  const [solicitante, setSolicitante] = useState<ColaboradorBusca | null>(null)

  // Bens patrimoniais
  const [categorias, setCategorias] = useState<CategoriaPatrimonio[]>([])
  const [categoriaSelecionada, setCategoriaSelecionada] = useState('')
  const [disponiveis, setDisponiveis] = useState<Patrimonio[] | null>(null)
  const [buscandoDisponiveis, setBuscandoDisponiveis] = useState(false)
  const [selecaoTemp, setSelecaoTemp] = useState<Set<string>>(new Set())
  const [itensBens, setItensBens] = useState<Patrimonio[]>([])

  // Papelaria
  const [itensPapelaria, setItensPapelaria] = useState<ItemPapelariaForm[]>([])
  const [novoItemDesc, setNovoItemDesc] = useState('')
  const [novoItemQtd, setNovoItemQtd] = useState('')

  // Serviços / Movimentações
  const [tiposServico, setTiposServico] = useState<TipoServico[]>([])
  const [itensServico, setItensServico] = useState<ItemServicoForm[]>([])
  const [novoServicoId, setNovoServicoId] = useState('')
  const [novoServicoQtd, setNovoServicoQtd] = useState('')
  const [novoServicoAmbiente, setNovoServicoAmbiente] = useState('')
  const [novoServicoObs, setNovoServicoObs] = useState('')

  const [observacoes, setObservacoes] = useState('')
  const [enviando, setEnviando] = useState(false)

  // Período do atendimento (Fase 3 — Etapa 4, ajuste): obrigatório, apenas
  // para registro operacional/relatórios — NÃO define prazo de 48h/72h.
  // Pré-selecionado com base no horário atual, mas sempre alterável.
  const [periodo, setPeriodo] = useState<PeriodoSolicitacao>(() => sugerirPeriodoAtual())

  useEffect(() => {
    fetch('/api/categorias').then((r) => r.json()).then((d) => setCategorias(d.categorias || []))
    fetch('/api/tipos-servico').then((r) => r.json()).then((d) => setTiposServico(d.tiposServico || []))
  }, [])

  useEffect(() => {
    if (buscaColab.trim().length < 2) { setResultadosColab([]); return }
    const t = setTimeout(() => {
      fetch(`/api/colaboradores/busca?busca=${encodeURIComponent(buscaColab)}`)
        .then((r) => r.json())
        .then((d) => setResultadosColab(d.colaboradores || []))
    }, 300)
    return () => clearTimeout(t)
  }, [buscaColab])

  async function buscarDisponibilidade() {
    if (!categoriaSelecionada) {
      toast({ title: 'Selecione a categoria', variant: 'destructive' })
      return
    }
    setBuscandoDisponiveis(true)
    setDisponiveis(null)
    setSelecaoTemp(new Set())
    try {
      const res = await fetch(`/api/patrimonios/disponibilidade?categoriaId=${categoriaSelecionada}&modo=imediato`)
      const result = await res.json()
      setDisponiveis(result.patrimonios || [])
    } catch {
      toast({ title: 'Erro', description: 'Falha ao buscar disponibilidade.', variant: 'destructive' })
    } finally {
      setBuscandoDisponiveis(false)
    }
  }

  function adicionarSelecionados() {
    if (!disponiveis) return
    const novos = disponiveis.filter((p) => selecaoTemp.has(p.id) && !itensBens.some((b) => b.id === p.id))
    setItensBens((prev) => [...prev, ...novos])
    setSelecaoTemp(new Set())
  }

  function removerBem(id: string) {
    setItensBens((prev) => prev.filter((b) => b.id !== id))
  }

  function adicionarPapelaria() {
    const qtd = parseQuantidadeServico(novoItemQtd)
    if (!novoItemDesc.trim() || qtd === null) return
    setItensPapelaria((prev) => [...prev, { descricao: novoItemDesc.trim(), quantidade: qtd }])
    setNovoItemDesc('')
    setNovoItemQtd('')
  }

  function removerPapelaria(idx: number) {
    setItensPapelaria((prev) => prev.filter((_, i) => i !== idx))
  }

  function adicionarServico() {
    if (!novoServicoId) return
    const tipo = tiposServico.find((t) => t.id === novoServicoId)
    if (!tipo) return

    const qtd = parseQuantidadeServico(novoServicoQtd)
    if (qtd === null) {
      toast({ title: 'Informe a quantidade', description: 'A quantidade deve ser um número inteiro maior que zero.', variant: 'destructive' })
      return
    }
    if (!novoServicoAmbiente.trim()) {
      toast({ title: 'Informe o ambiente/local', description: 'O ambiente/local do serviço é obrigatório.', variant: 'destructive' })
      return
    }

    setItensServico((prev) => [
      ...prev,
      {
        tipoServicoId: novoServicoId,
        tipoServicoNome: tipo.nome,
        quantidade: qtd,
        ambiente: novoServicoAmbiente.trim(),
        observacao: novoServicoObs.trim() || undefined,
      },
    ])
    setNovoServicoId('')
    setNovoServicoQtd('')
    setNovoServicoAmbiente('')
    setNovoServicoObs('')
  }

  function removerServico(idx: number) {
    setItensServico((prev) => prev.filter((_, i) => i !== idx))
  }

  async function registrar() {
    if (!solicitante) {
      toast({ title: 'Selecione o solicitante', variant: 'destructive' })
      return
    }
    if (itensBens.length === 0 && itensPapelaria.length === 0 && itensServico.length === 0) {
      toast({ title: 'Adicione ao menos um item', description: 'Bem patrimonial, papelaria ou serviço/movimentação.', variant: 'destructive' })
      return
    }

    setEnviando(true)
    try {
      const hoje = new Date().toISOString().split('T')[0]
      const res = await fetch('/api/solicitacoes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          origem: 'ATENDIMENTO_IMEDIATO',
          tipoEmprestimo: 'interno',
          solicitanteId: solicitante.id,
          data: hoje,
          periodos: [periodo],
          observacoes,
          patrimonioIds: itensBens.map((b) => b.id),
          itensPapelaria,
          servicos: itensServico.map((s) => ({
            tipoServicoId: s.tipoServicoId,
            quantidade: s.quantidade,
            ambiente: s.ambiente,
            observacao: s.observacao,
          })),
        }),
      })
      const result = await res.json()

      if (!res.ok) {
        toast({ title: 'Não foi possível registrar', description: result.message, variant: 'destructive' })
        return
      }

      toast({ title: 'Atendimento imediato registrado!', description: `Solicitação #${result.solicitacao.numero} criada com sucesso.` })
      router.push(`/solicitacoes/${result.solicitacao.id}`)
    } catch {
      toast({ title: 'Erro', description: 'Falha ao registrar o atendimento.', variant: 'destructive' })
    } finally {
      setEnviando(false)
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <p className="text-sm text-gray-500">
        Use esta tela quando o solicitante for atendido na hora, sem reserva antecipada. O registro já entra
        diretamente como retirado (ou finalizado, se não houver bem patrimonial) — sem passar por aprovação.
      </p>

      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm p-5 sm:p-6 space-y-6">
        {/* Solicitante */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Solicitante</label>
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={buscaColab}
              onChange={(e) => { setBuscaColab(e.target.value); setSolicitante(null) }}
              placeholder="Pesquisar colaborador/docente por nome ou e-mail"
              className="w-full pl-9 pr-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
            />
          </div>
          {resultadosColab.length > 0 && !solicitante && (
            <div className="border border-gray-200 dark:border-gray-700 rounded-xl divide-y divide-gray-100 dark:divide-gray-800 overflow-hidden">
              {resultadosColab.map((c) => (
                <button
                  key={c.id}
                  onClick={() => { setSolicitante(c); setBuscaColab(c.nome); setResultadosColab([]) }}
                  className="w-full text-left px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-800 text-sm"
                >
                  <p className="font-medium text-gray-900 dark:text-white">{c.nome}</p>
                  <p className="text-xs text-gray-500">{c.email}</p>
                </button>
              ))}
            </div>
          )}
          {solicitante && (
            <div className="flex items-center gap-2 px-3 py-2 bg-highlight/5 border border-highlight/20 rounded-xl text-sm">
              <UserIcon size={14} className="text-highlight" />
              <span className="text-gray-800 dark:text-gray-200">Solicitante: <strong>{solicitante.nome}</strong></span>
            </div>
          )}
        </div>

        {/* Período do atendimento */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-2">
            <Clock size={16} className="text-brand" /> Período do atendimento
          </label>
          <div className="grid grid-cols-3 gap-3">
            {(['MANHA', 'TARDE', 'NOITE'] as PeriodoSolicitacao[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPeriodo(p)}
                className={cn(
                  'py-3 rounded-xl border-2 text-sm font-medium transition',
                  periodo === p ? 'border-highlight bg-highlight/5 text-highlight' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400'
                )}
              >
                {PERIODO_LABELS[p]}
              </button>
            ))}
          </div>
          <p className="text-xs text-gray-400 mt-1.5">
            Sugerido automaticamente com base no horário atual — ajuste se o atendimento ocorreu em outro momento.
          </p>
        </div>

        {/* Bens patrimoniais */}
        <div>
          <h3 className="font-semibold text-gray-900 dark:text-white mb-3 flex items-center gap-2"><Laptop size={18} className="text-brand" /> Bens Patrimoniais</h3>
          <div className="flex flex-col sm:flex-row gap-3 mb-3">
            <select
              value={categoriaSelecionada}
              onChange={(e) => setCategoriaSelecionada(e.target.value)}
              className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
            >
              <option value="">Selecione a categoria</option>
              {categorias.filter((c) => c.ativo).map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
            </select>
            <button
              onClick={buscarDisponibilidade}
              disabled={buscandoDisponiveis}
              className="flex items-center justify-center gap-2 px-4 py-2.5 bg-brand text-white rounded-xl text-sm font-medium disabled:opacity-60"
            >
              {buscandoDisponiveis ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
              Ver disponíveis agora
            </button>
          </div>

          {disponiveis !== null && (
            <div className="border border-gray-200 dark:border-gray-700 rounded-xl p-3 mb-3 max-h-64 overflow-y-auto space-y-1.5">
              {disponiveis.length === 0 ? (
                <p className="text-sm text-gray-500 text-center py-4">Nenhum item disponível nesta categoria no momento.</p>
              ) : (
                disponiveis.map((p) => {
                  const jaAdicionado = itensBens.some((b) => b.id === p.id)
                  return (
                    <label key={p.id} className={cn('flex items-center gap-3 px-3 py-2 rounded-lg text-sm cursor-pointer', jaAdicionado ? 'opacity-40 pointer-events-none' : 'hover:bg-gray-50 dark:hover:bg-gray-800')}>
                      <input
                        type="checkbox"
                        checked={selecaoTemp.has(p.id)}
                        onChange={(e) => {
                          const next = new Set(selecaoTemp)
                          if (e.target.checked) next.add(p.id); else next.delete(p.id)
                          setSelecaoTemp(next)
                        }}
                        className="w-4 h-4 accent-highlight"
                      />
                      <span className="flex-1">{p.marca} {p.modelo} <span className="text-gray-400">— {p.numero}</span></span>
                    </label>
                  )
                })
              )}
              {disponiveis.length > 0 && (
                <button onClick={adicionarSelecionados} disabled={selecaoTemp.size === 0} className="mt-2 w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-highlight/10 text-highlight text-sm font-medium disabled:opacity-60">
                  <Plus size={14} /> Adicionar selecionados
                </button>
              )}
            </div>
          )}

          {itensBens.length > 0 && (
            <div className="space-y-2">
              {itensBens.map((b) => (
                <div key={b.id} className="flex items-center justify-between px-3 py-2 bg-gray-50 dark:bg-gray-800 rounded-lg text-sm">
                  <span>{b.categoria?.nome}: {b.marca} {b.modelo} ({b.numero})</span>
                  <button onClick={() => removerBem(b.id)} className="text-red-500 hover:text-red-700"><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Papelaria */}
        <div>
          <h3 className="font-semibold text-gray-900 dark:text-white mb-3 flex items-center gap-2"><Package size={18} className="text-brand" /> Papelaria</h3>
          <div className="flex flex-col sm:flex-row gap-2 mb-3">
            <input
              value={novoItemDesc}
              onChange={(e) => setNovoItemDesc(e.target.value)}
              placeholder="Descrição (ex.: cartolina branca)"
              className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
            />
            <input
              type="number"
              min={1}
              placeholder="Quantidade"
              value={novoItemQtd}
              onChange={(e) => setNovoItemQtd(e.target.value)}
              className="w-full sm:w-36 px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
            />
            <button
              onClick={adicionarPapelaria}
              disabled={!novoItemDesc.trim() || parseQuantidadeServico(novoItemQtd) === null}
              className="flex items-center justify-center gap-2 px-4 py-2.5 bg-brand hover:bg-brand-dark text-white rounded-xl text-sm font-medium disabled:opacity-60 transition"
            >
              <Plus size={16} /> Adicionar
            </button>
          </div>
          {itensPapelaria.length > 0 && (
            <div className="space-y-2">
              {itensPapelaria.map((it, idx) => (
                <div key={idx} className="flex items-center justify-between px-3 py-2 bg-gray-50 dark:bg-gray-800 rounded-lg text-sm">
                  <span>{it.quantidade}x {it.descricao}</span>
                  <button onClick={() => removerPapelaria(idx)} className="text-red-500 hover:text-red-700"><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Serviços / Movimentações */}
        <div>
          <h3 className="font-semibold text-gray-900 dark:text-white mb-3 flex items-center gap-2"><Wrench size={18} className="text-brand" /> Serviços / Movimentações</h3>
          <div className="space-y-2 mb-3">
            <div className="flex flex-col sm:flex-row gap-2">
              <select
                value={novoServicoId}
                onChange={(e) => setNovoServicoId(e.target.value)}
                className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
              >
                <option value="">Selecione o serviço/movimentação</option>
                {tiposServico.filter((t) => t.ativo).map((t) => <option key={t.id} value={t.id}>{t.nome}</option>)}
              </select>
              <input
                type="number"
                min={1}
                placeholder="Quantidade *"
                value={novoServicoQtd}
                onChange={(e) => setNovoServicoQtd(e.target.value)}
                className="w-full sm:w-36 px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
              />
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                value={novoServicoAmbiente}
                onChange={(e) => setNovoServicoAmbiente(e.target.value)}
                placeholder="Ambiente/local *"
                className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
              />
              <input
                value={novoServicoObs}
                onChange={(e) => setNovoServicoObs(e.target.value)}
                placeholder="Observação (opcional)"
                className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
              />
              <button
                onClick={adicionarServico}
                disabled={!novoServicoId || parseQuantidadeServico(novoServicoQtd) === null || !novoServicoAmbiente.trim()}
                className="flex items-center justify-center gap-2 px-4 py-2.5 bg-brand hover:bg-brand-dark text-white rounded-xl text-sm font-medium disabled:opacity-60 transition"
              >
                <Plus size={16} /> Adicionar
              </button>
            </div>
          </div>
          {itensServico.length > 0 && (
            <div className="space-y-2">
              {itensServico.map((it, idx) => (
                <div key={idx} className="flex items-center justify-between px-3 py-2 bg-gray-50 dark:bg-gray-800 rounded-lg text-sm">
                  <span>
                    {it.tipoServicoNome}
                    {it.quantidade ? ` — ${it.quantidade}` : ''}
                    {it.ambiente ? ` — ${it.ambiente}` : ''}
                    {it.observacao ? ` (${it.observacao})` : ''}
                  </span>
                  <button onClick={() => removerServico(idx)} className="text-red-500 hover:text-red-700"><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Observação geral */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Observação (opcional)</label>
          <textarea
            value={observacoes}
            onChange={(e) => setObservacoes(e.target.value)}
            rows={2}
            className="w-full px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
          />
        </div>

        <div className="flex justify-end pt-2 border-t border-gray-100 dark:border-gray-800">
          <button
            onClick={registrar}
            disabled={enviando}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold bg-brand hover:bg-brand-dark text-white disabled:opacity-60 shadow-md hover:shadow-lg hover:-translate-y-0.5 transition-all"
          >
            {enviando ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
            {enviando ? 'Registrando...' : 'Registrar atendimento'}
          </button>
        </div>
      </div>
    </div>
  )
}
