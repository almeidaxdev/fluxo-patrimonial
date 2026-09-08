// src/app/(dashboard)/lobby/OperacaoPatrimonio.tsx
'use client'

// Etapa feat/admin-dashboard-operational — seção operacional do Patrimônio,
// EXTRAÍDA de PainelPatrimonio.tsx para ser COMPARTILHADA entre:
//   - Painel do Patrimônio (perfil PATRIMONIO, página inteira — ver
//     PainelPatrimonio.tsx, agora um wrapper fino em torno deste componente);
//   - Dashboard do Administrador (seção "Operação do Patrimônio", dentro de
//     uma página maior que também tem conteúdo pessoal — ver lobby/page.tsx).
//
// Nunca duas definições de "o que precisa de atenção do Patrimônio": cards,
// mapeamento card→filtro, contador de atenção (`calcularTotalAtencaoPatrimonio`),
// inventário e "Prioridades de hoje" vivem SÓ AQUI. Cada chamador só decide
// o título/saudação ao REDOR desta seção (estilo de página inteira vs.
// subseção) — nada operacional é duplicado.
//
// Dados: ZERO endpoint novo (herdado de PainelPatrimonio.tsx).
//   - KPIs (`stats`): mesmo `GET /api/dashboard` que o Dashboard pessoal já
//     busca — o branch `patrimonio` da rota já existia.
//   - "Prioridades de hoje": mesmo `GET /api/solicitacoes?escopo=todas` já
//     usado por Pendências/Todas as Solicitações, só com o filtro `data`
//     (já existente) fixado em hoje.
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  AlertCircle, FileSignature, PackageCheck, Undo2, HardDrive, AlarmClockOff,
  ChevronRight, Search, ScissorsLineDashed,
} from 'lucide-react'
import { StatCard } from '@/components/ui/StatCard'
import { StatusSolicitacaoBadge } from '@/components/ui/StatusBadge'
import { STATUS_PENDENCIA_PATRIMONIO } from '@/lib/status'
import { type PatrimonioStats, calcularTotalAtencaoPatrimonio } from '@/lib/patrimonio-dashboard'
import { StatusSolicitacao, PeriodoSolicitacao, TipoEmprestimo } from '@/types'
import { cn, formatDataCivil, formatPeriodos, todayISO, PERIODOS_ORDENADOS } from '@/utils'

// Reexportados por conveniência — PainelPatrimonio.tsx e lobby/page.tsx já
// importavam os dois daqui; a fonte real agora é src/lib/patrimonio-dashboard.ts
// (módulo sem JSX, testável diretamente por scripts/*.ts — ver
// scripts/test-admin-dashboard-operational.ts).
export type { PatrimonioStats }
export { calcularTotalAtencaoPatrimonio }

interface ItemHoje {
  id: string
  numero: number
  tipoEmprestimo: TipoEmprestimo
  origem?: 'RESERVA' | 'ATENDIMENTO_IMEDIATO'
  status: StatusSolicitacao
  data: string
  periodos: PeriodoSolicitacao[]
  atividadeExterna?: string | null
  solicitante?: { nome: string } | null
}

// Ação principal por status — sempre um LINK para a solicitação real (nunca
// um botão que muda status por aqui): o painel é um atalho para a operação
// já existente em /solicitacoes/[id], não uma segunda forma de mutar
// workflow. Status ausentes daqui (ex.: AGUARDANDO_GESTOR, nunca aparece
// para Patrimônio — ver STATUS_PENDENCIA_PATRIMONIO) caem no fallback.
const ACAO_POR_STATUS: Partial<Record<StatusSolicitacao, string>> = {
  AGUARDANDO_PATRIMONIO: 'Analisar',
  AGUARDANDO_ENVIO_ASSINATURA: 'Enviar assinatura',
  ASSINATURA_CONFIRMADA: 'Separar',
  EM_SEPARACAO: 'Marcar pronta',
  PRONTA_RETIRADA: 'Registrar retirada',
  EM_UTILIZACAO: 'Registrar devolução',
}

const ICONE_POR_STATUS: Partial<Record<StatusSolicitacao, React.ReactNode>> = {
  AGUARDANDO_PATRIMONIO: <AlertCircle size={16} className="text-red-500" />,
  AGUARDANDO_ENVIO_ASSINATURA: <FileSignature size={16} className="text-orange-500" />,
  ASSINATURA_CONFIRMADA: <ScissorsLineDashed size={16} className="text-purple-500" />,
  EM_SEPARACAO: <ScissorsLineDashed size={16} className="text-purple-500" />,
  PRONTA_RETIRADA: <PackageCheck size={16} className="text-purple-500" />,
  EM_UTILIZACAO: <Undo2 size={16} className="text-emerald-500" />,
}

/** Primeiro período (ordem Manhã→Tarde→Noite) entre os da solicitação — usado só para agrupar a agenda de hoje, nunca altera os períodos exibidos. */
function primeiroPeriodo(periodos: PeriodoSolicitacao[]): PeriodoSolicitacao {
  return PERIODOS_ORDENADOS.find((p) => periodos.includes(p)) ?? periodos[0]
}

export function OperacaoPatrimonio({ stats }: { stats: PatrimonioStats | null }) {
  const [itensHoje, setItensHoje] = useState<ItemHoje[] | null>(null)
  const [erroHoje, setErroHoje] = useState(false)

  useEffect(() => {
    const params = new URLSearchParams({ escopo: 'todas', data: todayISO(), limit: '100' })
    fetch(`/api/solicitacoes?${params}`)
      .then((r) => {
        if (!r.ok) throw new Error('Falha ao carregar')
        return r.json()
      })
      .then((d) => setItensHoje((d.solicitacoes || []) as ItemHoje[]))
      .catch(() => setErroHoje(true))
  }, [])

  const prioridadesPorPeriodo = useMemo(() => {
    if (!itensHoje) return null
    const acionaveis = itensHoje.filter((s) => STATUS_PENDENCIA_PATRIMONIO.includes(s.status))
    const grupos = new Map<PeriodoSolicitacao, ItemHoje[]>()
    for (const periodo of PERIODOS_ORDENADOS) grupos.set(periodo, [])
    for (const item of acionaveis) {
      const periodo = primeiroPeriodo(item.periodos)
      grupos.get(periodo)?.push(item)
    }
    for (const lista of grupos.values()) lista.sort((a, b) => a.numero - b.numero)
    return grupos
  }, [itensHoje])

  const totalHoje = useMemo(
    () => (prioridadesPorPeriodo ? Array.from(prioridadesPorPeriodo.values()).reduce((acc, l) => acc + l.length, 0) : 0),
    [prioridadesPorPeriodo]
  )

  return (
    <div className="space-y-6">
      {/* CARDS — só métricas que já existem e que levam a uma ação real.
          Cada card abre Todas as Solicitações já filtrada pelo status
          correspondente (mesma infraestrutura de filtro que a tela já tem —
          `status` na query string, lido e aplicado de verdade por lá —
          nunca uma listagem paralela). */}
      {!stats ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
          {[...Array(5)].map((_, i) => <div key={i} className="h-32 bg-gray-100 dark:bg-gray-800 rounded-2xl animate-pulse" />)}
        </div>
      ) : (
        <div>
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Precisa de atenção</h3>
          {/* Grade responsiva: 1 coluna no celular, 2 no tablet, 3 no
              notebook (3+2, sem sobra estranha), 5 numa linha só a partir de
              telas de desktop largas (xl, 1280px+) — onde já cabem
              confortavelmente sem espremer o label. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
            <StatCard icon={<AlertCircle size={22} className="text-red-600" />} label="Aguardando análise" value={stats.aguardandoAnalise} color="bg-red-50 dark:bg-red-950" href="/todas-solicitacoes?status=AGUARDANDO_PATRIMONIO" actionLabel="Ver solicitações" />
            <StatCard icon={<ScissorsLineDashed size={22} className="text-purple-600" />} label="Em separação" value={stats.emSeparacao} color="bg-purple-50 dark:bg-purple-950" href="/todas-solicitacoes?status=EM_SEPARACAO" actionLabel="Ver solicitações" />
            <StatCard icon={<PackageCheck size={22} className="text-blue-600" />} label="Prontas para retirada" value={stats.prontasRetirada} color="bg-blue-50 dark:bg-blue-950" href="/todas-solicitacoes?status=PRONTA_RETIRADA" actionLabel="Ver solicitações" />
            <StatCard icon={<Undo2 size={22} className="text-emerald-600" />} label="Em utilização" caption="Aguardando devolução" value={stats.emUtilizacao} color="bg-emerald-50 dark:bg-emerald-950" href="/todas-solicitacoes?status=EM_UTILIZACAO" actionLabel="Ver solicitações" />
            <StatCard icon={<AlarmClockOff size={22} className="text-amber-600" />} label="Não retiradas" caption="Precisam de atenção" value={stats.naoRetiradas} color="bg-amber-50 dark:bg-amber-950" href="/todas-solicitacoes?status=NAO_RETIRADA" actionLabel="Ver solicitações" />
          </div>
        </div>
      )}

      {/* Inventário — deliberadamente FORA do grid de "Precisa de atenção"
          acima: "Bens ativos" não é um status de solicitação, é uma
          referência de catálogo — uma faixa compacta de UMA linha (sem cor
          de alerta, ícone neutro) evita que seja lido como mais uma
          pendência operacional e ocupa o mínimo de espaço necessário.
          Continua indo para Bens Patrimoniais, único lugar onde esse número
          é acionável de verdade. */}
      {stats && (
        <Link
          href="/patrimonios"
          className="group flex items-center gap-2.5 w-fit bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 shadow-sm px-3.5 py-2 hover:border-brand/20 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900"
        >
          <HardDrive size={15} className="text-gray-400 shrink-0" />
          <span className="text-xs text-gray-500 dark:text-gray-400">Inventário:</span>
          <span className="text-xs font-semibold text-gray-900 dark:text-white">{stats.bensAtivos}/{stats.bensTotal} bens ativos</span>
          <ChevronRight size={14} className="text-gray-300 shrink-0 transition-transform group-hover:translate-x-0.5" />
        </Link>
      )}

      {/* PRIORIDADES DE HOJE — agenda do dia, agrupada por período, com a
          ação principal de cada item. Objetivo: reduzir cliques — o usuário
          não precisa abrir Pendências e procurar a reserva certa entre
          várias seções por status; aqui já está filtrado para HOJE. */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 p-5 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-gray-900 dark:text-white">Prioridades de hoje</h3>
            {totalHoje > 0 && (
              <span className="inline-flex items-center justify-center min-w-[22px] h-5 px-1.5 rounded-full bg-highlight/10 text-highlight text-xs font-bold">{totalHoje}</span>
            )}
          </div>
          {/* Agenda de HOJE não é o backlog inteiro — este link leva para a
              tela que já mostra TODAS as pendências (qualquer data,
              agrupadas por etapa), sem duplicar nada daquela tela aqui. */}
          <Link href="/pendencias" className="text-sm text-brand dark:text-blue-400 hover:underline shrink-0">Ver todas as pendências</Link>
        </div>

        {erroHoje ? (
          <p className="text-sm text-gray-400 py-6 text-center">Não foi possível carregar a agenda de hoje. Atualize a página.</p>
        ) : !prioridadesPorPeriodo ? (
          <div className="space-y-2">
            {[...Array(3)].map((_, i) => <div key={i} className="h-14 bg-gray-50 dark:bg-gray-800 rounded-xl animate-pulse" />)}
          </div>
        ) : totalHoje === 0 ? (
          <div className="text-center py-10">
            <Search size={28} className="mx-auto text-gray-300 dark:text-gray-700 mb-2" />
            <p className="text-sm text-gray-400">Nenhuma reserva exige atenção hoje.</p>
          </div>
        ) : (
          <div className="space-y-5">
            {PERIODOS_ORDENADOS.map((periodo) => {
              const itens = prioridadesPorPeriodo.get(periodo) ?? []
              if (itens.length === 0) return null
              return (
                <div key={periodo}>
                  <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{formatPeriodos([periodo])}</h4>
                  <div className="space-y-2">
                    {itens.map((item) => (
                      <Link
                        key={item.id}
                        href={`/solicitacoes/${item.id}`}
                        className="flex items-center justify-between gap-3 bg-gray-50 dark:bg-gray-800/60 rounded-xl border border-transparent hover:border-brand/30 hover:bg-white dark:hover:bg-gray-800 transition p-3"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="shrink-0">{ICONE_POR_STATUS[item.status] ?? <PackageCheck size={16} className="text-gray-400" />}</span>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-semibold text-gray-900 dark:text-white text-sm">#{item.numero}</span>
                              <span className="text-sm text-gray-600 dark:text-gray-300 truncate">{item.solicitante?.nome ?? '—'}</span>
                              {item.tipoEmprestimo === 'externo' && (
                                <span className="text-[11px] font-medium px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400">Externa</span>
                              )}
                              {item.origem === 'ATENDIMENTO_IMEDIATO' && (
                                <span className="text-[11px] font-medium px-1.5 py-0.5 rounded bg-yellow-50 dark:bg-yellow-950 text-yellow-700 dark:text-yellow-400">Atendimento imediato</span>
                              )}
                            </div>
                            <p className="text-xs text-gray-400 mt-0.5">{formatDataCivil(item.data)} • {formatPeriodos(item.periodos)}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <StatusSolicitacaoBadge status={item.status} />
                          <span className={cn('hidden sm:inline text-xs font-semibold text-brand dark:text-blue-400 whitespace-nowrap')}>
                            {ACAO_POR_STATUS[item.status] ?? 'Ver reserva'}
                          </span>
                          <ChevronRight size={16} className="text-gray-300 shrink-0" />
                        </div>
                      </Link>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
