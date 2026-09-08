// src/lib/email/destinatarios.ts
//
// Etapa D.3.3 — monta a lista lógica de destinatários de RESERVA_CONFIRMADA
// (solicitante + equipe Patrimônio), já deduplicada por e-mail, ANTES de
// qualquer `EmailEvento.create` — necessário porque a unique constraint é
// `[solicitacaoId, tipo, destinatario]`: se o solicitante também tiver
// permissao='patrimonio', o mesmo endereço apareceria duas vezes na lista
// bruta, e a segunda `create` violaria a constraint (derrubando a
// transação de negócio inteira junto). Ver análise da Etapa D.3.
//
// Este arquivo NÃO está ligado a nenhuma rota, ao dispatcher, nem cria
// EmailEvento — só prepara a lista. Reutiliza PapelDestinatario do
// template (import de mão única, sem risco de dependência circular:
// reserva-confirmada.ts não importa deste arquivo).
//
// Caixa de grupo do Patrimônio (Etapa email-patrimonio-caixa-grupo —
// correção pós-produção: uma única solicitação gerava um EmailEvento POR
// USUÁRIO ativo com permissao='patrimonio', multiplicando e-mails e
// round-trips de banco dentro da transação de negócio — o mesmo padrão que
// já tinha causado o P2028 corrigido em fix/vercel-request-transaction).
// `emailPatrimonio` abaixo deixou de ser uma LISTA de e-mails buscada no
// banco para virar um único endereço fixo (EMAIL_PATRIMONIO_RECIPIENT —
// ver resolverEmailPatrimonioOuNull() mais abaixo), então
// deduplicarDestinatarios() nunca mais itera sobre N membros: o "papel"
// patrimonio agora é, no máximo, UMA entrada. As notificações IN-APP
// continuam individuais (uma por usuário ativo) — isso é decidido nas
// rotas, fora deste arquivo, e não muda aqui.
//
// Reconstrução do papel pelo dispatcher (Etapa D.3.6 — ver
// papelDestinatarioReservaConfirmada() abaixo): EmailEvento não tem coluna
// de papel (as rotas /confirmar-patrimonio e /assinatura/confirmar
// carregam {eventoId, email, papel} em memória a partir do retorno desta
// função, dentro da própria transação, para o envio inline). Um EmailEvento
// RESERVA_CONFIRMADA abandonado (recuperado pelo dispatcher, sem esse
// contexto em memória) tem seu papel reconstruído comparando o e-mail
// normalizado do evento (`evento.destinatario`) com o e-mail normalizado
// do solicitante da solicitação: se baterem, o papel só pode ter sido
// 'solicitante' — nunca 'patrimonio', porque deduplicarDestinatarios() já
// teria descartado a entrada de Patrimônio com esse mesmo e-mail
// normalizado antes de chegar a virar EmailEvento (ver regra de
// precedência abaixo — extremamente improvável na prática, já que
// EMAIL_PATRIMONIO_RECIPIENT é uma caixa de grupo, não o e-mail pessoal de
// ninguém, mas a garantia é preservada mesmo assim). Caso contrário, o
// papel só pode ter sido 'patrimonio'.

import type { Prisma } from '@prisma/client'
import type { PapelDestinatario } from './templates/reserva-confirmada'
import { getEmailPatrimonioRecipient } from './config'

export interface DestinatarioReservaConfirmada {
  email: string
  papel: PapelDestinatario
}

/**
 * `trim()` + `toLowerCase()` — só para efeito de COMPARAÇÃO/deduplicação,
 * nunca para decidir o valor armazenado no resultado (ver `deduplicarDestinatarios`,
 * que preserva o e-mail original, só trimado). Retorna `null` para
 * qualquer valor vazio, só espaços, ou de tipo inesperado (defensivo —
 * User.email é obrigatório no schema, mas este helper não confia cegamente
 * em dados vindos de fora dele, ex.: um mock de teste ou uma integração
 * futura).
 */
function normalizarParaComparacao(email: unknown): string | null {
  if (typeof email !== 'string') return null
  const normalizado = email.trim().toLowerCase()
  return normalizado.length > 0 ? normalizado : null
}

/**
 * Monta a lista final e deduplicada de destinatários — solicitante (quando
 * houver) e a caixa de grupo do Patrimônio (quando elegível) — nunca mais
 * uma lista de e-mails individuais da equipe (ver comentário do topo do
 * arquivo).
 *
 * Regras (Etapa D.3.3, revisada na Etapa email-patrimonio-caixa-grupo):
 * - deduplicação case-insensitive, comparando por e-mail normalizado, mas
 *   preservando no resultado o valor original (só trimado) — nunca força
 *   minúsculas no endereço realmente usado para enviar;
 * - se `emailPatrimonio` coincidir com o e-mail do solicitante (mesmo
 *   endereço nos dois papéis — cenário improvável para uma caixa de grupo,
 *   mas tratado por segurança), SOLICITANTE prevalece: a pessoa recebe UM
 *   único e-mail, nunca dois — preserva a mesma invariante de sempre,
 *   agora só com no máximo 2 entradas possíveis em vez de N+1;
 * - ordem determinística: solicitante primeiro (quando presente), Patrimônio
 *   depois (quando presente);
 * - `emailPatrimonio: null` (Patrimônio não elegível desta vez — ver
 *   resolverEmailPatrimonioOuNull() abaixo) e entradas vazias/inválidas são
 *   ignoradas silenciosamente, nunca derrubam a lista inteira.
 *
 * Função pura (sem I/O) — testável sem mocks de banco.
 */
export function deduplicarDestinatarios(
  emailSolicitante: unknown,
  emailPatrimonio: unknown
): DestinatarioReservaConfirmada[] {
  const vistos = new Set<string>()
  const resultado: DestinatarioReservaConfirmada[] = []

  const solicitanteNormalizado = normalizarParaComparacao(emailSolicitante)
  if (solicitanteNormalizado) {
    vistos.add(solicitanteNormalizado)
    resultado.push({ email: (emailSolicitante as string).trim(), papel: 'solicitante' })
  }

  const patrimonioNormalizado = normalizarParaComparacao(emailPatrimonio)
  if (patrimonioNormalizado && !vistos.has(patrimonioNormalizado)) {
    resultado.push({ email: (emailPatrimonio as string).trim(), papel: 'patrimonio' })
  }

  return resultado
}

/**
 * Resolve o endereço da caixa de grupo do Patrimônio (getEmailPatrimonioRecipient(),
 * em config.ts) de forma SEGURA para uso dentro de uma transação de
 * negócio: NUNCA lança. Se EMAIL_PATRIMONIO_RECIPIENT estiver ausente ou
 * inválida, loga o erro (registrável — mesmo padrão de marcarFalha() em
 * processar-evento.ts) e retorna `null`.
 *
 * `null` faz o chamador tratar como "Patrimônio não elegível para e-mail
 * desta vez" (via deduplicarDestinatarios acima) — NUNCA como "volte a
 * notificar os usuários individuais": isso reintroduziria exatamente o
 * problema (loop de EmailEvento por usuário) que esta caixa de grupo existe
 * para eliminar. A operação de negócio que chamou isto (transição de
 * status, histórico, notificações in-app) nunca é desfeita por causa deste
 * erro de configuração — só o e-mail de grupo deixa de ser criado.
 *
 * `contexto` é só para o log (ex.: o `tipo` do EmailEvento que não pôde ser
 * criado) — não afeta o comportamento.
 */
export function resolverEmailPatrimonioOuNull(contexto: string): string | null {
  try {
    return getEmailPatrimonioRecipient()
  } catch (err) {
    // Prefixo "[Email]" (Etapa email-patrimonio-caixa-grupo — observabilidade):
    // deliberadamente greppável nos Runtime Logs do Vercel, para achar este
    // caso rápido em meio a todo o resto do log de uma requisição. `contexto`
    // é só o `tipo` do EmailEvento que deixou de ser criado (ex.:
    // 'CANCELAMENTO') — nunca dados da solicitação. `err.message` também é
    // seguro de logar: EmailConfigError nunca inclui o valor bruto da env
    // (só a mensagem fixa "ausente ou inválido: defina...", ver config.ts) —
    // nenhuma API key, connection string, JWT ou conteúdo de solicitação
    // passa por aqui.
    console.error(
      `[Email] EMAIL_PATRIMONIO_RECIPIENT ausente ou inválido; notificação por e-mail da equipe Patrimônio não foi criada (tipo: ${contexto}). Operação de negócio não é afetada; nenhum e-mail é enviado para endereço individual/inventado.`,
      err instanceof Error ? err.message : err
    )
    return null
  }
}

/**
 * Monta a lista final de destinatários de RESERVA_CONFIRMADA (solicitante +
 * caixa de grupo do Patrimônio, deduplicados — ver deduplicarDestinatarios()
 * acima), usando o MESMO gate de elegibilidade que o projeto já usa em
 * todos os fluxos análogos (SOLICITACAO_AGUARDANDO_PATRIMONIO, CANCELAMENTO):
 * "existe pelo menos um usuário ATIVO com permissao='patrimonio'?" — Etapa
 * email-patrimonio-caixa-grupo optou por preservar esse gate tal como
 * estava (mesmo QUANDO decide notificar), só trocando QUEM recebe (1 caixa
 * de grupo, nunca mais N usuários individuais). Não decidir uma regra nova
 * de "sempre notificar independente de haver equipe cadastrada" — fora do
 * escopo desta correção.
 *
 * Recebe `tx` (Etapa D.3.4) em vez de usar o `prisma` global diretamente —
 * mesmo motivo de sempre: a decisão de notificar participa da mesma
 * transação que efetiva a transição de status. `findFirst` (não
 * `findMany`) — só precisamos saber SE existe alguém, nunca mais dos
 * e-mails de cada um.
 */
export async function buscarDestinatariosReservaConfirmada(
  tx: Prisma.TransactionClient,
  emailSolicitante: string
): Promise<DestinatarioReservaConfirmada[]> {
  const algumPatrimonioAtivo = await tx.user.findFirst({
    where: { ativo: true, permissao: 'patrimonio' },
    select: { id: true },
  })

  const emailPatrimonio = algumPatrimonioAtivo ? resolverEmailPatrimonioOuNull('RESERVA_CONFIRMADA') : null
  return deduplicarDestinatarios(emailSolicitante, emailPatrimonio)
}

/**
 * Reconstrói o papel ('solicitante' | 'patrimonio') de um EmailEvento
 * RESERVA_CONFIRMADA já persistido, a partir só do e-mail destinatário do
 * evento e do e-mail atual do solicitante da solicitação — usado pelo
 * dispatcher (Etapa D.3.6) ao recuperar um evento abandonado, quando o
 * papel decidido no momento da criação (ver comentário acima) não está
 * mais disponível em memória.
 *
 * Reutiliza normalizarParaComparacao() — a MESMA normalização
 * (trim+lowercase) usada por deduplicarDestinatarios(), para nunca divergir
 * da regra que decidiu o papel originalmente.
 */
export function papelDestinatarioReservaConfirmada(destinatario: unknown, emailSolicitante: unknown): PapelDestinatario {
  const destinatarioNormalizado = normalizarParaComparacao(destinatario)
  const solicitanteNormalizado = normalizarParaComparacao(emailSolicitante)
  return destinatarioNormalizado !== null && destinatarioNormalizado === solicitanteNormalizado ? 'solicitante' : 'patrimonio'
}
