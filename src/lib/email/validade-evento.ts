// src/lib/email/validade-evento.ts
//
// Etapa D.2 — correção final pós-Codex-Review: fonte ÚNICA de verdade para
// "este EmailEvento ainda faz sentido ser enviado?". Usada tanto pelo
// caminho inline (rotas de separação/não-retirada, logo após o commit da
// transação) quanto pelo dispatcher (processarEmailsPendentes) — nenhum
// dos dois duplica o mapeamento tipo→status esperado nem a lógica de
// releitura. Qualquer caminho futuro (cron, rota administrativa) deve
// passar por aqui também, nunca reimplementar a regra.
//
// processarEmailEvento() (processar-evento.ts) permanece deliberadamente
// agnóstico de regra de negócio — só sabe executar o hook `aindaValido`
// que este módulo constrói, não o que "válido" significa.

import { prisma } from '../prisma'
import type { TipoEmailEvento } from '@prisma/client'
import type { StatusSolicitacao } from '@/types'

/**
 * Tipos de EmailEvento com template implementado — fonte ÚNICA usada pelo
 * dispatcher para restringir sua varredura de PENDENTE só a tipos que ele
 * sabe montar/enviar (ver processarEmailsPendentes() em dispatcher.ts).
 * Os demais valores de TipoEmailEvento (ex.: CANCELAMENTO, REJEICAO_GESTOR,
 * ASSINATURA_PENDENTE) já existem no enum desde a Etapa D.1, mas nenhuma
 * rota ainda cria eventos desses tipos.
 *
 * DELIBERADAMENTE independente de STATUS_ESPERADO_POR_TIPO (Etapa D.3.1 —
 * correção arquitetural): "suportado pelo dispatcher" e "tem regra de
 * validade baseada em status atual" são perguntas diferentes. Nem todo
 * tipo suportado precisa de uma entrada em STATUS_ESPERADO_POR_TIPO — ver
 * criarValidadorDeEvento() abaixo. Quando um novo tipo ganhar template,
 * adicione-o aqui; se ele também precisar de uma regra de obsolescência
 * baseada em status, adicione-o a STATUS_ESPERADO_POR_TIPO também — os
 * dois passos são independentes.
 *
 * RESERVA_CONFIRMADA (Etapa D.3.6) é o exemplo real dessa independência:
 * suportado aqui (o dispatcher sabe reconstruir e enviar seu template —
 * ver dispatcher.ts), mas DELIBERADAMENTE ausente de
 * STATUS_ESPERADO_POR_TIPO — é um registro histórico ("foi confirmada"),
 * não uma garantia de estado atual, então continua válido para envio
 * mesmo que a solicitação avance, seja retirada ou seja cancelada depois.
 */
export const TIPOS_EMAIL_SUPORTADOS: readonly TipoEmailEvento[] = [
  'PRONTA_RETIRADA',
  'NAO_RETIRADA',
  'RESERVA_CONFIRMADA',
  'SOLICITACAO_AGUARDANDO_GESTOR',
  'ASSINATURA_PENDENTE',
  'REJEICAO_GESTOR',
  'REJEICAO_PATRIMONIO',
  'CANCELAMENTO',
  'SOLICITACAO_AGUARDANDO_PATRIMONIO',
]

/**
 * Status de Solicitacao que precisa CONTINUAR sendo verdade, no momento do
 * envio, para que o e-mail daquele tipo ainda faça sentido. Um EmailEvento
 * PENDENTE pode ser processado bem depois de criado (dispatcher) ou, mais
 * raramente, ter esse status mudado por uma transição concorrente entre o
 * commit da transação de negócio e o envio inline (ex.: /retirada,
 * /cancelar ou /nao-retirada correndo entre o commit de /separacao e a
 * chamada a processarEmailEvento) — em ambos os casos, se o status atual
 * não bater com o esperado aqui, o evento é tratado como OBSOLETO.
 *
 * PARCIAL de propósito: um tipo pode estar em TIPOS_EMAIL_SUPORTADOS sem
 * ter entrada aqui — nesse caso o e-mail é enviado sem checagem de
 * obsolescência (ex.: um evento que é só um registro histórico de algo já
 * ocorrido, que continua fazendo sentido mesmo que o status mude depois —
 * ver criarValidadorDeEvento()).
 */
const STATUS_ESPERADO_POR_TIPO: Partial<Record<TipoEmailEvento, StatusSolicitacao>> = {
  PRONTA_RETIRADA: 'PRONTA_RETIRADA',
  NAO_RETIRADA: 'NAO_RETIRADA',
  // Etapa email-gestor-pendente: diferente de RESERVA_CONFIRMADA (registro
  // histórico de algo já ocorrido), esta notificação só faz sentido
  // enquanto a decisão do gestor CONTINUA pendente — se a solicitação for
  // aprovada, rejeitada ou cancelada antes do envio efetivo, o e-mail vira
  // OBSOLETO em vez de notificar uma decisão que já não existe mais.
  SOLICITACAO_AGUARDANDO_GESTOR: 'AGUARDANDO_GESTOR',
  // Etapa email-assinatura-pendente: mesmo princípio — só faz sentido
  // enquanto a assinatura CONTINUA pendente. Se a assinatura já tiver sido
  // confirmada (ASSINATURA_CONFIRMADA) ou a solicitação tiver sido
  // cancelada/mudado de status por qualquer outro motivo antes do envio,
  // o e-mail vira OBSOLETO em vez de notificar uma pendência que já não
  // existe mais.
  ASSINATURA_PENDENTE: 'AGUARDANDO_ASSINATURA',
  // Etapa email-aguardando-patrimonio: mesmo princípio — só faz sentido
  // enquanto a análise do Patrimônio CONTINUA pendente. Se a solicitação já
  // tiver sido confirmada, rejeitada ou cancelada pelo Patrimônio antes do
  // envio efetivo, o e-mail vira OBSOLETO em vez de notificar uma
  // pendência que já não existe mais. AGUARDANDO_PATRIMONIO NÃO é
  // terminal — TRANSICOES_PERMITIDAS['AGUARDANDO_PATRIMONIO'] (src/lib/status.ts)
  // permite CONFIRMADA/REJEITADA_PATRIMONIO/CANCELADA — diferente de
  // REJEICAO_GESTOR/REJEICAO_PATRIMONIO/CANCELAMENTO logo abaixo.
  SOLICITACAO_AGUARDANDO_PATRIMONIO: 'AGUARDANDO_PATRIMONIO',
  // Etapa email-rejeicoes: REJEICAO_GESTOR e REJEICAO_PATRIMONIO
  // DELIBERADAMENTE não têm entrada aqui — mesmo caso de RESERVA_CONFIRMADA
  // (registro histórico de algo que ocorreu), com uma garantia ainda mais
  // forte: TRANSICOES_PERMITIDAS['REJEITADA_GESTOR'] e
  // ['REJEITADA_PATRIMONIO'] (src/lib/status.ts) são arrays VAZIOS — não
  // existe NENHUMA transição de saída desses status. Uma vez persistida, a
  // rejeição é definitiva por construção; não há cenário em que a condição
  // que motivou o e-mail deixe de ser verdadeira antes do envio, então uma
  // checagem de obsolescência aqui seria sempre um no-op.
  //
  // Etapa email-cancelamento: CANCELAMENTO segue o MESMO raciocínio —
  // TRANSICOES_PERMITIDAS['CANCELADA'] (src/lib/status.ts) também é um
  // array VAZIO. Uma vez cancelada, a solicitação nunca transiciona para
  // nenhum outro status; checagem de obsolescência aqui também seria
  // sempre um no-op.
}

/** `null` quando o tipo não tem regra de validade definida. */
export function statusEsperadoParaTipo(tipo: TipoEmailEvento): StatusSolicitacao | null {
  return STATUS_ESPERADO_POR_TIPO[tipo] ?? null
}

/**
 * Constrói o hook `aindaValido` (ver ProcessarEmailEventoOptions em
 * processar-evento.ts) para um EmailEvento de um `tipo`+`solicitacaoId`
 * específicos: uma releitura ENXUTA (só `status`) da Solicitação no
 * momento em que roda, comparada ao status esperado para aquele tipo.
 *
 * Retorna `undefined` (não uma função) quando o tipo não tem regra de
 * validade definida em STATUS_ESPERADO_POR_TIPO — isso NÃO significa "tipo
 * não suportado" (essa pergunta é respondida por TIPOS_EMAIL_SUPORTADOS,
 * separadamente); significa apenas que este tipo de e-mail não precisa de
 * uma checagem de obsolescência baseada em status para ser enviado. O
 * chamador (dispatcher.ts) repassa esse `undefined` para
 * processarEmailEvento(), que trata "sem aindaValido" como "sempre válido"
 * — mesmo comportamento de quando a opção simplesmente não é passada.
 */
export function criarValidadorDeEvento(tipo: TipoEmailEvento, solicitacaoId: string): (() => Promise<boolean>) | undefined {
  const statusEsperado = statusEsperadoParaTipo(tipo)
  if (!statusEsperado) return undefined

  return async () => {
    const atual = await prisma.solicitacao.findUnique({ where: { id: solicitacaoId }, select: { status: true } })
    return atual?.status === statusEsperado
  }
}
