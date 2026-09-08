// src/components/ui/ConfirmDialog.tsx
'use client'

import { AlertTriangle, Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'

interface ConfirmDialogProps {
  open: boolean
  title: string
  description: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  variant?: 'danger' | 'warning'
  loading?: boolean
  // Oculta o botão de cancelar — usado por diálogos de "acknowledge" (ex.:
  // exibir uma senha temporária uma única vez), onde só existe uma ação
  // possível ("Fechar") e ter dois botões redundantes confundiria mais do
  // que ajudaria.
  hideCancel?: boolean
  /**
   * Etapa feat/idle-session-timeout: quando `true`, clicar no backdrop NÃO
   * fecha o diálogo (nem chama `onCancel`) — exige um clique explícito num
   * dos dois botões. Usado pelo aviso de inatividade, onde `onCancel` é uma
   * ação com consequência real ("Sair agora"): um clique acidental fora do
   * modal nunca pode encerrar a sessão por engano. Default `false` —
   * comportamento de todo outro uso deste componente é preservado
   * integralmente.
   */
  disableBackdropClose?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  open, title, description, confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar', variant = 'danger', loading, hideCancel, disableBackdropClose, onConfirm, onCancel,
}: ConfirmDialogProps) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={disableBackdropClose ? undefined : onCancel} />
      <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 p-6 w-full max-w-md animate-fade-in">
        <div className="flex items-start gap-4">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${variant === 'danger' ? 'bg-red-100 dark:bg-red-950' : 'bg-yellow-100 dark:bg-yellow-950'}`}>
            <AlertTriangle size={20} className={variant === 'danger' ? 'text-red-600' : 'text-yellow-600'} />
          </div>
          <div>
            <h3 className="font-semibold text-gray-900 dark:text-white">{title}</h3>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{description}</p>
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-3">
          {!hideCancel && (
            <button
              onClick={onCancel}
              className="px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition"
            >
              {cancelLabel}
            </button>
          )}
          <button
            onClick={onConfirm}
            disabled={loading}
            className={`px-4 py-2 rounded-lg text-sm font-medium text-white flex items-center gap-2 transition disabled:opacity-60 ${variant === 'danger' ? 'bg-red-600 hover:bg-red-700' : 'bg-yellow-600 hover:bg-yellow-700'}`}
          >
            {loading && <Loader2 size={14} className="animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
