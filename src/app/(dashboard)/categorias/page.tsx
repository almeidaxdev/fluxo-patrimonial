// src/app/(dashboard)/categorias/page.tsx
'use client'

import { useEffect, useRef, useState } from 'react'
import { Plus, Loader2, Power, Trash2, Tags, Pencil } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { CategoriaPatrimonio } from '@/types'
import { cn } from '@/utils'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'

export default function CategoriasPage() {
  const { toast } = useToast()
  const [categorias, setCategorias] = useState<CategoriaPatrimonio[]>([])
  const [loading, setLoading] = useState(true)
  const [modalAberto, setModalAberto] = useState(false)
  const [salvando, setSalvando] = useState(false)
  const [nome, setNome] = useState('')
  const [descricao, setDescricao] = useState('')
  const [removendo, setRemovendo] = useState<CategoriaPatrimonio | null>(null)
  const [removendoLoading, setRemovendoLoading] = useState(false)
  // Etapa fix/toggle-loading-feedback: mesmo padrão de
  // patrimonios/page.tsx — loading por item (Set) + guarda síncrona
  // (`alternandoRef`) contra duplo clique, mesmo raciocínio do
  // `resetandoRef` já usado em colaboradores/page.tsx.
  const [alternandoIds, setAlternandoIds] = useState<Set<string>>(new Set())
  const alternandoRef = useRef<Set<string>>(new Set())

  const [editando, setEditando] = useState<CategoriaPatrimonio | null>(null)
  const [editNome, setEditNome] = useState('')
  const [editDescricao, setEditDescricao] = useState('')
  const [salvandoEdicao, setSalvandoEdicao] = useState(false)

  function carregar() {
    setLoading(true)
    fetch('/api/categorias?comContagem=true').then((r) => r.json()).then((d) => setCategorias(d.categorias || [])).finally(() => setLoading(false))
  }

  useEffect(() => { carregar() }, [])

  async function salvar() {
    if (!nome.trim()) { toast({ title: 'Informe o nome da categoria.', variant: 'destructive' }); return }
    setSalvando(true)
    try {
      const res = await fetch('/api/categorias', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nome, descricao }),
      })
      const result = await res.json()
      if (!res.ok) { toast({ title: 'Erro', description: result.message, variant: 'destructive' }); return }
      toast({ title: 'Categoria criada.' })
      setModalAberto(false); setNome(''); setDescricao('')
      carregar()
    } finally {
      setSalvando(false)
    }
  }

  function abrirEdicao(c: CategoriaPatrimonio) {
    setEditando(c)
    setEditNome(c.nome)
    setEditDescricao(c.descricao ?? '')
  }

  function fecharEdicao() {
    if (salvandoEdicao) return
    setEditando(null)
  }

  async function salvarEdicao() {
    if (!editando || salvandoEdicao) return
    if (!editNome.trim()) { toast({ title: 'Informe o nome da categoria.', variant: 'destructive' }); return }
    setSalvandoEdicao(true)
    try {
      const res = await fetch(`/api/categorias/${editando.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nome: editNome.trim(), descricao: editDescricao.trim() }),
      })
      const result = await res.json()
      if (!res.ok) { toast({ title: 'Erro', description: result.message, variant: 'destructive' }); return }
      toast({ title: 'Categoria atualizada com sucesso.' })
      setEditando(null)
      carregar()
    } catch {
      toast({ title: 'Erro', description: 'Falha ao conectar com o servidor.', variant: 'destructive' })
    } finally {
      setSalvandoEdicao(false)
    }
  }

  async function alternarAtivo(c: CategoriaPatrimonio) {
    if (alternandoRef.current.has(c.id)) return
    alternandoRef.current.add(c.id)
    setAlternandoIds(new Set(alternandoRef.current))
    try {
      const res = await fetch(`/api/categorias/${c.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ativo: !c.ativo }),
      })
      if (!res.ok) {
        const result = await res.json().catch(() => ({}))
        toast({ title: 'Erro', description: result.message || 'Não foi possível alterar o status da categoria.', variant: 'destructive' })
        return
      }
      carregar()
    } catch {
      toast({ title: 'Erro', description: 'Não foi possível alterar o status da categoria. Verifique sua conexão.', variant: 'destructive' })
    } finally {
      alternandoRef.current.delete(c.id)
      setAlternandoIds(new Set(alternandoRef.current))
    }
  }

  async function confirmarRemocao() {
    if (!removendo) return
    setRemovendoLoading(true)
    try {
      const res = await fetch(`/api/categorias/${removendo.id}`, { method: 'DELETE' })
      const result = await res.json()
      if (!res.ok) { toast({ title: 'Erro', description: result.message, variant: 'destructive' }); return }
      toast({ title: result.inativada ? 'Categoria desativada' : 'Categoria removida', description: result.message })
      setRemovendo(null)
      carregar()
    } finally {
      setRemovendoLoading(false)
    }
  }

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex justify-end">
        <button onClick={() => setModalAberto(true)} className="flex items-center gap-2 px-4 py-2 bg-brand hover:bg-brand-dark text-white rounded-xl text-sm font-medium shadow-md hover:shadow-lg hover:-translate-y-0.5 transition-all">
          <Plus size={16} /> Nova categoria
        </button>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => <div key={i} className="h-[60px] bg-gray-100 dark:bg-gray-800 rounded-2xl animate-pulse" />)}
        </div>
      ) : categorias.length === 0 ? (
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 p-10 text-center text-gray-500">
          <Tags size={40} className="mx-auto mb-3 opacity-30" />
          <p className="font-medium text-gray-700 dark:text-gray-300">Nenhuma categoria cadastrada</p>
          <p className="text-sm text-gray-400 mt-1">As categorias cadastradas aparecerão aqui.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {categorias.map((c) => (
            <div key={c.id} className="flex items-center justify-between bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-4">
              <div>
                <p className="font-medium text-gray-900 dark:text-white text-sm">{c.nome}</p>
                {c.descricao && <p className="text-xs text-gray-500">{c.descricao}</p>}
              </div>
              <div className="flex items-center gap-1">
                <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium mr-2', c.ativo ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500')}>
                  {c.ativo ? 'Ativa' : 'Inativa'}
                </span>
                <button
                  onClick={() => abrirEdicao(c)}
                  title="Editar"
                  aria-label="Editar categoria"
                  className="p-2 rounded-lg text-gray-400 hover:text-brand hover:bg-brand/5 focus:outline-none focus:ring-2 focus:ring-brand/30 transition"
                ><Pencil size={16} /></button>
                <button
                  onClick={() => alternarAtivo(c)}
                  disabled={alternandoIds.has(c.id)}
                  title={c.ativo ? 'Desativar' : 'Ativar'}
                  aria-label={c.ativo ? 'Desativar categoria' : 'Ativar categoria'}
                  aria-busy={alternandoIds.has(c.id)}
                  className="p-2 rounded-lg text-gray-400 hover:text-brand hover:bg-brand/5 focus:outline-none focus:ring-2 focus:ring-brand/30 disabled:opacity-60 disabled:cursor-not-allowed transition"
                >{alternandoIds.has(c.id) ? <Loader2 size={16} className="animate-spin" /> : <Power size={16} />}</button>
                <button
                  onClick={() => setRemovendo(c)}
                  title="Remover"
                  aria-label="Remover categoria"
                  className="p-2 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-500/30 transition"
                ><Trash2 size={16} /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {modalAberto && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setModalAberto(false)} />
          <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl p-6 w-full max-w-md space-y-4">
            <h3 className="font-semibold text-gray-900 dark:text-white">Nova categoria</h3>
            <div>
              <label htmlFor="categoria-nome" className="block text-sm font-medium mb-1">Nome</label>
              <input id="categoria-nome" value={nome} onChange={(e) => setNome(e.target.value)} maxLength={100} className="w-full px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition" />
            </div>
            <div>
              <label htmlFor="categoria-descricao" className="block text-sm font-medium mb-1">Descrição (opcional)</label>
              <input id="categoria-descricao" value={descricao} onChange={(e) => setDescricao(e.target.value)} maxLength={300} className="w-full px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition" />
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
            <h3 className="font-semibold text-gray-900 dark:text-white">Editar categoria</h3>
            <div>
              <label htmlFor="edit-categoria-nome" className="block text-sm font-medium mb-1">Nome da categoria</label>
              <input id="edit-categoria-nome" value={editNome} onChange={(e) => setEditNome(e.target.value)} maxLength={100} className="w-full px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition" />
            </div>
            <div>
              <label htmlFor="edit-categoria-descricao" className="block text-sm font-medium mb-1">Descrição (opcional)</label>
              <input id="edit-categoria-descricao" value={editDescricao} onChange={(e) => setEditDescricao(e.target.value)} maxLength={300} className="w-full px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition" />
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
        title="Remover categoria"
        description={
          removendo
            ? `Tem certeza de que deseja remover a categoria "${removendo.nome}"?` +
              (removendo._count && removendo._count.patrimonios > 0
                ? ` Ela possui ${removendo._count.patrimonios} bem(ns) vinculado(s) — nesse caso, em vez de excluir, ela será desativada e deixará de aparecer em novos cadastros e solicitações.`
                : ' Ela não possui bens vinculados e será excluída permanentemente.')
            : ''
        }
        confirmLabel="Remover"
        variant="danger"
        loading={removendoLoading}
        onCancel={() => setRemovendo(null)}
        onConfirm={confirmarRemocao}
      />
    </div>
  )
}
