// src/lib/status.ts
// Fonte única de verdade sobre transições de status da Solicitação.
// Nenhuma rota deve comparar/alterar status sem passar por aqui.

import { StatusSolicitacao } from '@/types'

export const TRANSICOES_PERMITIDAS: Record<StatusSolicitacao, StatusSolicitacao[]> = {
  AGUARDANDO_GESTOR: ['AGUARDANDO_PATRIMONIO', 'REJEITADA_GESTOR', 'CANCELADA'],
  REJEITADA_GESTOR: [],
  AGUARDANDO_PATRIMONIO: ['CONFIRMADA', 'REJEITADA_PATRIMONIO', 'CANCELADA'],
  REJEITADA_PATRIMONIO: [],
  // Confirmada: fluxo interno vai direto para separação; fluxo externo passa
  // pela assinatura antes. A rota decide qual dos dois com base no tipoEmprestimo.
  CONFIRMADA: ['AGUARDANDO_ENVIO_ASSINATURA', 'EM_SEPARACAO', 'PRONTA_RETIRADA', 'CANCELADA'],
  AGUARDANDO_ENVIO_ASSINATURA: ['AGUARDANDO_ASSINATURA', 'CANCELADA'],
  AGUARDANDO_ASSINATURA: ['ASSINATURA_CONFIRMADA', 'CANCELADA'],
  ASSINATURA_CONFIRMADA: ['EM_SEPARACAO', 'PRONTA_RETIRADA', 'CANCELADA'],
  EM_SEPARACAO: ['PRONTA_RETIRADA', 'CANCELADA'],
  // NAO_RETIRADA (Etapa 9A-B): Patrimônio preparou o item, mas o
  // solicitante não compareceu — distinto de CANCELADA. Estado terminal.
  PRONTA_RETIRADA: ['EM_UTILIZACAO', 'NAO_RETIRADA', 'CANCELADA'],
  EM_UTILIZACAO: ['FINALIZADA'],
  FINALIZADA: [],
  CANCELADA: [],
  NAO_RETIRADA: [],
}

export function podeTransitar(atual: StatusSolicitacao, novo: StatusSolicitacao): boolean {
  return TRANSICOES_PERMITIDAS[atual]?.includes(novo) ?? false
}

/**
 * Todos os status de origem que hoje permitem transitar para `destino` —
 * derivado de TRANSICOES_PERMITIDAS (nunca hardcoded no chamador), para uso
 * em `updateMany` condicionais (`WHERE status IN [...]`) que precisam
 * proteger uma transição contra corrida com outras transições concorrentes
 * sem duplicar a lista de status em cada rota.
 */
export function statusOrigemPermitidos(destino: StatusSolicitacao): StatusSolicitacao[] {
  return (Object.keys(TRANSICOES_PERMITIDAS) as StatusSolicitacao[]).filter((origem) =>
    TRANSICOES_PERMITIDAS[origem].includes(destino)
  )
}

/** Status que ainda "bloqueiam" a disponibilidade de um bem numa data/período. */
export const STATUS_BLOQUEIAM_DISPONIBILIDADE: StatusSolicitacao[] = [
  'AGUARDANDO_GESTOR',
  'AGUARDANDO_PATRIMONIO',
  'CONFIRMADA',
  'AGUARDANDO_ENVIO_ASSINATURA',
  'AGUARDANDO_ASSINATURA',
  'ASSINATURA_CONFIRMADA',
  'EM_SEPARACAO',
  'PRONTA_RETIRADA',
  'EM_UTILIZACAO',
]

// Etapa feat/patrimonio-operational-ux (homologação visual — revisão pós-
// auditoria): a versão anterior desta lista misturava dois conceitos
// diferentes sob o mesmo nome de "pendência" — status em que o PATRIMÔNIO
// tem uma ação real e disponível agora, e status em que o Patrimônio já fez
// sua parte e só resta aguardar um TERCEIRO (o solicitante). O Painel do
// Patrimônio (lobby/PainelPatrimonio.tsx — único consumidor real desta
// constante) usa esta lista para decidir o que entra no contador "itens
// precisam de atenção" e na lista "Prioridades de hoje" — apresentar um
// status onde o Patrimônio não tem nada a fazer como se fosse uma prioridade
// de ação é enganoso, mesmo que a solicitação ainda esteja, em sentido
// amplo, "pendente" de conclusão.
//
// Removidos desta versão (mantidos em `STATUS_SOLICITACAO_LABELS`/na tela
// Pendências, que continua mostrando o backlog COMPLETO, sem essa filtragem
// — só o Painel do Patrimônio é seletivo):
//   - AGUARDANDO_ASSINATURA: o link já foi enviado (ação do Patrimônio já
//     ocorreu) — a partir daqui é o SOLICITANTE quem precisa assinar. O
//     Patrimônio não tem uma ação de rotina aqui (reenviar link/validar
//     manualmente são exceções, não o fluxo esperado).
//   - CONFIRMADA: status hoje INALCANÇÁVEL na prática — nenhuma rota grava
//     `status: 'CONFIRMADA'` (POST /api/solicitacoes/[id]/confirmar-patrimonio
//     pula direto para EM_SEPARACAO ou AGUARDANDO_ENVIO_ASSINATURA) — mantido
//     fora por clareza conceitual, sem efeito numérico real hoje.
//
// Mantidos — cada um tem uma ação real e conhecida do Patrimônio:
//   AGUARDANDO_PATRIMONIO        → analisar/confirmar.
//   AGUARDANDO_ENVIO_ASSINATURA  → enviar o link de assinatura.
//   ASSINATURA_CONFIRMADA        → separar.
//   EM_SEPARACAO                 → concluir separação/marcar pronta.
//   PRONTA_RETIRADA              → registrar retirada (e cobrar quando
//                                   atrasada — ver "Não retiradas").
//   EM_UTILIZACAO                → registrar devolução (e cobrar quando
//                                   atrasada).
export const STATUS_PENDENCIA_PATRIMONIO: StatusSolicitacao[] = [
  'AGUARDANDO_PATRIMONIO',
  'AGUARDANDO_ENVIO_ASSINATURA',
  'ASSINATURA_CONFIRMADA',
  'EM_SEPARACAO',
  'PRONTA_RETIRADA',
  'EM_UTILIZACAO',
]

// Etapa feat/admin-dashboard-operational — homologação encontrou o card
// pessoal "Minhas solicitações em andamento" sem filtro operacional real
// (levava para a lista inteira, sem status aplicado). O contador
// (`GET /api/dashboard`, campo `minhasPendentes`) já definia "em andamento"
// como QUALQUER status do PRÓPRIO solicitante, exceto os 5 terminais/
// negativos abaixo — nunca um único status inventado. Extraído aqui para
// ser a MESMA lista usada pelo contador e pelo filtro semântico
// `filtro=em_andamento` de `GET /api/solicitacoes` (ver
// src/lib/validations.ts → filtroSolicitacaoEnum) — nunca duas definições
// divergentes de "em andamento".
export const STATUS_EM_ANDAMENTO_SOLICITANTE: StatusSolicitacao[] = [
  'AGUARDANDO_GESTOR',
  'AGUARDANDO_PATRIMONIO',
  'CONFIRMADA',
  'AGUARDANDO_ENVIO_ASSINATURA',
  'AGUARDANDO_ASSINATURA',
  'ASSINATURA_CONFIRMADA',
  'EM_SEPARACAO',
  'PRONTA_RETIRADA',
  'EM_UTILIZACAO',
]
