// src/app/(dashboard)/nova-solicitacao/page.tsx
'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  CheckCircle2, ChevronLeft, ChevronRight, Loader2, Search, Trash2, Plus, Check,
  Laptop, Package, Building2, MapPin, User as UserIcon, AlertTriangle, Wrench
} from 'lucide-react'
import { useSession } from '@/hooks/use-session'
import { useToast } from '@/hooks/use-toast'
import { podeSolicitarParaOutro } from '@/lib/permissions'
import { CategoriaPatrimonio, Patrimonio, PeriodoSolicitacao, PERIODO_LABELS, TipoEmprestimo, TipoServico, TipoDominio, TIPO_DOMINIO_LABELS } from '@/types'
import { cn, formatDataCivil, formatPeriodos, todayISO } from '@/utils'
import { calcularPrazo, formatarAntecedencia } from '@/lib/prazo'
import { parseQuantidadeServico } from '@/lib/servico-form'

const STEPS = ['Tipo e solicitante', 'Dados da atividade', 'Data e período', 'Itens', 'Resumo']

interface ColaboradorBusca { id: string; nome: string; email: string; gestorPadraoId: string | null }
interface Gestor { id: string; nome: string; email: string }
interface ItemPapelariaForm { descricao: string; quantidade: number }
interface ItemServicoForm { tipoServicoId: string; tipoServicoNome: string; quantidade: number; ambiente: string; observacao?: string }

export default function NovaSolicitacaoPage() {
  const { user } = useSession()
  const { toast } = useToast()
  const router = useRouter()

  const [step, setStep] = useState(0)
  const [enviando, setEnviando] = useState(false)

  // Etapa 1
  const [tipoEmprestimo, setTipoEmprestimo] = useState<TipoEmprestimo>('interno')
  const [paraOutro, setParaOutro] = useState(false)
  const [buscaColab, setBuscaColab] = useState('')
  const [resultadosColab, setResultadosColab] = useState<ColaboradorBusca[]>([])
  const [solicitante, setSolicitante] = useState<ColaboradorBusca | null>(null)

  // Etapa 2
  const [ambiente, setAmbiente] = useState('')
  const [finalidade, setFinalidade] = useState('')
  const [atividadeExterna, setAtividadeExterna] = useState('')
  const [local, setLocal] = useState('')
  const [cidade, setCidade] = useState('')
  const [gestorId, setGestorId] = useState('')
  // Último gestor padrão APLICADO automaticamente (não o valor atual do
  // campo) — ver efeito de pré-seleção abaixo.
  const gestorPadraoAplicadoRef = useRef<string | null>(null)
  const [gestores, setGestores] = useState<Gestor[]>([])
  const [observacoes, setObservacoes] = useState('')

  // Etapa 3
  const [data, setData] = useState('')
  const [periodos, setPeriodos] = useState<PeriodoSolicitacao[]>([])

  // Etapa 4
  const [categorias, setCategorias] = useState<CategoriaPatrimonio[]>([])
  const [categoriaSelecionada, setCategoriaSelecionada] = useState('')
  const [disponiveis, setDisponiveis] = useState<Patrimonio[] | null>(null)
  const [buscandoDisponiveis, setBuscandoDisponiveis] = useState(false)
  const [selecaoTemp, setSelecaoTemp] = useState<Set<string>>(new Set())
  const [itensBens, setItensBens] = useState<Patrimonio[]>([])
  // Domínio (Etapa domain-flow): default por tipo de solicitação — interno
  // nasce "Sim + Educacional", externo nasce "Não". O efeito abaixo reaplica
  // esse default sempre que tipoEmprestimo muda (nunca preserva a escolha
  // anterior ao trocar interno <-> externo).
  const [notebooksComDominio, setNotebooksComDominio] = useState(true)
  const [tipoDominio, setTipoDominio] = useState<TipoDominio | null>('EDUCACIONAL')
  const [itensPapelaria, setItensPapelaria] = useState<ItemPapelariaForm[]>([])
  const [novoItemDesc, setNovoItemDesc] = useState('')
  const [novoItemQtd, setNovoItemQtd] = useState('')
  const [categoriasCarregando, setCategoriasCarregando] = useState(true)
  const [categoriasErro, setCategoriasErro] = useState(false)
  const [avisoPrazoAberto, setAvisoPrazoAberto] = useState(false)

  // Serviços / Movimentações (Fase 3 — Etapa 3)
  const [tiposServico, setTiposServico] = useState<TipoServico[]>([])
  const [tiposServicoCarregando, setTiposServicoCarregando] = useState(true)
  const [tiposServicoErro, setTiposServicoErro] = useState(false)
  const [itensServico, setItensServico] = useState<ItemServicoForm[]>([])
  const [novoServicoId, setNovoServicoId] = useState('')
  const [novoServicoQtd, setNovoServicoQtd] = useState('')
  const [novoServicoAmbiente, setNovoServicoAmbiente] = useState('')
  const [novoServicoObs, setNovoServicoObs] = useState('')

  useEffect(() => {
    // Carregamento de categorias é único e compartilhado entre os fluxos
    // interno e externo — não há lógica exclusiva de um dos dois aqui.
    setCategoriasCarregando(true)
    fetch('/api/categorias')
      .then((r) => r.json())
      .then((d) => setCategorias(d.categorias || []))
      .catch(() => setCategoriasErro(true))
      .finally(() => setCategoriasCarregando(false))
    fetch('/api/gestores').then((r) => r.json()).then((d) => setGestores(d.gestores || []))

    setTiposServicoCarregando(true)
    fetch('/api/tipos-servico')
      .then((r) => r.json())
      .then((d) => setTiposServico(d.tiposServico || []))
      .catch(() => setTiposServicoErro(true))
      .finally(() => setTiposServicoCarregando(false))
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

  // Preenche gestor padrão automaticamente quando aplicável.
  //
  // Etapa fix/default-manager-self-request — antes, o gestor padrão só era
  // aplicado quando `paraOutro` (o objeto `solicitante`, vindo de
  // /api/colaboradores/busca, é o único que trazia `gestorPadraoId`; o
  // usuário autenticado, servido por /api/auth/me via
  // getValidatedMutationSession(), não trazia esse campo). Agora a regra
  // depende só do SOLICITANTE EFETIVO (ver types/index.ts, SessaoAtual —
  // `user` também carrega `gestorPadraoId`), igual para "para si" e "para
  // outro".
  //
  // `gestorPadraoAplicadoRef` guarda o ÚLTIMO valor aplicado automaticamente
  // (não o valor atual do campo) para diferenciar "usuário nunca mexeu no
  // campo" de "usuário trocou manualmente para o mesmo id que por acaso é o
  // default" — e assim decidir se um novo default (troca de solicitante, ou
  // entrada em Externo) pode substituir o valor atual sem perder uma escolha
  // manual real. Se `gestorId` atual não é mais igual ao último default
  // aplicado, foi o usuário quem mudou — não sobrescrever.
  useEffect(() => {
    if (tipoEmprestimo !== 'externo') return
    const solicitanteEfetivo = paraOutro ? solicitante : user
    const gestorPadraoId = solicitanteEfetivo?.gestorPadraoId ?? null
    setGestorId((atual) => {
      if (atual && atual !== gestorPadraoAplicadoRef.current) return atual
      gestorPadraoAplicadoRef.current = gestorPadraoId
      return gestorPadraoId || ''
    })
  }, [tipoEmprestimo, paraOutro, solicitante, user])

  // Domínio: default por tipo de solicitação, reaplicado a cada troca
  // interno <-> externo (nunca preserva a escolha anterior).
  useEffect(() => {
    if (tipoEmprestimo === 'interno') {
      setNotebooksComDominio(true)
      setTipoDominio('EDUCACIONAL')
    } else {
      setNotebooksComDominio(false)
      setTipoDominio(null)
    }
  }, [tipoEmprestimo])

  function alternarDominio(ligado: boolean) {
    setNotebooksComDominio(ligado)
    setTipoDominio(ligado ? 'EDUCACIONAL' : null)
  }

  const temNotebookSelecionado = useMemo(
    () => itensBens.some((b) => b.categoria?.nome.toLowerCase() === 'notebook'),
    [itensBens]
  )

  function togglePeriodo(p: PeriodoSolicitacao) {
    setPeriodos((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]))
  }

  async function buscarDisponibilidade() {
    if (!categoriaSelecionada || !data || periodos.length === 0) {
      toast({ title: 'Preencha categoria, data e período', variant: 'destructive' })
      return
    }
    setBuscandoDisponiveis(true)
    setDisponiveis(null)
    setSelecaoTemp(new Set())
    try {
      const params = new URLSearchParams({ categoriaId: categoriaSelecionada, data })
      periodos.forEach((p) => params.append('periodo', p))
      const res = await fetch(`/api/patrimonios/disponibilidade?${params}`)
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

  function validarEtapa(atual: number): string | null {
    if (atual === 0) {
      if (paraOutro && !solicitante) return 'Selecione o colaborador solicitante.'
    }
    if (atual === 1) {
      if (tipoEmprestimo === 'interno' && !ambiente.trim()) return 'Informe o ambiente ou sala.'
      if (tipoEmprestimo === 'externo') {
        if (!atividadeExterna.trim() || !local.trim() || !cidade.trim()) return 'Preencha atividade, local e cidade.'
        if (!gestorId) return 'Selecione o gestor responsável.'
      }
    }
    if (atual === 2) {
      if (!data) return 'Selecione a data.'
      if (periodos.length === 0) return 'Selecione ao menos um período.'
    }
    if (atual === 3) {
      if (itensBens.length === 0 && itensPapelaria.length === 0 && itensServico.length === 0) {
        return 'Adicione pelo menos um bem patrimonial, um item de papelaria ou um serviço/movimentação para continuar.'
      }
    }
    return null
  }

  // Fase 3 — mesma regra usada pelo backend (src/lib/prazo.ts), calculada em
  // tempo real para orientar o usuário antes do envio. O valor definitivo
  // (histórico) é recalculado e persistido pelo backend na criação.
  const prazoInfo = useMemo(() => {
    if (!data || periodos.length === 0) return null
    return calcularPrazo(tipoEmprestimo, data, periodos)
  }, [tipoEmprestimo, data, periodos])

  function avancar() {
    const erro = validarEtapa(step)
    if (erro) { toast({ title: 'Não foi possível avançar', description: erro, variant: 'destructive' }); return }
    setStep((s) => Math.min(s + 1, STEPS.length - 1))
  }

  async function enviar() {
    if (!user) return
    setEnviando(true)
    try {
      const body = {
        tipoEmprestimo,
        solicitanteId: paraOutro && solicitante ? solicitante.id : user.id,
        ambiente: tipoEmprestimo === 'interno' ? ambiente : undefined,
        finalidade,
        atividadeExterna: tipoEmprestimo === 'externo' ? atividadeExterna : undefined,
        local: tipoEmprestimo === 'externo' ? local : undefined,
        cidade: tipoEmprestimo === 'externo' ? cidade : undefined,
        gestorId: tipoEmprestimo === 'externo' ? gestorId : undefined,
        observacoes,
        data,
        periodos,
        notebooksComDominio: temNotebookSelecionado ? notebooksComDominio : undefined,
        tipoDominio: temNotebookSelecionado && notebooksComDominio ? (tipoDominio ?? undefined) : undefined,
        patrimonioIds: itensBens.map((b) => b.id),
        itensPapelaria,
        servicos: itensServico.map((s) => ({
          tipoServicoId: s.tipoServicoId,
          quantidade: s.quantidade,
          ambiente: s.ambiente,
          observacao: s.observacao,
        })),
      }

      const res = await fetch('/api/solicitacoes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const result = await res.json()

      if (!res.ok) {
        toast({ title: 'Não foi possível enviar', description: result.message, variant: 'destructive' })
        return
      }

      toast({ title: 'Solicitação enviada!', description: `Solicitação #${result.solicitacao.numero} criada com sucesso.` })
      router.push(`/solicitacoes/${result.solicitacao.id}`)
    } catch {
      toast({ title: 'Erro', description: 'Falha ao enviar a solicitação.', variant: 'destructive' })
    } finally {
      setEnviando(false)
    }
  }

  function handleClickEnviar() {
    if (prazoInfo && !prazoInfo.dentroDoPrazo) {
      setAvisoPrazoAberto(true)
      return
    }
    enviar()
  }

  const bensPorCategoria = useMemo(() => {
    const map = new Map<string, Patrimonio[]>()
    for (const b of itensBens) {
      const nome = b.categoria?.nome || 'Outros'
      map.set(nome, [...(map.get(nome) || []), b])
    }
    return Array.from(map.entries())
  }, [itensBens])

  return (
    <div className="max-w-3xl space-y-6">
      {/* Stepper */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm p-4 sm:p-5">
        <div className="flex items-start justify-between overflow-x-auto pb-1 gap-1">
          {STEPS.map((label, i) => (
            <div key={label} className="flex items-start flex-1 min-w-[60px]">
              <div className="flex flex-col items-center gap-1 flex-1">
                <div className={cn(
                  'w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 transition',
                  i < step ? 'bg-brand text-white' : i === step ? 'bg-brand text-white ring-2 ring-brand/30 ring-offset-2 ring-offset-white dark:ring-offset-gray-900' : 'bg-gray-100 dark:bg-gray-800 text-gray-400'
                )}>
                  {i < step ? <CheckCircle2 size={16} /> : i + 1}
                </div>
                <span className={cn('text-[10px] sm:text-xs text-center leading-tight', i === step ? 'text-brand font-semibold' : 'text-gray-400')}>
                  {label}
                </span>
              </div>
              {i < STEPS.length - 1 && (
                // Caixa com a mesma altura do círculo (h-8) e centralizada
                // nela, não na coluna inteira (circulo+label) — labels de
                // 1 ou 2 linhas não deslocam mais a linha conectora, que
                // fica sempre alinhada ao centro vertical do círculo.
                <div className="h-8 flex-1 flex items-center mx-1 shrink-0">
                  <div className={cn('h-0.5 w-full', i < step ? 'bg-brand' : 'bg-gray-200 dark:bg-gray-800')} />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm p-5 sm:p-6 space-y-5">
        {/* ETAPA 1 */}
        {step === 0 && (
          <div className="space-y-5 animate-fade-in">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Tipo de empréstimo</label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {(['interno', 'externo'] as TipoEmprestimo[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTipoEmprestimo(t)}
                    className={cn(
                      'flex items-center gap-2 justify-center px-4 py-3 rounded-xl border-2 text-sm font-medium transition',
                      tipoEmprestimo === t ? 'border-brand bg-brand/5 text-brand' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400'
                    )}
                  >
                    {t === 'interno' ? <Building2 size={16} /> : <MapPin size={16} />}
                    {t === 'interno' ? 'Empréstimo Interno' : 'Empréstimo Externo'}
                  </button>
                ))}
              </div>
            </div>

            {/* Segurança (Etapa security/request-for-another): "solicitar para
                outro colaborador" só é oferecido a quem o backend realmente
                autoriza (Gestor, Patrimônio, Administrador) — ver
                podeSolicitarParaOutro(). Colaborador comum nunca vê o
                checkbox, então `paraOutro` nunca sai de `false` para esse
                perfil e o ramo abaixo sempre mostra "Solicitante: {ele
                mesmo}" — nenhum estado residual de um controle escondido. */}
            {user && podeSolicitarParaOutro(user) && (
              <label className="flex items-center gap-3 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={paraOutro}
                  onChange={(e) => { setParaOutro(e.target.checked); setSolicitante(null) }}
                  className="w-4 h-4 rounded accent-highlight"
                />
                <span className="text-sm text-gray-700 dark:text-gray-300">Solicitar para outro colaborador</span>
              </label>
            )}

            {paraOutro ? (
              <div className="space-y-2 animate-fade-in">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Colaborador</label>
                <div className="relative">
                  <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input
                    value={buscaColab}
                    onChange={(e) => { setBuscaColab(e.target.value); setSolicitante(null) }}
                    placeholder="Pesquisar por nome ou e-mail"
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
            ) : (
              <div className="px-4 py-3 bg-gray-50 dark:bg-gray-800 rounded-xl text-sm text-gray-600 dark:text-gray-400">
                Solicitante: <strong className="text-gray-900 dark:text-white">{user?.nome}</strong>
              </div>
            )}
          </div>
        )}

        {/* ETAPA 2 */}
        {step === 1 && (
          <div className="space-y-4 animate-fade-in">
            {tipoEmprestimo === 'interno' ? (
              <>
                <Campo label="Ambiente ou sala" value={ambiente} onChange={setAmbiente} placeholder="Ex.: Sala 05, Laboratório 2" maxLength={150} />
                <Campo label="Finalidade (opcional)" value={finalidade} onChange={setFinalidade} placeholder="Para que será utilizado" maxLength={300} />
              </>
            ) : (
              <>
                <Campo label="Atividade" value={atividadeExterna} onChange={setAtividadeExterna} placeholder="Nome ou descrição da atividade" maxLength={300} />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Campo label="Local" value={local} onChange={setLocal} placeholder="Local do evento" maxLength={150} />
                  <Campo label="Cidade" value={cidade} onChange={setCidade} placeholder="Cidade" maxLength={150} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Gestor responsável</label>
                  <select
                    value={gestorId}
                    onChange={(e) => setGestorId(e.target.value)}
                    className="w-full px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
                  >
                    <option value="">Selecione um gestor</option>
                    {gestores.map((g) => <option key={g.id} value={g.id}>{g.nome}</option>)}
                  </select>
                </div>
                <Campo label="Finalidade (opcional)" value={finalidade} onChange={setFinalidade} placeholder="Finalidade da atividade" maxLength={300} />
              </>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Observações (opcional)</label>
              <textarea
                value={observacoes}
                onChange={(e) => setObservacoes(e.target.value)}
                rows={3}
                maxLength={1000}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
              />
            </div>
          </div>
        )}

        {/* ETAPA 3 */}
        {step === 2 && (
          <div className="space-y-5 animate-fade-in">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Data</label>
              <input
                type="date"
                min={todayISO()}
                value={data}
                onChange={(e) => setData(e.target.value)}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Períodos (selecione um ou mais)</label>
              <div className="grid grid-cols-3 gap-3">
                {(['MANHA', 'TARDE', 'NOITE'] as PeriodoSolicitacao[]).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => togglePeriodo(p)}
                    className={cn(
                      'py-3 rounded-xl border-2 text-sm font-medium transition',
                      periodos.includes(p) ? 'border-highlight bg-highlight/5 text-highlight' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400'
                    )}
                  >
                    {PERIODO_LABELS[p]}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ETAPA 4 */}
        {step === 3 && (
          <div className="space-y-6 animate-fade-in">
            <div>
              <h3 className="font-semibold text-gray-900 dark:text-white mb-3 flex items-center gap-2"><Laptop size={18} className="text-brand" /> Bens Patrimoniais</h3>

              {categoriasErro && (
                <p className="text-sm text-red-600 dark:text-red-400 mb-3">
                  Não foi possível carregar as categorias. Atualize a página e tente novamente.
                </p>
              )}
              {!categoriasCarregando && !categoriasErro && categorias.filter((c) => c.ativo).length === 0 && (
                <p className="text-sm text-gray-500 mb-3">
                  Nenhuma categoria ativa cadastrada no momento. Fale com o administrador do sistema.
                </p>
              )}

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
                  Buscar disponíveis
                </button>
              </div>

              {disponiveis !== null && (
                <div className="border border-gray-200 dark:border-gray-700 rounded-xl p-3 mb-3 max-h-64 overflow-y-auto space-y-1.5">
                  {disponiveis.length === 0 ? (
                    <p className="text-sm text-gray-500 text-center py-4">Nenhum item disponível para essa data/período.</p>
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
                    <button onClick={adicionarSelecionados} disabled={selecaoTemp.size === 0} className="mt-2 w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-highlight/10 text-highlight text-sm font-medium disabled:opacity-40">
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
                      <button onClick={() => removerBem(b.id)} aria-label="Remover item" className="text-red-500 hover:text-red-700"><Trash2 size={14} /></button>
                    </div>
                  ))}
                </div>
              )}

              {temNotebookSelecionado && (
                <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <span id="label-necessita-dominio" className="text-sm font-medium text-gray-700 dark:text-gray-300">Necessita de domínio?</span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={notebooksComDominio}
                      aria-labelledby="label-necessita-dominio"
                      onClick={() => alternarDominio(!notebooksComDominio)}
                      className={cn(
                        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-brand/30 focus:ring-offset-2 dark:focus:ring-offset-gray-900',
                        notebooksComDominio ? 'bg-brand' : 'bg-gray-300 dark:bg-gray-700'
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform motion-reduce:transition-none',
                          notebooksComDominio ? 'translate-x-6' : 'translate-x-1'
                        )}
                      />
                    </button>
                  </div>

                  {notebooksComDominio && (
                    <div>
                      <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Tipo de domínio</p>
                      <div role="radiogroup" aria-label="Tipo de domínio" className="grid grid-cols-2 gap-2">
                        {(['EDUCACIONAL', 'ADMINISTRATIVO'] as TipoDominio[]).map((opcao) => {
                          const selecionado = tipoDominio === opcao
                          return (
                            <button
                              key={opcao}
                              type="button"
                              role="radio"
                              aria-checked={selecionado}
                              onClick={() => setTipoDominio(opcao)}
                              className={cn(
                                'flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl text-sm font-medium border transition focus:outline-none focus:ring-2 focus:ring-brand/30',
                                selecionado
                                  ? 'bg-brand text-white border-brand'
                                  : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 border-gray-200 dark:border-gray-700 hover:border-brand/40'
                              )}
                            >
                              {selecionado && <Check size={14} />}
                              {TIPO_DOMINIO_LABELS[opcao]}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div>
              <h3 className="font-semibold text-gray-900 dark:text-white mb-3 flex items-center gap-2"><Package size={18} className="text-brand" /> Papelaria</h3>
              <div className="flex flex-col sm:flex-row gap-2 mb-3">
                <input
                  value={novoItemDesc}
                  onChange={(e) => setNovoItemDesc(e.target.value)}
                  placeholder="Descrição (ex.: cartolina branca)"
                  maxLength={1500}
                  className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
                />
                <input
                  type="number"
                  min={1}
                  max={1000}
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
                      <button onClick={() => removerPapelaria(idx)} aria-label="Remover item" className="text-red-500 hover:text-red-700"><Trash2 size={14} /></button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <h3 className="font-semibold text-gray-900 dark:text-white mb-3 flex items-center gap-2"><Wrench size={18} className="text-brand" /> Serviços / Movimentações</h3>

              {tiposServicoErro && (
                <p className="text-sm text-red-600 dark:text-red-400 mb-3">
                  Não foi possível carregar os tipos de serviço. Atualize a página e tente novamente.
                </p>
              )}
              {!tiposServicoCarregando && !tiposServicoErro && tiposServico.filter((t) => t.ativo).length === 0 && (
                <p className="text-sm text-gray-500 mb-3">Nenhum tipo de serviço ativo cadastrado no momento.</p>
              )}

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
                    max={1000}
                    placeholder="Quantidade"
                    value={novoServicoQtd}
                    onChange={(e) => setNovoServicoQtd(e.target.value)}
                    className="w-full sm:w-36 px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
                  />
                </div>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    value={novoServicoAmbiente}
                    onChange={(e) => setNovoServicoAmbiente(e.target.value)}
                    placeholder="Ambiente/local"
                    maxLength={150}
                    className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
                  />
                  <input
                    value={novoServicoObs}
                    onChange={(e) => setNovoServicoObs(e.target.value)}
                    placeholder="Observação (opcional)"
                    maxLength={1000}
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
                      <button onClick={() => removerServico(idx)} aria-label="Remover item" className="text-red-500 hover:text-red-700"><Trash2 size={14} /></button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ETAPA 5 — RESUMO */}
        {step === 4 && (
          <div className="space-y-4 animate-fade-in text-sm">
            <ResumoLinha label="Tipo de empréstimo" value={tipoEmprestimo === 'interno' ? 'Interno' : 'Externo'} />
            <ResumoLinha label="Solicitante" value={paraOutro && solicitante ? solicitante.nome : user?.nome || ''} />
            {paraOutro && <ResumoLinha label="Criado por" value={user?.nome || ''} />}
            {tipoEmprestimo === 'interno' ? (
              <>
                <ResumoLinha label="Ambiente" value={ambiente} />
                {finalidade && <ResumoLinha label="Finalidade" value={finalidade} />}
              </>
            ) : (
              <>
                <ResumoLinha label="Atividade" value={atividadeExterna} />
                <ResumoLinha label="Local" value={`${local} — ${cidade}`} />
                <ResumoLinha label="Gestor" value={gestores.find((g) => g.id === gestorId)?.nome || ''} />
                {finalidade && <ResumoLinha label="Finalidade" value={finalidade} />}
              </>
            )}
            {/* `data` (state do <input type="date">, "YYYY-MM-DD") é a mesma DATA CIVIL
                que virará Solicitacao.data ao enviar — formatDataCivil(), não formatDate()
                (achado na busca global da Etapa D.3.FOLLOW-UP 3B: mesmo caso das demais
                telas, mesmo já sendo local→local autoconsistente hoje). */}
            <ResumoLinha label="Data" value={data ? formatDataCivil(data) : ''} />
            <ResumoLinha label="Período(s)" value={formatPeriodos(periodos)} />
            {itensBens.length > 0 && (
              <div className="px-4 py-3 bg-gray-50 dark:bg-gray-800 rounded-xl space-y-2.5">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  Bens patrimoniais <span className="text-gray-400 normal-case">({itensBens.length} {itensBens.length === 1 ? 'item' : 'itens'})</span>
                </p>
                {bensPorCategoria.map(([categoriaNome, itensDaCategoria]) => (
                  <div key={categoriaNome}>
                    <p className="text-xs font-semibold text-brand mb-1">{categoriaNome} ({itensDaCategoria.length})</p>
                    <ul className="space-y-1">
                      {itensDaCategoria.map((b) => (
                        <li key={b.id} className="text-gray-700 dark:text-gray-300 pl-2 border-l-2 border-brand/30">
                          Patrimônio: {b.numero} — {b.marca} {b.modelo}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
            {itensPapelaria.length > 0 && (
              <div className="px-4 py-3 bg-gray-50 dark:bg-gray-800 rounded-xl space-y-1.5">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Papelaria</p>
                <ul className="space-y-1">
                  {itensPapelaria.map((i, idx) => (
                    <li key={idx} className="text-gray-700 dark:text-gray-300">{i.quantidade}x {i.descricao}</li>
                  ))}
                </ul>
              </div>
            )}
            {itensServico.length > 0 && (
              <div className="px-4 py-3 bg-gray-50 dark:bg-gray-800 rounded-xl space-y-1.5">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Serviços / Movimentações</p>
                <ul className="space-y-1">
                  {itensServico.map((i, idx) => (
                    <li key={idx} className="text-gray-700 dark:text-gray-300">
                      {i.tipoServicoNome}
                      {i.quantidade ? ` — ${i.quantidade}` : ''}
                      {i.ambiente ? ` — ${i.ambiente}` : ''}
                      {i.observacao ? ` (${i.observacao})` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {observacoes && <ResumoLinha label="Observações" value={observacoes} />}
          </div>
        )}

        {/* Navegação */}
        <div className="flex justify-between pt-4 border-t border-gray-100 dark:border-gray-800">
          <button
            onClick={() => setStep((s) => Math.max(s - 1, 0))}
            disabled={step === 0}
            className="flex items-center gap-1 px-4 py-2.5 rounded-xl text-sm font-medium text-gray-600 dark:text-gray-400 disabled:opacity-30"
          >
            <ChevronLeft size={16} /> Voltar
          </button>
          {step < STEPS.length - 1 ? (
            <button
              onClick={avancar}
              disabled={step === 3 && itensBens.length === 0 && itensPapelaria.length === 0 && itensServico.length === 0}
              className="flex items-center gap-1 px-5 py-2.5 rounded-xl text-sm font-medium bg-brand text-white disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Avançar <ChevronRight size={16} />
            </button>
          ) : (
            <button
              onClick={handleClickEnviar}
              disabled={enviando}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold bg-brand hover:bg-brand-dark text-white disabled:opacity-60 shadow-md hover:shadow-lg hover:-translate-y-0.5 transition-all"
            >
              {enviando ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
              {enviando ? 'Enviando...' : 'Enviar solicitação'}
            </button>
          )}
        </div>
      </div>

      {avisoPrazoAberto && prazoInfo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setAvisoPrazoAberto(false)} />
          <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl p-6 w-full max-w-md space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-950 flex items-center justify-center shrink-0">
                <AlertTriangle size={20} className="text-amber-600" />
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 dark:text-white">Solicitação fora do prazo recomendado</h3>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-2">
                  Solicitações {tipoEmprestimo === 'interno' ? 'internas' : 'externas'} devem ser realizadas com pelo menos{' '}
                  <strong>{prazoInfo.prazoHoras} horas</strong> de antecedência.
                </p>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-2">
                  Esta solicitação está sendo realizada com apenas <strong>{formatarAntecedencia(prazoInfo.antecedenciaMinutos)}</strong> de antecedência.
                </p>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-2">
                  Isso poderá impactar o tempo disponível para organização, disponibilidade e separação dos itens pelo Patrimônio.
                </p>
                <p className="text-sm font-medium text-gray-800 dark:text-gray-200 mt-3">Deseja continuar mesmo assim?</p>
              </div>
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button onClick={() => setAvisoPrazoAberto(false)} className="px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-sm font-medium">
                Voltar e alterar
              </button>
              <button
                onClick={() => { setAvisoPrazoAberto(false); enviar() }}
                disabled={enviando}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-600 text-white text-sm font-medium disabled:opacity-60"
              >
                {enviando ? <Loader2 size={14} className="animate-spin" /> : null} Continuar mesmo assim
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Campo({ label, value, onChange, placeholder, maxLength }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; maxLength?: number }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        className="w-full px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
      />
    </div>
  )
}

function ResumoLinha({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3 px-4 py-2.5 bg-gray-50 dark:bg-gray-800 rounded-xl">
      <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide sm:w-40 shrink-0">{label}</span>
      <span className="text-gray-800 dark:text-gray-200">{value}</span>
    </div>
  )
}
