// src/components/ui/Wordmark.tsx
// Identidade textual do produto — v1 é só tipografia, sem logo/ícone (decisão
// deliberada: evita depender de um asset de imagem e mantém a marca fácil de
// versionar/alterar). "inverted" é usado sobre o fundo escuro da Sidebar/tela
// de autenticação; o padrão é para fundos claros (cards brancos).
import { cn } from '@/utils'

interface WordmarkProps {
  className?: string
  variant?: 'default' | 'inverted'
}

export function Wordmark({ className, variant = 'default' }: WordmarkProps) {
  return (
    <span className={cn('inline-flex items-baseline gap-1.5 font-bold tracking-tight', className)}>
      <span className={variant === 'inverted' ? 'text-highlight-light' : 'text-brand'}>Fluxo</span>
      <span className={cn('font-semibold', variant === 'inverted' ? 'text-white' : 'text-gray-900')}>
        Patrimonial
      </span>
    </span>
  )
}
