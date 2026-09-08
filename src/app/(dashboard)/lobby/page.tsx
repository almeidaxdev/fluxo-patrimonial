// src/app/(dashboard)/lobby/page.tsx
'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Clock, CheckCircle2, FileSignature, PackageCheck,
  FilePlus2, ChevronRight
} from 'lucide-react'
import { useSession } from '@/hooks/use-session'
import { StatusSolicitacao } from '@/types'
import { StatusSolicitacaoBadge } from '@/components/ui/StatusBadge'
import { StatCard } from '@/components/ui/StatCard'
import { cn, formatDataCivil, formatDateFull } from '@/utils'
import { PainelPatrimonio } from './PainelPatrimonio'
import { calcularTotalAtencaoPatrimonio, OperacaoPatrimonio, type PatrimonioStats } from './OperacaoPatrimonio'
import { FILTRO_EM_ANDAMENTO } from '../minhas-solicitacoes/filtros'

interface RecenteSolicitacao {
  id: string
  numero: number
  status: StatusSolicitacao
  data: string
  tipoEmprestimo: string
}

interface DashboardPayload {
  minhasPendentes: number
  minhasAssinaturaPendente: number
  minhasProntas: number
  minhasRecentes: RecenteSolicitacao[]
  aprovacoesPendentes?: number
  patrimonio?: PatrimonioStats
}

export default function LobbyPage() {
  const { user } = useSession()
  const [stats, setStats] = useState<DashboardPayload | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/dashboard').then((r) => r.json()).then(setStats).finally(() => setLoading(false))
  }, [])

  // `capitalize` (Tailwind) aplica text-transform a CADA PALAVRA
  // ("Sexta-Feira, 21 De Agosto De 2026"), não só à primeira letra da
  // frase. formatDateFull()/date-fns com locale ptBR já devolve tudo em
  // minúsculas por padrão — capitalizamos manualmente só o primeiro
  // caractere, sem tocar em formatDateFull()/lógica de data.
  const todayRaw = formatDateFull(new Date())
  const today = todayRaw.charAt(0).toUpperCase() + todayRaw.slice(1)

  // Etapa feat/patrimonio-operational-ux: mesmo destino (/lobby) para todos
  // os perfis, mas quem é EXCLUSIVAMENTE Patrimônio (nunca Administrador —
  // este continua vendo o dashboard misto abaixo, inalterado) nunca deveria
  // "cair" num dashboard pessoal de colaborador para só depois navegar até
  // a operação real. Early return DEPOIS dos hooks acima (useSession/
  // useState/useEffect já rodaram — Rules of Hooks), então o mesmo
  // `fetch('/api/dashboard')` já em andamento serve às duas telas, sem
  // round-trip duplicado.
  if (user && user.permissao === 'patrimonio') {
    return <PainelPatrimonio nome={user.nome} stats={stats?.patrimonio ?? null} />
  }

  // Resumo do colaborador (Dashboard, revisão definitiva — itens 2/3): a
  // antiga faixa horizontal isolada "Atividades externas aguardando sua
  // aprovação" foi ELIMINADA — a métrica agora é um StatCard normal,
  // dentro do MESMO grid dos demais 4 cards (título curto "Atividades
  // externas" + legenda "Aguardando sua aprovação", valor tratado como
  // métrica comum, nunca como badge). A lista é montada condicionalmente
  // (só existe para quem tem `aprovacoesPendentes`, ver /api/dashboard),
  // então o grid absorve 4 ou 5 cards igualmente — um 5º card sozinho na
  // última linha (em breakpoints menores) é um padrão visual normal, bem
  // diferente do problema anterior (2 de 4 colunas vazias).
  // Etapa feat/admin-dashboard-operational (homologação): todo card que
  // representa uma quantidade agora abre a listagem pessoal JÁ FILTRADA
  // pela MESMA regra usada no contador — nunca a lista inteira sem filtro.
  // "Minhas solicitações em andamento" agrupa vários status (ver
  // STATUS_EM_ANDAMENTO_SOLICITANTE em src/lib/status.ts) — usa o preset
  // semântico `FILTRO_EM_ANDAMENTO` (mesmo sentinela que
  // minhas-solicitacoes/page.tsx reconhece); "Assinaturas pendentes" é
  // SEMPRE `AGUARDANDO_ASSINATURA` do próprio solicitante (nunca confundir
  // com `AGUARDANDO_ENVIO_ASSINATURA`, que é o Patrimônio quem precisa
  // agir — ver GET /api/dashboard, campo `minhasAssinaturaPendente`);
  // "Prontas para retirada" é `PRONTA_RETIRADA`. "Atividades externas" já
  // abre /aprovacoes, que por si só só mostra exatamente as pendências do
  // gestor autenticado (escopo=gestor&status=AGUARDANDO_GESTOR,
  // hardcoded na própria rota) — nenhum filtro adicional necessário.
  const resumo = [
    { key: 'pendentes', icon: <Clock size={22} className="text-yellow-600" />, label: 'Minhas solicitações em andamento', value: stats?.minhasPendentes ?? 0, color: 'bg-yellow-50 dark:bg-yellow-950', href: `/minhas-solicitacoes?status=${FILTRO_EM_ANDAMENTO}`, actionLabel: 'Ver solicitações' },
    { key: 'assinaturas', icon: <FileSignature size={22} className="text-orange-600" />, label: 'Assinaturas pendentes', value: stats?.minhasAssinaturaPendente ?? 0, color: 'bg-orange-50 dark:bg-orange-950', href: '/minhas-solicitacoes?status=AGUARDANDO_ASSINATURA', actionLabel: 'Ver solicitações' },
    { key: 'prontas', icon: <PackageCheck size={22} className="text-emerald-600" />, label: 'Prontas para retirada', value: stats?.minhasProntas ?? 0, color: 'bg-emerald-50 dark:bg-emerald-950', href: '/minhas-solicitacoes?status=PRONTA_RETIRADA', actionLabel: 'Ver solicitações' },
    ...(stats?.aprovacoesPendentes !== undefined
      ? [{
          key: 'aprovacoes',
          icon: <CheckCircle2 size={22} className="text-purple-600" />,
          label: 'Atividades externas',
          caption: 'Aguardando sua aprovação',
          value: stats.aprovacoesPendentes,
          color: 'bg-purple-50 dark:bg-purple-950',
          href: '/aprovacoes',
          actionLabel: 'Ver aprovações',
        }]
      : []),
    { key: 'nova', icon: <FilePlus2 size={22} className="text-blue-600" />, label: 'Nova Solicitação', value: '+', color: 'bg-blue-50 dark:bg-blue-950', href: '/nova-solicitacao' },
  ]
  const temAprovacoes = stats?.aprovacoesPendentes !== undefined

  // Etapa feat/admin-dashboard-operational: o Admin é sempre
  // `isPatrimonioOuAdmin` (src/lib/permissions.ts) — sabemos ANTES do
  // fetch terminar que a seção "Operação do Patrimônio" vai existir para
  // ele, então ela usa o próprio esqueleto de carregamento de
  // `OperacaoPatrimonio` (nunca um segundo padrão de skeleton aqui) em vez
  // de esperar `loading` virar `false`. Colaborador/Gestor NUNCA veem esta
  // seção — `stats.patrimonio` nunca existe para eles (ver GET
  // /api/dashboard), e sem este `if` explícito o componente ficaria preso
  // no skeleton para sempre (não há como distinguir "ainda carregando" de
  // "não se aplica a este perfil" só olhando `stats?.patrimonio`).
  const mostrarOperacaoPatrimonio = user?.permissao === 'administrador'

  return (
    <div className="space-y-8 max-w-screen-2xl">
      <div>
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white tracking-tight">Olá, {user?.nome.split(' ')[0]} 👋</h2>
        <p className="text-gray-500 dark:text-gray-400 text-sm mt-1.5">{today}</p>
      </div>

      {/* SEÇÃO A — Minha atividade (homologação, item 3): tudo que é pessoal
          do Admin como USUÁRIO comum do sistema — nunca removido, nunca
          misturado visualmente com a seção operacional abaixo. */}
      <section className="space-y-4">
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Minha atividade</h3>

        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => <div key={i} className="h-28 bg-gray-100 dark:bg-gray-800 rounded-2xl animate-pulse" />)}
          </div>
        ) : (
          /* Resumo — 4 ou 5 cards (ver comentário acima). xl:grid-cols-5
             só quando o 5º card (aprovações) existe de fato — com 4
             cards, xl:grid-cols-4 evita uma 5ª coluna vazia. */
          <div className={cn('grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4', temAprovacoes ? 'xl:grid-cols-5' : 'xl:grid-cols-4')}>
            {resumo.map(({ key, ...card }) => <StatCard key={key} {...card} />)}
          </div>
        )}

        {/* Solicitações recentes — inalterada nesta rodada (aprovada). */}
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 p-5 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-gray-900 dark:text-white">Minhas solicitações recentes</h3>
            <Link href="/minhas-solicitacoes" className="text-sm text-brand dark:text-blue-400 hover:underline">Ver todas</Link>
          </div>
          {stats?.minhasRecentes && stats.minhasRecentes.length > 0 ? (
            <div className="divide-y divide-gray-100 dark:divide-gray-800">
              {stats.minhasRecentes.map((s) => (
                <Link key={s.id} href={`/solicitacoes/${s.id}`} className="flex items-center justify-between px-3 py-2.5 -mx-3 rounded-xl hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors text-sm">
                  {/* s.data é a DATA CIVIL da reserva (@db.Date) — formatDataCivil(), não formatDate() (ver Etapa D.3.FOLLOW-UP). formatDateFull(new Date()) acima ("hoje") é intencionalmente local — não é Solicitacao.data. */}
                  <span className="text-gray-700 dark:text-gray-300">#{s.numero} — {formatDataCivil(s.data)}</span>
                  <span className="flex items-center gap-2">
                    <StatusSolicitacaoBadge status={s.status} />
                    <ChevronRight size={16} className="text-gray-300 shrink-0" />
                  </span>
                </Link>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-400">Nenhuma solicitação recente.</p>
          )}
        </div>
      </section>

      {/* SEÇÃO B — Operação do Patrimônio (homologação, item 3-6): MESMO
          componente compartilhado do Painel do Patrimônio
          (OperacaoPatrimonio.tsx) — nunca uma segunda implementação dos
          cards/contador/inventário/"Prioridades de hoje". Separador visual
          (borda + espaçamento) deixa claro que a partir daqui é
          acompanhamento operacional, não atividade pessoal do Admin. */}
      {mostrarOperacaoPatrimonio && (
        <section className="space-y-4 pt-2 border-t border-gray-100 dark:border-gray-800">
          <div className="flex items-baseline justify-between flex-wrap gap-2 pt-4">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Operação do Patrimônio</h3>
            {stats?.patrimonio && (
              <p className="text-xs text-gray-400 dark:text-gray-500">
                {(() => {
                  const total = calcularTotalAtencaoPatrimonio(stats.patrimonio)
                  return total > 0 ? `${total} ${total === 1 ? 'item precisa' : 'itens precisam'} de atenção` : 'Nenhuma pendência no momento 🎉'
                })()}
              </p>
            )}
          </div>
          <OperacaoPatrimonio stats={stats?.patrimonio ?? null} />
        </section>
      )}
    </div>
  )
}
