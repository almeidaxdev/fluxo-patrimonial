// src/app/(dashboard)/minha-conta/page.tsx
'use client'

import { User, Mail, ShieldCheck, CalendarDays } from 'lucide-react'
import { useSession } from '@/hooks/use-session'
import { PERMISSAO_LABELS } from '@/types'
import { formatDate } from '@/utils'

export default function MinhaContaPage() {
  const { user, loading } = useSession()

  if (loading) {
    return (
      <div className="max-w-lg space-y-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-16 bg-gray-100 dark:bg-gray-800 rounded-2xl animate-pulse" />
        ))}
      </div>
    )
  }

  if (!user) return null

  const fields = [
    {
      icon: <User size={18} className="text-brand" />,
      label: 'Nome completo',
      value: user.nome,
    },
    {
      icon: <Mail size={18} className="text-brand" />,
      label: 'E-mail',
      value: user.email,
    },
    {
      icon: <ShieldCheck size={18} className="text-brand" />,
      label: 'Permissão',
      value: PERMISSAO_LABELS[user.permissao],
    },
  ]

  return (
    <div className="max-w-lg space-y-6">
      {/* Avatar + nome */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm p-6 flex items-center gap-5">
        <div className="w-16 h-16 rounded-2xl bg-brand/10 dark:bg-brand/20 flex items-center justify-center shrink-0">
          <span className="text-brand dark:text-blue-400 font-bold text-2xl">
            {user.nome[0]?.toUpperCase()}
          </span>
        </div>
        <div>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">{user.nome}</h2>
          <span className="inline-flex items-center gap-1.5 mt-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-highlight/10 text-highlight border border-highlight/20">
            <ShieldCheck size={11} />
            {PERMISSAO_LABELS[user.permissao]}
          </span>
        </div>
      </div>

      {/* Dados */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm divide-y divide-gray-100 dark:divide-gray-800">
        {fields.map((field) => (
          <div key={field.label} className="flex items-center gap-4 px-6 py-4">
            <div className="w-9 h-9 rounded-xl bg-gray-50 dark:bg-gray-800 flex items-center justify-center shrink-0">
              {field.icon}
            </div>
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400">{field.label}</p>
              <p className="text-sm font-medium text-gray-900 dark:text-white mt-0.5">{field.value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Info */}
      <p className="text-xs text-gray-400 dark:text-gray-500 text-center">
        Para alterar seus dados, entre em contato com o administrador do sistema.
      </p>
    </div>
  )
}
