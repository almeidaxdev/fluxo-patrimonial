// src/components/ui/StatCard.tsx
import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/utils'

// Padrão tipográfico ÚNICO do valor (Dashboard — revisão definitiva) — mesmo
// tamanho/peso/line-height/tracking em TODOS os StatCards, sem exceção,
// incluindo valores compostos ("17/17", "13 / 9") e o "+" de Nova Solicitação.
const VALUE_CLASS = 'text-3xl font-bold text-gray-900 dark:text-white tracking-tight leading-none'

/**
 * Estrutura ÚNICA para todo StatCard de métrica — usado pelo Dashboard
 * pessoal (lobby/page.tsx) e pelo Painel do Patrimônio
 * (lobby/PainelPatrimonio.tsx), para nunca divergir a mesma métrica visual
 * em dois lugares (Etapa feat/patrimonio-operational-ux — extraído do
 * lobby, sem alterar nenhum pixel do original).
 *
 * Grid explícito (2 colunas × 3 linhas), com posição de CADA filho fixada
 * por `col-start`/`row-start` — nunca por fluxo/auto-placement relativo ao
 * texto do label:
 *
 *   col 1 (auto)         col 2 (1fr)
 *   ┌──────────────┬──────────────────────┐
 *   │              │ row 1 (2.5rem): label │
 *   │  ícone       ├──────────────────────┤
 *   │ (row-span-3) │ row 2 (2rem):   valor │
 *   │              ├──────────────────────┤
 *   │              │ row 3 (auto):  legenda │ (opcional)
 *   └──────────────┴──────────────────────┘
 *
 * `row 1` tem altura FIXA (2.5rem — cabe até 2 linhas de `text-sm
 * leading-tight`) INDEPENDENTE de o label real ocupar 1 ou 2 linhas
 * (`line-clamp-2` é só uma trava defensiva contra um 3º linha hipotética,
 * nunca usada para alterar texto). `row 2` também é FIXA (2rem) — todo
 * valor cai exatamente na mesma faixa vertical, seja "0", "17/17" ou "+".
 * `row 3` só existe visualmente quando `caption` é passado — nos demais
 * cards fica vazia (0 de altura), sem afetar o alinhamento de linha 1/2.
 *
 * Como os cards de uma mesma seção usam o mesmo grid PAI com `items-stretch`
 * (default do CSS Grid) + `h-full` aqui dentro, todos os cards de uma linha
 * automaticamente ficam com a MESMA altura — mesmo que só um deles tenha
 * `caption` — sem nenhum cálculo manual.
 */
export function StatCard({ icon, label, caption, value, color, href, actionLabel }: {
  icon: React.ReactNode
  label: string
  /** Texto curto opcional abaixo do valor (ex.: "pendente"/"pendentes") — tratado como parte normal do card, nunca como badge/cápsula. */
  caption?: string
  value: number | string
  color: string
  href?: string
  /**
   * Rótulo curto de ação SEMPRE visível (não só no hover) na base do card,
   * ex.: "Ver solicitações" — Etapa feat/patrimonio-operational-ux
   * (homologação visual, item 2): torna explícito que o card inteiro é
   * clicável, sem depender só de hover/sombra para transmitir isso. Opcional
   * e opt-in — cards sem `actionLabel` mantêm o chevron discreto original
   * (só no canto, só ao passar o mouse/focar), comportamento intacto para
   * quem já usava este componente (Dashboard pessoal, painel misto do
   * Administrador).
   */
  actionLabel?: string
}) {
  const content = (
    <div
      className={cn(
        'relative bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm transition-all h-full flex flex-col',
        href && 'hover:shadow-md hover:-translate-y-0.5 hover:border-brand/20'
      )}
    >
      <div className={cn('p-5 grid grid-cols-[auto_1fr] grid-rows-[2.5rem_2rem_auto] gap-x-4', !actionLabel && 'flex-1')}>
        <div className={cn('w-12 h-12 rounded-2xl flex items-center justify-center col-start-1 row-start-1 row-span-3 self-start', color)}>
          {icon}
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-400 leading-tight line-clamp-2 col-start-2 row-start-1">{label}</p>
        <p className={cn(VALUE_CLASS, 'col-start-2 row-start-2 self-center')}>{value}</p>
        {caption && <p className="text-xs text-gray-500 dark:text-gray-400 col-start-2 row-start-3 self-start mt-0.5">{caption}</p>}
        {/* Card inteiro clicável (homologação visual): hover/translate já
            existiam acima; `group-hover`/`group-focus-visible` no chevron e
            o anel de foco no `<Link>` (ver retorno da função) são a mesma
            linguagem de interação já usada no item ativo do Sidebar
            (chevron + leve translate) — nunca um padrão novo, só estendida
            para cá. Só aparece quando NÃO há `actionLabel` (que já traz seu
            próprio chevron, sempre visível, na base do card — nunca dois
            indicadores de ação no mesmo card). */}
        {href && !actionLabel && (
          <ChevronRight
            size={16}
            aria-hidden="true"
            className="absolute top-4 right-4 text-gray-300 dark:text-gray-600 opacity-0 -translate-x-1 transition-all duration-200 group-hover:opacity-100 group-hover:translate-x-0 group-focus-visible:opacity-100 group-focus-visible:translate-x-0"
          />
        )}
      </div>
      {actionLabel && (
        <div className="flex items-center justify-end gap-1 px-5 py-2.5 border-t border-gray-50 dark:border-gray-800/60 text-xs font-medium text-gray-400 dark:text-gray-500 transition-colors group-hover:text-brand group-focus-visible:text-brand dark:group-hover:text-blue-400 dark:group-focus-visible:text-blue-400">
          {actionLabel}
          <ChevronRight size={14} aria-hidden="true" className="transition-transform group-hover:translate-x-0.5" />
        </div>
      )}
    </div>
  )
  if (!href) return content
  return (
    <Link
      href={href}
      className="group block h-full rounded-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900"
    >
      {content}
    </Link>
  )
}
