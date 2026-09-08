// src/components/ui/toaster.tsx
'use client'

import { useEffect, useState } from 'react'
import { CheckCircle2, XCircle, X } from 'lucide-react'
import { Toast, useToastState } from '@/hooks/use-toast'
import { cn } from '@/utils'

function ToastItem({ toast }: { toast: Toast }) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true))
  }, [])

  const isError = toast.variant === 'destructive'
  const isSuccess = toast.variant === 'success'

  return (
    <div className={cn(
      'flex items-start gap-3 p-4 rounded-xl shadow-lg border max-w-sm w-full transition-all duration-300',
      visible ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-full',
      isError ? 'bg-red-50 border-red-200 dark:bg-red-950 dark:border-red-800' :
      isSuccess ? 'bg-green-50 border-green-200 dark:bg-green-950 dark:border-green-800' :
      'bg-white border-gray-200 dark:bg-gray-900 dark:border-gray-700'
    )}>
      <div className="shrink-0 mt-0.5">
        {isError ? <XCircle size={18} className="text-red-500" /> : <CheckCircle2 size={18} className="text-green-500" />}
      </div>
      <div className="flex-1 min-w-0">
        {toast.title && <p className={cn('font-semibold text-sm', isError ? 'text-red-800 dark:text-red-200' : 'text-gray-900 dark:text-gray-100')}>{toast.title}</p>}
        {toast.description && <p className={cn('text-sm mt-0.5', isError ? 'text-red-600 dark:text-red-300' : 'text-gray-600 dark:text-gray-400')}>{toast.description}</p>}
      </div>
    </div>
  )
}

export function Toaster() {
  const toasts = useToastState()

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2">
      {toasts.map((t) => <ToastItem key={t.id} toast={t} />)}
    </div>
  )
}
