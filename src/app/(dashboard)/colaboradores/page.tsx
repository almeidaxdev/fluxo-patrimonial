// src/app/(dashboard)/colaboradores/page.tsx
'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { z } from 'zod'
import { Users, Plus, Search, Pencil, Trash2, KeyRound, X, Loader2, Check, ShieldCheck, CheckCircle2, XCircle, UserCog, ShieldHalf, SlidersHorizontal } from 'lucide-react'
import { User, Permissao, PERMISSAO_LABELS } from '@/types'
import { useToast } from '@/hooks/use-toast'
import { useAuth } from '@/components/auth/AuthProvider'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Switch } from '@/components/ui/Switch'
import { nomeColaboradorSchema, senhaNovaSchema, LIMITES_INPUT } from '@/lib/validations'
import { cn } from '@/utils'

// Checagem client-side de FORMATO apenas (nunca de domínio permitido — essa
// lista vem de ALLOWED_EMAIL_DOMAINS, uma env var server-only que não chega
// ao bundle do navegador de propósito; ver comentário de `emailPermitidoSchema`
// em src/lib/validations.ts). Se o domínio não for autorizado, o servidor
// rejeita e o motivo aparece no toast de erro do submit, como qualquer outro
// erro de validação retornado pela API.
const emailFormatoSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(LIMITES_INPUT.email, `E-mail deve ter no máximo ${LIMITES_INPUT.email} caracteres.`)
  .email('E-mail inválido.')

const PERMISSAO_COLORS: Record<Permissao, string> = {
  colaborador: 'bg-blue-100 dark:bg-blue-950 text-blue-800 dark:text-blue-300 border-blue-200 dark:border-blue-800',
  patrimonio: 'bg-purple-100 dark:bg-purple-950 text-purple-800 dark:text-purple-300 border-purple-200 dark:border-purple-800',
  administrador: 'bg-orange-100 dark:bg-orange-950 text-orange-800 dark:text-orange-300 border-orange-200 dark:border-orange-800',
}

interface ColaboradorModalProps {
  user?: User | null
  gestores: { id: string; nome: string }[]
  onClose: () => void
  onSave: () => void
}

// Rótulo de seção — pequeno, maiúsculo, discreto: mesma função visual de um
// <th> de tabela (identifica o grupo sem competir com o conteúdo).
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-3">{children}</p>
}

// Badge de status — ícone + texto + cor (nunca só cor, item 15 do pedido).
// Mesmas classes de cor já usadas na coluna "Status" da tabela, para o badge
// do modal nunca parecer um componente visual diferente do resto da tela.
function StatusBadge({ ativo }: { ativo: boolean }) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold border',
      ativo
        ? 'bg-green-100 dark:bg-green-950 text-green-800 dark:text-green-300 border-green-200 dark:border-green-800'
        : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 border-gray-200 dark:border-gray-700'
    )}>
      {ativo ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
      {ativo ? 'Ativo' : 'Inativo'}
    </span>
  )
}

interface SwitchFieldProps {
  icon: React.ReactNode
  title: string
  description: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}

// Linha padrão "switch + título + descrição curta" — usada por status da
// conta e pelas duas permissões adicionais, para as três terem exatamente a
// mesma estrutura visual (item 16 do pedido: título + breve descrição).
function SwitchField({ icon, title, description, checked, onChange, disabled }: SwitchFieldProps) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="flex items-start gap-3 min-w-0">
        <div className="mt-0.5 text-gray-400 dark:text-gray-500 shrink-0">{icon}</div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900 dark:text-white">{title}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{description}</p>
        </div>
      </div>
      <Switch checked={checked} onChange={onChange} disabled={disabled} aria-label={title} />
    </div>
  )
}

function ColaboradorModal({ user, gestores, onClose, onSave }: ColaboradorModalProps) {
  const { toast } = useToast()
  const { user: sessionUser, revalidateNow } = useAuth()
  const [loading, setLoading] = useState(false)
  const [confirmarDesativar, setConfirmarDesativar] = useState(false)
  const [form, setForm] = useState({
    nome: user?.nome || '',
    email: user?.email || '',
    senha: '',
    ativo: user?.ativo ?? true,
    permissao: (user?.permissao || 'colaborador') as Permissao,
    podeSerGestor: user?.podeSerGestor || false,
    podeSolicitarParaOutro: user?.podeSolicitarParaOutro || false,
    gestorPadraoId: user?.gestorPadraoId || '',
  })

  const éAPropriaConta = !!user && !!sessionUser && user.id === sessionUser.id
  const houveMudancaSensivel = !!user && (form.email.trim().toLowerCase() !== user.email)

  function aoAlterarAtivo(novoValor: boolean) {
    // Desativar exige confirmação (item 10); reativar aplica direto.
    if (!novoValor) {
      setConfirmarDesativar(true)
      return
    }
    setForm((p) => ({ ...p, ativo: true }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    // Validação client-side com os MESMOS schemas usados no backend — feedback
    // rápido, nunca a fonte de verdade (o backend revalida tudo de novo).
    const parsedNome = nomeColaboradorSchema.safeParse(form.nome)
    if (!parsedNome.success) {
      toast({ title: 'Nome inválido', description: parsedNome.error.errors[0]?.message, variant: 'destructive' })
      return
    }

    // Contas legadas (criadas antes da regra atual de domínio permitido, ou
    // com ALLOWED_EMAIL_DOMAINS de outra configuração): o e-mail SEMPRE vai
    // no body do PATCH, mesmo quando o Admin só mexeu em
    // ativo/permissão/capacidade. Exigir domínio permitido
    // incondicionalmente travaria qualquer edição administrativa nessas
    // contas até alguém trocar o e-mail delas — não era a intenção. Mesma
    // regra do backend: só valida quando o valor normalizado REALMENTE muda
    // em relação ao já persistido (`user.email`); mantendo o valor atual
    // (mesmo legado), passa direto. Aqui só checamos FORMATO — a
    // autorização de domínio é decidida só pelo servidor (ver
    // emailFormatoSchema acima).
    const emailNormalizado = form.email.trim().toLowerCase()
    const emailRealmenteMudou = !user || emailNormalizado !== user.email
    if (emailRealmenteMudou) {
      const parsedEmail = emailFormatoSchema.safeParse(form.email)
      if (!parsedEmail.success) {
        toast({ title: 'E-mail inválido', description: parsedEmail.error.errors[0]?.message, variant: 'destructive' })
        return
      }
    }

    setLoading(true)
    try {
      if (user) {
        const res = await fetch(`/api/colaboradores/${user.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            nome: parsedNome.data,
            email: emailNormalizado,
            ativo: form.ativo,
            permissao: form.permissao,
            podeSerGestor: form.podeSerGestor,
            podeSolicitarParaOutro: form.podeSolicitarParaOutro,
            gestorPadraoId: form.gestorPadraoId || null,
          }),
        })
        const r = await res.json()
        if (!res.ok) { toast({ title: 'Erro', description: r.message, variant: 'destructive' }); return }

        if (éAPropriaConta && r.revogouSessao) {
          // Etapa fix/collaborator-session-sync: o próprio admin alterou um
          // campo sensível da PRÓPRIA conta (e-mail, ativo, permissão...) —
          // a sessão atual acabou de ficar obsoleta. Nunca deixamos a tela
          // continuar "autenticada" com o JWT antigo: fecha o modal e força
          // uma revalidação imediata, que recebe 401 e o AuthProvider já
          // redireciona para /login com o aviso padrão.
          toast({ title: 'Dados atualizados', description: 'Você alterou dados sensíveis da própria conta — será necessário entrar novamente.' })
          onClose()
          await revalidateNow()
          return
        }

        toast({
          title: 'Colaborador atualizado!',
          description: r.revogouSessao ? 'As sessões anteriores desse usuário foram revogadas.' : undefined,
        })
      } else {
        // Etapa security/input-hardening-b1: mesma regra de senha nova do
        // backend (mínimo 8 caracteres, máximo 72 bytes UTF-8, sem exigência
        // de complexidade) — feedback rápido, nunca a fonte de verdade.
        const parsedSenha = senhaNovaSchema.safeParse(form.senha)
        if (!parsedSenha.success) {
          toast({ title: 'Senha inválida', description: parsedSenha.error.errors[0]?.message, variant: 'destructive' })
          return
        }
        const res = await fetch('/api/colaboradores', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Criação: `emailRealmenteMudou` é sempre true aqui (`!user`),
          // então `emailNormalizado` já passou pela checagem de FORMATO
          // acima — a autorização de domínio (ALLOWED_EMAIL_DOMAINS) é
          // decidida só pelo servidor na resposta deste POST; nunca há
          // "legado" possível numa conta que ainda não existe.
          body: JSON.stringify({ ...form, nome: parsedNome.data, email: emailNormalizado }),
        })
        const r = await res.json()
        if (!res.ok) { toast({ title: 'Erro', description: r.message, variant: 'destructive' }); return }
        toast({ title: 'Colaborador cadastrado!' })
      }
      onSave()
    } finally { setLoading(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white dark:bg-gray-900 shadow-2xl border border-gray-200 dark:border-gray-700 w-full h-full sm:h-auto sm:max-w-2xl sm:rounded-2xl sm:max-h-[90vh] flex flex-col animate-fade-in">
        {/* Cabeçalho fixo — some com o scroll interno do corpo, nunca com o modal inteiro */}
        <div className="flex items-center justify-between px-5 sm:px-7 py-4 border-b border-gray-100 dark:border-gray-800 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-full bg-brand/10 dark:bg-brand/20 flex items-center justify-center shrink-0">
              <span className="text-brand dark:text-blue-400 font-bold text-sm">{(form.nome || user?.nome || '?')[0]?.toUpperCase()}</span>
            </div>
            <div className="min-w-0">
              <h3 className="font-bold text-gray-900 dark:text-white text-base leading-tight truncate">{user ? 'Editar colaborador' : 'Novo colaborador'}</h3>
              {user && (
                <div className="mt-1"><StatusBadge ativo={form.ativo} /></div>
              )}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition shrink-0 p-1"><X size={20} /></button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
          <div className="flex-1 overflow-y-auto px-5 sm:px-7 py-5 space-y-6">
            {/* Dados do colaborador */}
            <section>
              <SectionLabel>Dados do colaborador</SectionLabel>
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Nome</label>
                  <input value={form.nome} onChange={e => setForm(p => ({ ...p, nome: e.target.value }))} placeholder="Nome do colaborador" maxLength={120}
                    className="w-full px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 transition" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">E-mail corporativo</label>
                  <input type="email" value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))} placeholder="nome@empresa.com" maxLength={254}
                    className="w-full px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 transition" />
                  <p className="text-xs text-gray-400 mt-1">Somente domínios de e-mail autorizados por este sistema.</p>
                  {houveMudancaSensivel && (
                    <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                      {éAPropriaConta ? 'Ao salvar, você precisará entrar novamente com o novo e-mail.' : 'Ao salvar, as sessões atuais desse colaborador serão encerradas.'}
                    </p>
                  )}
                </div>
                {!user && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Senha inicial</label>
                    <input type="password" value={form.senha} onChange={e => setForm(p => ({ ...p, senha: e.target.value }))} placeholder="Mínimo 8 caracteres" minLength={8}
                      className="w-full px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 transition" />
                  </div>
                )}
              </div>
            </section>

            {/* Status da conta — só existe para edição (conta nova sempre nasce ativa) */}
            {user && (
              <section className="pt-6 border-t border-gray-100 dark:border-gray-800">
                <SectionLabel>Status da conta</SectionLabel>
                <SwitchField
                  icon={<UserCog size={18} />}
                  title="Usuário ativo"
                  description="Controla o acesso deste colaborador ao sistema."
                  checked={form.ativo}
                  onChange={aoAlterarAtivo}
                  disabled={éAPropriaConta}
                />
                {éAPropriaConta && (
                  <p className="text-xs text-gray-400 -mt-1">Você não pode desativar sua própria conta.</p>
                )}
              </section>
            )}

            {/* Acesso e permissões */}
            <section className="pt-6 border-t border-gray-100 dark:border-gray-800">
              <SectionLabel>Acesso e permissões</SectionLabel>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Permissão principal</label>
                <select value={form.permissao} onChange={e => setForm(p => ({ ...p, permissao: e.target.value as Permissao }))}
                  className="w-full px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 transition">
                  {Object.entries(PERMISSAO_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>

              <div className="mt-1 divide-y divide-gray-100 dark:divide-gray-800">
                <SwitchField
                  icon={<ShieldHalf size={18} />}
                  title="Pode atuar como gestor"
                  description="Permite aprovar solicitações externas atribuídas a este colaborador."
                  checked={form.podeSerGestor}
                  onChange={(v) => setForm(p => ({ ...p, podeSerGestor: v }))}
                />
                <SwitchField
                  icon={<SlidersHorizontal size={18} />}
                  title="Pode solicitar para outro colaborador"
                  description="Permite criar reservas em nome de outros colaboradores."
                  checked={form.podeSolicitarParaOutro}
                  onChange={(v) => setForm(p => ({ ...p, podeSolicitarParaOutro: v }))}
                />
              </div>
            </section>

            {/* Configurações de solicitação */}
            <section className="pt-6 border-t border-gray-100 dark:border-gray-800">
              <SectionLabel>Configurações de solicitação</SectionLabel>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Gestor padrão</label>
              <select value={form.gestorPadraoId} onChange={e => setForm(p => ({ ...p, gestorPadraoId: e.target.value }))}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 transition">
                <option value="">Nenhum</option>
                {gestores.filter(g => g.id !== user?.id).map(g => <option key={g.id} value={g.id}>{g.nome}</option>)}
              </select>
              <p className="text-xs text-gray-400 mt-1">Usado automaticamente em atividades externas deste colaborador.</p>
            </section>
          </div>

          {/* Rodapé fixo */}
          <div className="flex gap-3 px-5 sm:px-7 py-4 border-t border-gray-100 dark:border-gray-800 shrink-0">
            <button type="button" onClick={onClose} className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition">Cancelar</button>
            <button type="submit" disabled={loading} className="flex-1 flex items-center justify-center gap-2 bg-brand hover:bg-brand-dark text-white text-sm font-semibold py-2.5 rounded-xl transition disabled:opacity-60">
              {loading ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
              {user ? 'Salvar alterações' : 'Cadastrar'}
            </button>
          </div>
        </form>
      </div>

      <ConfirmDialog
        open={confirmarDesativar}
        variant="warning"
        title="Desativar colaborador?"
        description="Este usuário não poderá entrar no sistema e as sessões atuais serão revogadas."
        confirmLabel="Desativar usuário"
        onConfirm={() => { setForm((p) => ({ ...p, ativo: false })); setConfirmarDesativar(false) }}
        onCancel={() => setConfirmarDesativar(false)}
      />
    </div>
  )
}

export default function ColaboradoresPage() {
  const { toast } = useToast()
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  // Etapa perf/system-optimization: `buscaInput` reflete cada tecla
  // imediatamente no campo (sem isso, o campo pareceria travado); `busca`
  // (debounced, mesmo padrão de 300ms já usado em nova-solicitacao.tsx para
  // a busca de colaborador) é o valor que efetivamente dispara o fetch —
  // sem esse atraso, cada tecla digitada disparava uma requisição/consulta
  // completa ao banco, mesmo com o usuário ainda no meio da palavra.
  const [buscaInput, setBuscaInput] = useState('')
  const [busca, setBusca] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [modal, setModal] = useState<{ open: boolean; user?: User | null }>({ open: false })
  const [deleteDialog, setDeleteDialog] = useState<{ open: boolean; id?: string; nome?: string }>({ open: false })
  const [resetDialog, setResetDialog] = useState<{ open: boolean; id?: string; nome?: string }>({ open: false })
  const [senhaGerada, setSenhaGerada] = useState<{ nome: string; senha: string } | null>(null)
  const [actionLoading, setActionLoading] = useState(false)
  // Guarda síncrona contra duplo clique: `actionLoading` só reflete no DOM
  // (botão disabled) depois de um re-render, então dois cliques disparados
  // antes desse re-render ainda veriam actionLoading=false. Uma ref é lida/
  // escrita de forma síncrona, sem esperar o React re-renderizar.
  const resetandoRef = useRef(false)
  const [gestores, setGestores] = useState<{ id: string; nome: string }[]>([])
  const LIMIT = 10

  useEffect(() => {
    fetch('/api/gestores').then(r => r.json()).then(d => setGestores(d.gestores || []))
  }, [])

  useEffect(() => {
    const t = setTimeout(() => setBusca(buscaInput.trim()), 300)
    return () => clearTimeout(t)
  }, [buscaInput])

  const fetchUsers = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(LIMIT) })
      if (busca) params.set('busca', busca)
      const res = await fetch(`/api/colaboradores?${params}`)
      const data = await res.json()
      setUsers(data.users || [])
      setTotal(data.total || 0)
    } finally { setLoading(false) }
  }, [page, busca])

  useEffect(() => { setPage(1) }, [busca])
  useEffect(() => { fetchUsers() }, [fetchUsers])

  async function handleDelete() {
    if (!deleteDialog.id) return
    setActionLoading(true)
    try {
      const res = await fetch(`/api/colaboradores/${deleteDialog.id}`, { method: 'DELETE' })
      if (!res.ok) { const r = await res.json(); toast({ title: 'Erro', description: r.message, variant: 'destructive' }); return }
      toast({ title: 'Colaborador removido!' })
      setDeleteDialog({ open: false })
      fetchUsers()
    } finally { setActionLoading(false) }
  }

  async function handleResetSenha() {
    if (!resetDialog.id || resetandoRef.current) return
    resetandoRef.current = true
    setActionLoading(true)
    try {
      const res = await fetch(`/api/colaboradores/${resetDialog.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resetSenha: true }),
      })
      const r = await res.json()
      if (!res.ok) { toast({ title: 'Erro', description: r.message, variant: 'destructive' }); return }
      // A senha temporária só existe nesta resposta — nunca é reconsultável
      // depois. Guardamos em estado local só até o diálogo de exibição ser
      // fechado (ver <ConfirmDialog ... open={!!senhaGerada}> abaixo).
      setSenhaGerada({ nome: resetDialog.nome ?? '', senha: r.senhaTemporaria })
      setResetDialog({ open: false })
    } catch {
      toast({ title: 'Erro', description: 'Não foi possível redefinir a senha. Tente novamente.', variant: 'destructive' })
    } finally {
      setActionLoading(false)
      resetandoRef.current = false
    }
  }

  const totalPages = Math.ceil(total / LIMIT)

  return (
    <div className="space-y-5 max-w-5xl">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <Users size={22} className="text-brand" /> Colaboradores
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{total} colaborador(es) cadastrado(s)</p>
        </div>
        <button onClick={() => setModal({ open: true, user: null })} className="flex items-center justify-center gap-2 px-4 py-2.5 bg-brand hover:bg-brand-dark text-white text-sm font-semibold rounded-xl transition shadow-sm">
          <Plus size={16} /> Novo colaborador
        </button>
      </div>

      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-4">
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={buscaInput}
            onChange={e => setBuscaInput(e.target.value)}
            placeholder="Buscar por nome ou e-mail..."
            maxLength={120}
            className="w-full pl-9 pr-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 transition"
          />
        </div>
      </div>

      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden">
        {loading ? (
          <div className="p-6 space-y-3">{[...Array(5)].map((_, i) => <div key={i} className="h-12 bg-gray-100 dark:bg-gray-800 rounded-xl animate-pulse" />)}</div>
        ) : users.length === 0 ? (
          <div className="text-center py-16 text-gray-500 dark:text-gray-400">
            <Users size={48} className="mx-auto mb-3 opacity-20" />
            <p>Nenhum colaborador encontrado.</p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50">
                    {['Nome', 'E-mail', 'Permissão', 'Gestor', 'Status', 'Ações'].map(h => (
                      <th key={h} className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {users.map((u) => (
                    <tr key={u.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/40 transition">
                      <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{u.nome}</td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{u.email}</td>
                      <td className="px-4 py-3">
                        <span className={cn('inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium border', PERMISSAO_COLORS[u.permissao])}>
                          <ShieldCheck size={11} /> {PERMISSAO_LABELS[u.permissao]}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {u.podeSerGestor ? (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-indigo-100 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800">Sim</span>
                        ) : (
                          <span className="text-gray-300 text-xs">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={cn('inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border', u.ativo ? 'bg-green-100 dark:bg-green-950 text-green-800 dark:text-green-300 border-green-200 dark:border-green-800' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 border-gray-200 dark:border-gray-700')}>
                          {u.ativo ? 'Ativo' : 'Inativo'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <button onClick={() => setModal({ open: true, user: u })} className="p-2 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-950 text-gray-400 hover:text-blue-600 transition" title="Editar permissão">
                            <Pencil size={15} />
                          </button>
                          <button onClick={() => setResetDialog({ open: true, id: u.id, nome: u.nome })} className="p-2 rounded-lg hover:bg-yellow-50 dark:hover:bg-yellow-950 text-gray-400 hover:text-yellow-600 transition" title="Redefinir senha">
                            <KeyRound size={15} />
                          </button>
                          <button onClick={() => setDeleteDialog({ open: true, id: u.id, nome: u.nome })} className="p-2 rounded-lg hover:bg-red-50 dark:hover:bg-red-950 text-gray-400 hover:text-red-600 transition" title="Deletar">
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 dark:border-gray-800">
                <p className="text-xs text-gray-500 dark:text-gray-400">Página {page} de {totalPages}</p>
                <div className="flex gap-2">
                  <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-xs text-gray-600 dark:text-gray-400 disabled:opacity-40 hover:bg-gray-50 dark:hover:bg-gray-800 transition">Anterior</button>
                  <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-xs text-gray-600 dark:text-gray-400 disabled:opacity-40 hover:bg-gray-50 dark:hover:bg-gray-800 transition">Próxima</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {modal.open && <ColaboradorModal user={modal.user} gestores={gestores} onClose={() => setModal({ open: false })} onSave={() => { setModal({ open: false }); fetchUsers(); fetch('/api/gestores').then(r => r.json()).then(d => setGestores(d.gestores || [])) }} />}
      <ConfirmDialog open={deleteDialog.open} title="Remover colaborador" description={`Tem certeza que deseja remover ${deleteDialog.nome}? Esta ação não pode ser desfeita.`} confirmLabel="Remover" loading={actionLoading} onConfirm={handleDelete} onCancel={() => setDeleteDialog({ open: false })} />
      <ConfirmDialog
        open={resetDialog.open}
        variant="warning"
        title="Redefinir senha"
        description={`Uma nova senha temporária, gerada aleatoriamente, será criada para ${resetDialog.nome}. Ela será exibida uma única vez logo após a confirmação — anote-a para repassar ao colaborador.`}
        confirmLabel="Redefinir"
        loading={actionLoading}
        onConfirm={handleResetSenha}
        onCancel={() => setResetDialog({ open: false })}
      />
      <ConfirmDialog
        open={!!senhaGerada}
        variant="warning"
        hideCancel
        title="Senha temporária gerada"
        description={
          senhaGerada && (
            <>
              Senha temporária de <strong>{senhaGerada.nome}</strong>:{' '}
              <code className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 font-mono text-gray-900 dark:text-white select-all">{senhaGerada.senha}</code>
              <br />
              Informe-a ao colaborador por um canal seguro agora — ela não poderá ser consultada novamente depois de fechar esta janela.
            </>
          )
        }
        confirmLabel="Fechar"
        onConfirm={() => setSenhaGerada(null)}
        onCancel={() => setSenhaGerada(null)}
      />
    </div>
  )
}
