// src/lib/patrimonio-dashboard.ts
//
// Etapa feat/admin-dashboard-operational — contrato de dados + regra pura
// ("o que precisa de atenção do Patrimônio") do painel operacional,
// extraídos para um módulo SEM JSX de propósito: `OperacaoPatrimonio.tsx`
// (componente compartilhado entre o Painel do Patrimônio e o Dashboard do
// Admin) importa daqui, e scripts de teste (`ts-node`, sem transform de JSX
// configurado) conseguem `require()` este arquivo diretamente para testar a
// soma sem precisar compilar nenhum componente React.
//
// Única definição do contrato — nunca duas fontes de verdade entre o Painel
// do Patrimônio (perfil PATRIMONIO) e a seção "Operação do Patrimônio" do
// Dashboard do Admin.

export interface PatrimonioStats {
  aguardandoAnalise: number
  emSeparacao: number
  prontasRetirada: number
  emUtilizacao: number
  aguardandoDevolucao: number
  naoRetiradas: number
  bensTotal: number
  bensAtivos: number
}

/**
 * Única definição de "quantos itens precisam de atenção do Patrimônio" —
 * EXATAMENTE a soma dos 5 estados com ação real (nunca inventário, nunca
 * estados aguardando ação de terceiro, ex.: `aguardandoAssinatura` — ver
 * `STATUS_PENDENCIA_PATRIMONIO` em src/lib/status.ts para o mesmo critério
 * aplicado a "Prioridades de hoje"). Reaproveitada por PainelPatrimonio.tsx
 * (perfil PATRIMONIO) e lobby/page.tsx (Admin) — nunca uma segunda soma.
 */
export function calcularTotalAtencaoPatrimonio(stats: PatrimonioStats): number {
  return stats.aguardandoAnalise + stats.emSeparacao + stats.prontasRetirada + stats.aguardandoDevolucao + stats.naoRetiradas
}
