// src/app/(dashboard)/patrimonios/page.tsx
'use client'

import { useEffect, useRef, useState } from 'react'
import { Plus, Search, Loader2, Power, Trash2, HardDrive, Pencil } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { CategoriaPatrimonio, Patrimonio } from '@/types'
import { cn } from '@/utils'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useDemoMode } from '@/hooks/use-demo-mode'

const DICA_DEMO = 'Indisponível na demonstração.'

export default function PatrimoniosPage() {
  const demoModeAtivo = useDemoMode()
  const { toast } = useToast()
  const [patrimonios, setPatrimonios] = useState<Patrimonio[]>([])
  const [categorias, setCategorias] = useState<CategoriaPatrimonio[]>([])
  const [loading, setLoading] = useState(true)
  // Etapa perf/system-optimization: mesmo padrão de debounce (300ms) já
  // aplicado em colaboradores/page.tsx — `buscaInput` reflete cada tecla no
  // campo imediatamente; `busca` (debounced) é quem dispara o fetch/consulta
  // ao banco, evitando uma requisição por tecla digitada.
  const [buscaInput, setBuscaInput] = useState('')
  const [busca, setBusca] = useState('')
  const [categoriaFiltro, setCategoriaFiltro] = useState('')
  // Etapa fix/patrimonios-pagination: a API já paginava (take padrão 15),
  // mas esta tela nunca enviava page/limit — sempre recebia só os 15
  // primeiros bens (skip=0), deixando qualquer bem além do 15º invisível
  // para consulta/edição. Mesmo padrão de estado/paginação já homologado
  // em src/app/(dashboard)/colaboradores/page.tsx.
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const LIMIT = 15
  const [modalAberto, setModalAberto] = useState(false)
  const [salvando, setSalvando] = useState(false)
  const [removendo, setRemovendo] = useState<Patrimonio | null>(null)
  const [removendoLoading, setRemovendoLoading] = useState(false)
  // Etapa fix/toggle-loading-feedback: loading POR item (não a tabela
  // inteira) — Set em vez de boolean único, já que dois bens diferentes
  // podem estar sendo ativados/desativados ao mesmo tempo sem conflito
  // algum entre si. `alternandoRef` é a guarda SÍNCRONA contra duplo
  // clique (mesmo motivo do `resetandoRef` em colaboradores/page.tsx):
  // `alternandoIds` só reflete no DOM depois de um re-render, então dois
  // cliques disparados antes desse re-render ainda veriam o item ausente
  // do Set. A ref é lida/escrita de forma síncrona, sem esperar o React.
  const [alternandoIds, setAlternandoIds] = useState<Set<string>>(new Set())
  const alternandoRef = useRef<Set<string>>(new Set())

  const [numero, setNumero] = useState('')
  const [marca, setMarca] = useState('')
  const [modelo, setModelo] = useState('')
  const [categoriaId, setCategoriaId] = useState('')

  const [editando, setEditando] = useState<Patrimonio | null>(null)
  const [editNumero, setEditNumero] = useState('')
  const [editMarca, setEditMarca] = useState('')
  const [editModelo, setEditModelo] = useState('')
  const [editCategoriaId, setEditCategoriaId] = useState('')
  const [salvandoEdicao, setSalvandoEdicao] = useState(false)

  useEffect(() => {
    fetch('/api/categorias').then((r) => r.json()).then((d) => setCategorias(d.categorias || []))
  }, [])

  useEffect(() => {
    const t = setTimeout(() => setBusca(buscaInput.trim()), 300)
    return () => clearTimeout(t)
  }, [buscaInput])

  function carregar() {
    setLoading(true)
    const params = new URLSearchParams({ page: String(page), limit: String(LIMIT) })
    if (busca) params.set('busca', busca)
    if (categoriaFiltro) params.set('categoriaId', categoriaFiltro)
    fetch(`/api/patrimonios?${params}`)
      .then((r) => r.json())
      .then((d) => { setPatrimonios(d.patrimonios || []); setTotal(d.total || 0) })
      .finally(() => setLoading(false))
  }

  // Trocar busca/categoria sempre volta para a página 1 — nunca deixar o
  // usuário "preso" numa página que o novo filtro não tem mais (mesmo
  // padrão de colaboradores/page.tsx).
  useEffect(() => { setPage(1) }, [busca, categoriaFiltro])
  useEffect(() => { carregar() }, [busca, categoriaFiltro, page]) // eslint-disable-line react-hooks/exhaustive-deps

  const totalPages = Math.max(1, Math.ceil(total / LIMIT))

  // Página inválida (ex.: exclusão do último item de uma página, filtro
  // que reduziu o total) — nunca deixar a tabela vazia mostrando "Página 4
  // de 3"; volta para a última página que ainda existe.
  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [totalPages, page])

  async function salvar() {
    if (!numero.trim() || !marca.trim() || !modelo.trim() || !categoriaId) {
      toast({ title: 'Preencha todos os campos.', variant: 'destructive' })
      return
    }
    setSalvando(true)
    try {
      const res = await fetch('/api/patrimonios', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ numero, marca, modelo, categoriaId }),
      })
      const result = await res.json()
      if (!res.ok) { toast({ title: 'Erro', description: result.message, variant: 'destructive' }); return }
      toast({ title: 'Bem patrimonial cadastrado.' })
      setModalAberto(false)
      setNumero(''); setMarca(''); setModelo(''); setCategoriaId('')
      carregar()
    } finally {
      setSalvando(false)
    }
  }

  function abrirEdicao(p: Patrimonio) {
    setEditando(p)
    setEditNumero(p.numero)
    setEditMarca(p.marca)
    setEditModelo(p.modelo)
    setEditCategoriaId(p.categoriaId)
  }

  function fecharEdicao() {
    if (salvandoEdicao) return
    setEditando(null)
  }

  async function salvarEdicao() {
    if (!editando || salvandoEdicao) return
    if (!editNumero.trim() || !editMarca.trim() || !editModelo.trim() || !editCategoriaId) {
      toast({ title: 'Preencha todos os campos.', variant: 'destructive' })
      return
    }
    setSalvandoEdicao(true)
    try {
      const res = await fetch(`/api/patrimonios/${editando.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          numero: editNumero,
          marca: editMarca,
          modelo: editModelo,
          categoriaId: editCategoriaId,
        }),
      })
      const result = await res.json()
      if (!res.ok) { toast({ title: 'Erro', description: result.message, variant: 'destructive' }); return }
      toast({ title: 'Bem patrimonial atualizado com sucesso.' })
      setEditando(null)
      carregar()
    } catch {
      toast({ title: 'Erro', description: 'Falha ao conectar com o servidor.', variant: 'destructive' })
    } finally {
      setSalvandoEdicao(false)
    }
  }

  async function alternarAtivo(p: Patrimonio) {
    if (alternandoRef.current.has(p.id)) return
    alternandoRef.current.add(p.id)
    setAlternandoIds(new Set(alternandoRef.current))
    try {
      const res = await fetch(`/api/patrimonios/${p.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ativo: !p.ativo }),
      })
      if (!res.ok) {
        const result = await res.json().catch(() => ({}))
        toast({ title: 'Erro', description: result.message || 'Não foi possível alterar o status do patrimônio.', variant: 'destructive' })
        return
      }
      // carregar() já lê busca/categoriaFiltro/page do estado atual do
      // componente — mantém página e filtros aplicados sem nenhum reset
      // (Etapa fix/patrimonios-pagination, não regredida aqui).
      carregar()
    } catch {
      toast({ title: 'Erro', description: 'Não foi possível alterar o status do patrimônio. Verifique sua conexão.', variant: 'destructive' })
    } finally {
      alternandoRef.current.delete(p.id)
      setAlternandoIds(new Set(alternandoRef.current))
    }
  }

  async function confirmarRemocao() {
    if (!removendo) return
    setRemovendoLoading(true)
    try {
      const res = await fetch(`/api/patrimonios/${removendo.id}`, { method: 'DELETE' })
      const result = await res.json()
      if (!res.ok) { toast({ title: 'Erro', description: result.message, variant: 'destructive' }); return }
      toast({ title: result.inativado ? 'Bem desativado' : 'Bem removido', description: result.message })
      setRemovendo(null)
      carregar()
    } finally {
      setRemovendoLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-3 justify-between">
        <div className="flex flex-1 gap-2">
          <div className="relative flex-1 max-w-xs">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input value={buscaInput} onChange={(e) => setBuscaInput(e.target.value)} placeholder="Buscar por número, marca, modelo" maxLength={120} className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition" />
          </div>
          <select value={categoriaFiltro} onChange={(e) => setCategoriaFiltro(e.target.value)} aria-label="Filtrar por categoria" className="px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition">
            <option value="">Todas categorias</option>
            {categorias.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
          </select>
        </div>
        <button
          onClick={() => setModalAberto(true)}
          disabled={demoModeAtivo}
          title={demoModeAtivo ? DICA_DEMO : undefined}
          className="flex items-center justify-center gap-2 px-4 py-2 bg-brand hover:bg-brand-dark text-white rounded-xl text-sm font-medium shadow-md hover:shadow-lg hover:-translate-y-0.5 transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:shadow-none"
        >
          <Plus size={16} /> Novo bem
        </button>
      </div>
      {demoModeAtivo && (
        <p className="text-xs text-gray-400 -mt-2">Somente leitura no ambiente de demonstração.</p>
      )}

      {loading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => <div key={i} className="h-12 bg-gray-100 dark:bg-gray-800 rounded-xl animate-pulse" />)}
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead className="bg-gray-50 dark:bg-gray-800 text-left text-xs text-gray-500 uppercase">
                <tr>
                  <th className="px-4 py-3">Número</th>
                  <th className="px-4 py-3">Categoria</th>
                  <th className="px-4 py-3">Marca / Modelo</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {patrimonios.map((p) => (
                  <tr key={p.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-colors">
                    <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{p.numero}</td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{p.categoria?.nome}</td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{p.marca} {p.modelo}</td>
                    <td className="px-4 py-3">
                      <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium', p.ativo ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500')}>
                        {p.ativo ? 'Ativo' : 'Inativo'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => abrirEdicao(p)}
                          disabled={demoModeAtivo}
                          title={demoModeAtivo ? DICA_DEMO : 'Editar'}
                          aria-label="Editar bem patrimonial"
                          className="p-2 rounded-lg text-gray-400 hover:text-brand hover:bg-brand/5 focus:outline-none focus:ring-2 focus:ring-brand/30 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent transition"
                        >
                          <Pencil size={16} />
                        </button>
                        <button
                          onClick={() => alternarAtivo(p)}
                          disabled={alternandoIds.has(p.id) || demoModeAtivo}
                          title={demoModeAtivo ? DICA_DEMO : p.ativo ? 'Desativar' : 'Ativar'}
                          aria-label={p.ativo ? 'Desativar bem patrimonial' : 'Ativar bem patrimonial'}
                          aria-busy={alternandoIds.has(p.id)}
                          className="p-2 rounded-lg text-gray-400 hover:text-brand hover:bg-brand/5 focus:outline-none focus:ring-2 focus:ring-brand/30 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent transition"
                        >
                          {alternandoIds.has(p.id) ? <Loader2 size={16} className="animate-spin" /> : <Power size={16} />}
                        </button>
                        <button
                          onClick={() => setRemovendo(p)}
                          disabled={demoModeAtivo}
                          title={demoModeAtivo ? DICA_DEMO : 'Remover'}
                          aria-label="Excluir bem patrimonial"
                          className="p-2 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-500/30 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-gray-400 transition"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {patrimonios.length === 0 && (
                  <tr><td colSpan={5} className="px-4 py-12 text-center text-gray-400">
                    <HardDrive size={32} className="mx-auto mb-2 opacity-30" />
                    {/* Etapa fix/patrimonios-pagination (item 13): diferencia
                        "nenhum bem cadastrado" (nenhum filtro ativo) de "nenhum
                        resultado para o filtro/busca atual" — nunca a mesma
                        frase genérica para os dois casos. */}
                    {busca || categoriaFiltro ? 'Nenhum bem encontrado para esse filtro.' : 'Nenhum bem patrimonial cadastrado ainda.'}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 dark:border-gray-800">
              <p className="text-xs text-gray-500 dark:text-gray-400">Página {page} de {totalPages}</p>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  aria-label="Página anterior"
                  className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-xs text-gray-600 dark:text-gray-400 disabled:opacity-40 hover:bg-gray-50 dark:hover:bg-gray-800 transition"
                >
                  Anterior
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  aria-label="Próxima página"
                  className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-xs text-gray-600 dark:text-gray-400 disabled:opacity-40 hover:bg-gray-50 dark:hover:bg-gray-800 transition"
                >
                  Próxima
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {modalAberto && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setModalAberto(false)} />
          <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl p-6 w-full max-w-md space-y-4">
            <h3 className="font-semibold text-gray-900 dark:text-white">Novo bem patrimonial</h3>
            <div>
              <label htmlFor="patrimonio-numero" className="block text-sm font-medium mb-1">Número de patrimônio</label>
              <input id="patrimonio-numero" value={numero} onChange={(e) => setNumero(e.target.value)} maxLength={120} className="w-full px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition" />
            </div>
            <div>
              <label htmlFor="patrimonio-categoria" className="block text-sm font-medium mb-1">Categoria</label>
              <select id="patrimonio-categoria" value={categoriaId} onChange={(e) => setCategoriaId(e.target.value)} className="w-full px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition">
                <option value="">Selecione</option>
                {categorias.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="patrimonio-marca" className="block text-sm font-medium mb-1">Marca</label>
                <input id="patrimonio-marca" value={marca} onChange={(e) => setMarca(e.target.value)} maxLength={120} className="w-full px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition" />
              </div>
              <div>
                <label htmlFor="patrimonio-modelo" className="block text-sm font-medium mb-1">Modelo</label>
                <input id="patrimonio-modelo" value={modelo} onChange={(e) => setModelo(e.target.value)} maxLength={120} className="w-full px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition" />
              </div>
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setModalAberto(false)} className="px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-sm font-medium">Cancelar</button>
              <button onClick={salvar} disabled={salvando} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium disabled:opacity-60">
                {salvando ? <Loader2 size={14} className="animate-spin" /> : null} Salvar
              </button>
            </div>
          </div>
        </div>
      )}

      {editando && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={fecharEdicao} />
          <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl p-6 w-full max-w-md space-y-4">
            <h3 className="font-semibold text-gray-900 dark:text-white">Editar bem patrimonial</h3>
            <div>
              <label htmlFor="edit-patrimonio-numero" className="block text-sm font-medium mb-1">Número de patrimônio</label>
              <input id="edit-patrimonio-numero" value={editNumero} onChange={(e) => setEditNumero(e.target.value)} maxLength={120} className="w-full px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition" />
            </div>
            <div>
              <label htmlFor="edit-patrimonio-categoria" className="block text-sm font-medium mb-1">Categoria</label>
              <select id="edit-patrimonio-categoria" value={editCategoriaId} onChange={(e) => setEditCategoriaId(e.target.value)} className="w-full px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition">
                <option value="">Selecione</option>
                {categorias.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="edit-patrimonio-marca" className="block text-sm font-medium mb-1">Marca</label>
                <input id="edit-patrimonio-marca" value={editMarca} onChange={(e) => setEditMarca(e.target.value)} maxLength={120} className="w-full px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition" />
              </div>
              <div>
                <label htmlFor="edit-patrimonio-modelo" className="block text-sm font-medium mb-1">Modelo</label>
                <input id="edit-patrimonio-modelo" value={editModelo} onChange={(e) => setEditModelo(e.target.value)} maxLength={120} className="w-full px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition" />
              </div>
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={fecharEdicao} disabled={salvandoEdicao} className="px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-sm font-medium disabled:opacity-60">Cancelar</button>
              <button onClick={salvarEdicao} disabled={salvandoEdicao} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-brand hover:bg-brand-dark text-white text-sm font-medium disabled:opacity-60 transition">
                {salvandoEdicao ? <Loader2 size={14} className="animate-spin" /> : null} {salvandoEdicao ? 'Salvando...' : 'Salvar alterações'}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!removendo}
        title="Remover bem patrimonial"
        description={removendo ? `Tem certeza de que deseja remover o bem "${removendo.numero}" — ${removendo.categoria?.nome ?? ''} ${removendo.marca} ${removendo.modelo}? Se houver histórico de utilização, ele será desativado em vez de excluído.` : ''}
        confirmLabel="Remover"
        variant="danger"
        loading={removendoLoading}
        onCancel={() => setRemovendo(null)}
        onConfirm={confirmarRemocao}
      />
    </div>
  )
}
