// src/app/(dashboard)/aprovacoes/page.tsx
'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { CheckSquare, ChevronRight } from 'lucide-react'
import { Solicitacao, StatusSolicitacao } from '@/types'
import { StatusSolicitacaoBadge } from '@/components/ui/StatusBadge'
import { formatDataCivil, formatPeriodos } from '@/utils'

export default function AprovacoesPage() {
  const [solicitacoes, setSolicitacoes] = useState<Solicitacao[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // O servidor SEMPRE restringe escopo=gestor ao próprio usuário autenticado
    // (gestorId = session.id), nunca confiando em parâmetro vindo do cliente.
    fetch('/api/solicitacoes?escopo=gestor&status=AGUARDANDO_GESTOR')
      .then((r) => r.json())
      .then((d) => setSolicitacoes(d.solicitacoes || []))
      .catch(() => setSolicitacoes([]))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="max-w-4xl space-y-4">
      <p className="text-sm text-gray-500">Solicitações de atividades externas aguardando sua decisão como gestor.</p>

      {loading ? (
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => <div key={i} className="h-[72px] bg-gray-100 dark:bg-gray-800 rounded-2xl animate-pulse" />)}
        </div>
      ) : solicitacoes.length === 0 ? (
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 p-10 text-center text-gray-500">
          <CheckSquare size={40} className="mx-auto mb-3 opacity-30" />
          <p>Nenhuma aprovação pendente.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {solicitacoes.map((s) => (
            <Link key={s.id} href={`/solicitacoes/${s.id}`} className="flex items-center justify-between gap-3 bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm p-4 hover:border-brand/40 transition">
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className="font-semibold text-gray-900 dark:text-white text-sm">#{s.numero}</span>
                  <StatusSolicitacaoBadge status={s.status as StatusSolicitacao} />
                </div>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  {/* s.data é a DATA CIVIL da reserva (@db.Date) — formatDataCivil(), não formatDate() (ver Etapa D.3.FOLLOW-UP). */}
                  {s.solicitante?.nome} • {s.atividadeExterna} • {formatDataCivil(s.data)} • {formatPeriodos(s.periodos)}
                </p>
              </div>
              <ChevronRight size={18} className="text-gray-300 shrink-0" />
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
