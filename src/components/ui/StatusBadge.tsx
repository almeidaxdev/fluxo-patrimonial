// src/components/ui/StatusBadge.tsx
import { StatusSolicitacao, STATUS_SOLICITACAO_LABELS, STATUS_SOLICITACAO_COLORS } from '@/types'
import { cn } from '@/utils'

export function StatusSolicitacaoBadge({ status }: { status: StatusSolicitacao }) {
  return (
    <span className={cn('inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold border whitespace-nowrap', STATUS_SOLICITACAO_COLORS[status])}>
      {STATUS_SOLICITACAO_LABELS[status]}
    </span>
  )
}
