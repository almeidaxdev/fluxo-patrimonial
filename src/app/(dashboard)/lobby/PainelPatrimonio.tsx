// src/app/(dashboard)/lobby/PainelPatrimonio.tsx
'use client'

// Etapa feat/patrimonio-operational-ux — painel operacional exclusivo do
// perfil PATRIMONIO (nunca renderizado para Administrador, que usa a MESMA
// seção operacional dentro do próprio Dashboard misto — ver
// lobby/page.tsx e OperacaoPatrimonio.tsx, Etapa feat/admin-dashboard-operational).
//
// Este arquivo é agora um wrapper FINO: toda a parte operacional real
// (cards, contador de atenção, inventário, "Prioridades de hoje") vive em
// `OperacaoPatrimonio.tsx`, a ÚNICA fonte de verdade — nunca duas
// implementações da mesma regra "o que precisa de atenção do Patrimônio".
// Aqui só decidimos o TÍTULO de página inteira + a saudação pessoal, que só
// fazem sentido para quem é EXCLUSIVAMENTE Patrimônio (o Admin já tem sua
// própria saudação pessoal no topo do Dashboard misto).
import { calcularTotalAtencaoPatrimonio, OperacaoPatrimonio, type PatrimonioStats } from './OperacaoPatrimonio'

export type { PatrimonioStats }

export function PainelPatrimonio({ nome, stats }: { nome: string; stats: PatrimonioStats | null }) {
  const totalAtencao = stats ? calcularTotalAtencaoPatrimonio(stats) : 0

  return (
    <div className="space-y-6 max-w-screen-2xl">
      {/* TOPO — contexto operacional curto, sem saudação genérica de colaborador. */}
      <div>
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white tracking-tight">Painel do Patrimônio</h2>
        <p className="text-gray-500 dark:text-gray-400 text-sm mt-1.5">
          {stats
            ? totalAtencao > 0
              ? <>Olá, {nome.split(' ')[0]} — <strong className="text-gray-700 dark:text-gray-300 font-semibold">{totalAtencao}</strong> {totalAtencao === 1 ? 'item precisa' : 'itens precisam'} de atenção.</>
              : <>Olá, {nome.split(' ')[0]} — nenhuma pendência no momento. 🎉</>
            : 'Carregando...'}
        </p>
      </div>

      <OperacaoPatrimonio stats={stats} />
    </div>
  )
}
