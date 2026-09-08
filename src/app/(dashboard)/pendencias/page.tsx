// src/app/(dashboard)/pendencias/page.tsx
'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { Solicitacao, StatusSolicitacao, STATUS_SOLICITACAO_LABELS } from '@/types'
import { StatusSolicitacaoBadge } from '@/components/ui/StatusBadge'
import { formatDataCivil, formatPeriodos } from '@/utils'

const SECOES: { titulo: string; status: StatusSolicitacao[] }[] = [
  { titulo: 'Aguardando análise', status: ['AGUARDANDO_PATRIMONIO'] },
  { titulo: 'Aguardando envio da assinatura', status: ['AGUARDANDO_ENVIO_ASSINATURA'] },
  { titulo: 'Aguardando assinatura', status: ['AGUARDANDO_ASSINATURA'] },
  // ASSINATURA_CONFIRMADA (Etapa D.3.FOLLOW-UP — correção de visibilidade
  // operacional): o fluxo documental da reserva externa já terminou, mas a
  // separação ainda não começou — seção própria, distinta de "Em separação"
  // (EM_SEPARACAO), para não sugerir que a separação já está em andamento.
  // Nenhuma transição de status foi alterada; ASSINATURA_CONFIRMADA
  // continua um estado persistido próprio (ver src/lib/status.ts).
  { titulo: 'Aguardando separação', status: ['ASSINATURA_CONFIRMADA'] },
  { titulo: 'Em separação', status: ['EM_SEPARACAO'] },
  { titulo: 'Prontas para retirada', status: ['PRONTA_RETIRADA'] },
  { titulo: 'Em utilização (aguardando devolução)', status: ['EM_UTILIZACAO'] },
]

export default function PendenciasPage() {
  const [solicitacoes, setSolicitacoes] = useState<Solicitacao[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/solicitacoes?escopo=todas&limit=200')
      .then((r) => r.json())
      .then((d) => setSolicitacoes(d.solicitacoes || []))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="text-center py-16 text-gray-400">Carregando...</div>

  return (
    <div className="space-y-8">
      {SECOES.map((secao) => {
        const itens = solicitacoes.filter((s) => secao.status.includes(s.status as StatusSolicitacao))
        return (
          <div key={secao.titulo}>
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-2">
              {secao.titulo}
              <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-highlight/10 text-highlight text-xs font-bold">{itens.length}</span>
            </h3>
            {itens.length === 0 ? (
              <p className="text-xs text-gray-400 px-1">Nenhuma solicitação nesta etapa.</p>
            ) : (
              <div className="space-y-2">
                {itens.map((s) => (
                  <Link key={s.id} href={`/solicitacoes/${s.id}`} className="flex items-center justify-between gap-3 bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-sm p-3 hover:border-brand/40 transition">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                        <span className="font-semibold text-gray-900 dark:text-white text-sm">#{s.numero}</span>
                        <StatusSolicitacaoBadge status={s.status as StatusSolicitacao} />
                      </div>
                      {/* s.data é a DATA CIVIL da reserva (@db.Date) — formatDataCivil(), não formatDate() (ver Etapa D.3.FOLLOW-UP). */}
                      <p className="text-xs text-gray-500">{s.solicitante?.nome} • {formatDataCivil(s.data)} • {formatPeriodos(s.periodos)}</p>
                    </div>
                    <ChevronRight size={16} className="text-gray-300 shrink-0" />
                  </Link>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
