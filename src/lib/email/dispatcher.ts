// src/lib/email/dispatcher.ts
//
// Etapa D.2 — outbox robusto: dispatcher que varre EmailEvento PENDENTE e
// tenta processá-los via processarEmailEvento(). Existe para recuperar
// eventos "abandonados" — criados dentro da transação de negócio das rotas
// de separação/não-retirada, mas cujo processamento inline (a chamada a
// processarEmailEvento logo após o commit) nunca aconteceu ou não terminou
// (ex.: o processo morreu entre o COMMIT e essa chamada).
//
// Nesta fase (D.2): só busca PENDENTE — nunca ENVIADO, nunca PROCESSANDO,
// nunca FALHA, nunca OBSOLETO (ver comentário em processar-evento.ts sobre
// por que PROCESSANDO não é retomado automaticamente, por que FALHA não
// tem retry automático ainda, e por que OBSOLETO é terminal e definitivo).
// Também restringe por `tipo` (TIPOS_EMAIL_SUPORTADOS — ver
// validade-evento.ts) para não deixar eventos de tipos ainda não
// implementados ocuparem o `limite` do lote e famintarem eventos
// suportados mais novos (correção pós-Codex-Review). Não é ligado a
// nenhum cron/rota administrativa nesta etapa — é um helper reutilizável
// e testável, para infraestrutura futura decidir como/quando chamar
// (rota admin, Vercel Cron etc.).

import { prisma } from '../prisma'
import { buildAppUrl } from './app-url'
import { processarEmailEvento } from './processar-evento'
import type { BuildEmailTemplate, ResultadoProcessamento } from './processar-evento'
import { criarValidadorDeEvento, TIPOS_EMAIL_SUPORTADOS } from './validade-evento'
import { renderProntaRetiradaEmail } from './templates/pronta-retirada'
import { renderNaoRetiradaEmail } from './templates/nao-retirada'
import { parseReservaConfirmadaPayload, renderReservaConfirmadaFromPayload } from './payloads/reserva-confirmada'
import { parseSolicitacaoAguardandoGestorPayload, renderSolicitacaoAguardandoGestorFromPayload } from './payloads/solicitacao-aguardando-gestor'
import { parseAssinaturaPendentePayload, renderAssinaturaPendenteFromPayload } from './payloads/assinatura-pendente'
import { parseRejeicaoPayload, renderRejeicaoFromPayload } from './payloads/rejeicao'
import { parseCancelamentoPayload, renderCancelamentoFromPayload } from './payloads/cancelamento'
import { parseSolicitacaoAguardandoPatrimonioPayload, renderSolicitacaoAguardandoPatrimonioFromPayload } from './payloads/solicitacao-aguardando-patrimonio'
import type { TipoEmailEvento } from '@prisma/client'

const LOTE_PADRAO = 10

export interface ResumoDispatch {
  /** Quantos EmailEvento PENDENTE foram encontrados neste lote (≤ limite). */
  encontrados: number
  /**
   * Quantos chegaram a ser efetivamente reivindicados (claim PENDENTE →
   * PROCESSANDO bem-sucedido) — inclui ENVIADO, FALHA, OBSOLETO e
   * PERSISTENCIA_FALHOU. NÃO inclui NAO_REIVINDICADO (claim perdido) nem
   * itens nunca submetidos a processarEmailEvento (tipo não suportado,
   * solicitação não encontrada, erro inesperado do lote) — ver correção
   * pós-Codex-Review (Etapa D.2): antes desta correção, NAO_REIVINDICADO
   * era contado aqui por engano.
   */
  processados: number
  enviados: number
  falhas: number
  /**
   * Terminaram OBSOLETO: a condição de negócio que motivou o envio deixou
   * de ser verdadeira antes do e-mail sair (ver `aindaValido` em
   * processar-evento.ts). Contam em `processados` (houve claim efetivo),
   * mas NÃO em `enviados`/`falhas`/`ignorados` — categoria própria, não
   * um "tipo de ignorado" (correção pós-Codex-Review, Etapa D.2).
   */
  obsoletos: number
  /**
   * Catch-all para "não terminou enviado, falha nem obsoleto": tipo ainda
   * sem template nesta fase, solicitação não encontrada, erro inesperado
   * no lote, evento já reivindicado por outro chamador entre a busca e o
   * claim (NAO_REIVINDICADO — não conta em `processados`), ou entrega
   * confirmada com persistência incerta (PERSISTENCIA_FALHOU — conta em
   * `processados`, mas não tem contador próprio nesta fase).
   */
  ignorados: number
}

// `payload` (Etapa D.3.6.5): trazido no MESMO findMany que os demais campos
// — não é feita uma segunda leitura do EmailEvento só para buscar payload.
// Tipado `unknown` (não o `Prisma.JsonValue | null` do client) porque
// ninguém aqui lê seus campos diretamente: só é repassado, intacto, para
// parseReservaConfirmadaPayload() (ver construirTemplate abaixo), que é
// quem de fato valida o formato.
type EventoParaDispatch = { id: string; tipo: TipoEmailEvento; solicitacaoId: string; destinatario: string; payload: unknown }

interface TemplateConstruido {
  build: BuildEmailTemplate
  /**
   * Repassado como `aindaValido` para processarEmailEvento() — refaz uma
   * leitura ENXUTA (só `status`) da Solicitação, deliberadamente separada
   * da leitura completa usada para montar o conteúdo do e-mail: os campos
   * de conteúdo (nome, itens, data, período) são imutáveis após a criação
   * da solicitação, então não precisam ser relidos; só `status` pode ter
   * mudado entre esta função rodar e o claim ser efetivado.
   *
   * `undefined` quando o tipo não tem regra de validade (Etapa D.3.1 —
   * ver validade-evento.ts) — processarEmailEvento() trata a ausência de
   * `aindaValido` como "sempre válido", sem checagem de obsolescência.
   */
  aindaValido?: () => Promise<boolean>
}

/**
 * Reconstrói o `build` (subject/html/text) de um EmailEvento a partir do
 * estado ATUAL da Solicitação — diferente das rotas, o dispatcher não tem
 * o contexto da requisição original em mãos, então busca os dados de novo.
 * Retorna `null` (sem lançar) quando não é seguro/possível montar a
 * mensagem — o chamador trata isso como "ignorado", nunca como erro fatal
 * do lote.
 */
async function construirTemplate(evento: EventoParaDispatch): Promise<TemplateConstruido | null> {
  // "Suportado pelo dispatcher" (TIPOS_EMAIL_SUPORTADOS) e "tem regra de
  // validade baseada em status" (criarValidadorDeEvento) são perguntas
  // independentes desde a Etapa D.3.1 — ver validade-evento.ts. `null`
  // aqui significa "tipo sem template implementado", não "obsoleto"
  // (obsoleto só é decidido depois do claim, dentro de
  // processarEmailEvento, via `aindaValido`). Backstop defensivo: o WHERE
  // do findMany em processarEmailsPendentes() já filtra por
  // TIPOS_EMAIL_SUPORTADOS, então este branch não deveria disparar na
  // prática — mantido para o caso de construirTemplate() vir a ser
  // chamado de outro lugar no futuro sem passar por aquele filtro.
  if (!TIPOS_EMAIL_SUPORTADOS.includes(evento.tipo)) {
    console.error(`Dispatcher: EmailEvento ${evento.id} tem tipo ${evento.tipo}, sem template implementado nesta fase — ignorado.`)
    return null
  }

  // `undefined` quando o tipo não tem regra de validade — repassado como
  // está para processarEmailEvento() (ver TemplateConstruido acima). Para
  // RESERVA_CONFIRMADA, `criarValidadorDeEvento` já retorna `undefined` sem
  // consultar o banco (STATUS_ESPERADO_POR_TIPO não tem entrada para esse
  // tipo — ver validade-evento.ts), então calculá-lo aqui, antes do branch
  // abaixo, não implica nenhuma leitura extra de Solicitação.
  const aindaValido = criarValidadorDeEvento(evento.tipo, evento.solicitacaoId)

  // RESERVA_CONFIRMADA (Etapa D.3.6.5 — elimina o finding do Codex Review:
  // o dispatcher relia o catálogo ATUAL de Patrimonio/CategoriaPatrimonio
  // para reconstruir um e-mail histórico). Fonte EXCLUSIVA a partir daqui:
  // EmailEvento.payload — nenhuma leitura de Solicitacao, Patrimonio,
  // CategoriaPatrimonio, User, ItemServico/ItemPapelaria ou Assinatura
  // ATUAIS acontece neste branch, por construção (não há chamada a
  // `prisma.solicitacao.findUnique` aqui).
  //
  // parseReservaConfirmadaPayload() roda DENTRO do `build` (mesmo motivo de
  // buildAppUrl() ser chamado dentro do `build`, ver comentário logo
  // abaixo): `build` só é invocado por processarEmailEvento() DEPOIS do
  // claim (PENDENTE → PROCESSANDO). Um payload ausente (evento antigo,
  // criado antes da Etapa D.3.6.2/D.3.6.4) ou inválido (versão não
  // suportada, campo malformado) faz o parser lançar
  // ReservaConfirmadaPayloadError, capturada por processarEmailEvento() no
  // try/catch em volta de `build(...)` — o evento termina FALHA, com o
  // provedor nunca chamado, em vez de ficar PENDENTE preso ou virar
  // "ignorado" silenciosamente. Nunca há fallback para o catálogo vivo.
  if (evento.tipo === 'RESERVA_CONFIRMADA') {
    const build: BuildEmailTemplate = (ctx) => {
      const payload = parseReservaConfirmadaPayload(evento.payload)
      return renderReservaConfirmadaFromPayload(payload, buildAppUrl(`/solicitacoes/${evento.solicitacaoId}`), ctx.bannerDestinatarioOriginal)
    }
    return { build, aindaValido }
  }

  // SOLICITACAO_AGUARDANDO_GESTOR (Etapa email-gestor-pendente) — mesmo
  // princípio de RESERVA_CONFIRMADA: fonte EXCLUSIVA a partir daqui é
  // EmailEvento.payload, nenhuma leitura de Solicitacao/User/Patrimonio
  // ATUAIS. Diferente de RESERVA_CONFIRMADA, `aindaValido` (calculado
  // acima, via STATUS_ESPERADO_POR_TIPO em validade-evento.ts) NÃO é
  // undefined aqui — a solicitação precisa CONTINUAR AGUARDANDO_GESTOR no
  // momento do claim, senão o evento vira OBSOLETO.
  if (evento.tipo === 'SOLICITACAO_AGUARDANDO_GESTOR') {
    const build: BuildEmailTemplate = (ctx) => {
      const payload = parseSolicitacaoAguardandoGestorPayload(evento.payload)
      return renderSolicitacaoAguardandoGestorFromPayload(payload, buildAppUrl(`/solicitacoes/${evento.solicitacaoId}`), ctx.bannerDestinatarioOriginal)
    }
    return { build, aindaValido }
  }

  // SOLICITACAO_AGUARDANDO_PATRIMONIO (Etapa email-aguardando-patrimonio) —
  // mesmo princípio: fonte EXCLUSIVA é EmailEvento.payload, nenhuma
  // leitura de Solicitacao/User ATUAIS. `aindaValido` NÃO é undefined
  // aqui — a solicitação precisa CONTINUAR AGUARDANDO_PATRIMONIO no
  // momento do claim, senão o evento vira OBSOLETO (ver validade-evento.ts).
  if (evento.tipo === 'SOLICITACAO_AGUARDANDO_PATRIMONIO') {
    const build: BuildEmailTemplate = (ctx) => {
      const payload = parseSolicitacaoAguardandoPatrimonioPayload(evento.payload)
      return renderSolicitacaoAguardandoPatrimonioFromPayload(payload, buildAppUrl(`/solicitacoes/${evento.solicitacaoId}`), ctx.bannerDestinatarioOriginal)
    }
    return { build, aindaValido }
  }

  // ASSINATURA_PENDENTE (Etapa email-assinatura-pendente) — mesmo
  // princípio: fonte EXCLUSIVA é EmailEvento.payload, `aindaValido` exige
  // que a solicitação continue AGUARDANDO_ASSINATURA (ver validade-evento.ts).
  if (evento.tipo === 'ASSINATURA_PENDENTE') {
    const build: BuildEmailTemplate = (ctx) => {
      const payload = parseAssinaturaPendentePayload(evento.payload)
      return renderAssinaturaPendenteFromPayload(payload, buildAppUrl(`/solicitacoes/${evento.solicitacaoId}`), ctx.bannerDestinatarioOriginal)
    }
    return { build, aindaValido }
  }

  // REJEICAO_GESTOR / REJEICAO_PATRIMONIO (Etapa email-rejeicoes) — mesmo
  // payload/template compartilhado (payload.papel decide o conteúdo — ver
  // payloads/rejeicao.ts). `aindaValido` é sempre `undefined` para os dois
  // (nenhuma entrada em STATUS_ESPERADO_POR_TIPO — ver validade-evento.ts):
  // status terminal, nunca fica obsoleto.
  if (evento.tipo === 'REJEICAO_GESTOR' || evento.tipo === 'REJEICAO_PATRIMONIO') {
    const build: BuildEmailTemplate = (ctx) => {
      const payload = parseRejeicaoPayload(evento.payload)
      return renderRejeicaoFromPayload(payload, buildAppUrl(`/solicitacoes/${evento.solicitacaoId}`), ctx.bannerDestinatarioOriginal)
    }
    return { build, aindaValido }
  }

  // CANCELAMENTO (Etapa email-cancelamento) — mesmo princípio: fonte
  // EXCLUSIVA é EmailEvento.payload (um payload por destinatário — ver
  // payloads/cancelamento.ts). `aindaValido` é sempre `undefined` (nenhuma
  // entrada em STATUS_ESPERADO_POR_TIPO — ver validade-evento.ts):
  // CANCELADA é status terminal, nunca fica obsoleto.
  if (evento.tipo === 'CANCELAMENTO') {
    const build: BuildEmailTemplate = (ctx) => {
      const payload = parseCancelamentoPayload(evento.payload)
      return renderCancelamentoFromPayload(payload, buildAppUrl(`/solicitacoes/${evento.solicitacaoId}`), ctx.bannerDestinatarioOriginal)
    }
    return { build, aindaValido }
  }

  // PRONTA_RETIRADA / NAO_RETIRADA (únicos outros valores em
  // TIPOS_EMAIL_SUPORTADOS) — continuam lendo o estado ATUAL da Solicitação:
  // são notificações operacionais sobre a situação presente da reserva, não
  // um registro histórico. Include enxuto (Etapa D.3.6.5 — os campos
  // adicionados na D.3.6 exclusivamente para RESERVA_CONFIRMADA
  // — solicitante.email, patrimonio.categoria, itensServico, assinatura —
  // foram removidos daqui: aquele tipo não passa mais por esta query).
  const solicitacao = await prisma.solicitacao.findUnique({
    where: { id: evento.solicitacaoId },
    include: {
      solicitante: { select: { nome: true } },
      itensPatrimonio: { include: { patrimonio: { select: { numero: true, marca: true, modelo: true } } } },
      itensPapelaria: { select: { descricao: true, quantidade: true } },
    },
  })
  if (!solicitacao) {
    // FK com onDelete: Cascade (schema.prisma) — na prática, se a
    // Solicitacao fosse excluída, seus EmailEvento iriam junto. Este branch
    // é defensivo (ex.: janela improvável entre leituras) — comportamento
    // preservado sem alteração nesta rodada.
    console.error(`Dispatcher: solicitação ${evento.solicitacaoId} não encontrada para o EmailEvento ${evento.id} — ignorado.`)
    return null
  }

  // buildAppUrl() (correção pós-Codex-Review) é chamado DENTRO do `build`
  // abaixo, não aqui — `build` só é invocado por processarEmailEvento()
  // depois do claim (PENDENTE → PROCESSANDO) e de aindaValido() passarem.
  // Se APP_URL estiver ausente/inválido, buildAppUrl() lança
  // EmailConfigError nesse momento, e processarEmailEvento() já trata
  // qualquer exceção de `build` marcando o evento como FALHA (mesmo
  // caminho do processamento inline — ver processar-evento.ts). Chamar
  // buildAppUrl() aqui fora (antes do claim) faria essa exceção escapar
  // para o try/catch do loop em processarEmailsPendentes(), que só sabe
  // "ignorar" o evento sem tocar seu status — ele ficaria PENDENTE para
  // sempre, tentado de novo a cada execução do dispatcher.
  if (evento.tipo === 'PRONTA_RETIRADA') {
    const build: BuildEmailTemplate = (ctx) =>
      renderProntaRetiradaEmail({
        nomeSolicitante: solicitacao.solicitante.nome,
        numero: solicitacao.numero,
        data: solicitacao.data,
        periodos: solicitacao.periodos,
        itensPatrimonio: solicitacao.itensPatrimonio.map((item) => ({
          numero: item.patrimonio.numero,
          marca: item.patrimonio.marca,
          modelo: item.patrimonio.modelo,
        })),
        itensPapelaria: solicitacao.itensPapelaria,
        link: buildAppUrl(`/solicitacoes/${solicitacao.id}`),
        bannerDestinatarioOriginal: ctx.bannerDestinatarioOriginal,
      })
    return { build, aindaValido }
  }

  // evento.tipo === 'NAO_RETIRADA' (único outro valor possível aqui —
  // RESERVA_CONFIRMADA já retornou mais acima, antes desta query).
  const build: BuildEmailTemplate = (ctx) =>
    renderNaoRetiradaEmail({
      nomeSolicitante: solicitacao.solicitante.nome,
      numero: solicitacao.numero,
      data: solicitacao.data,
      periodos: solicitacao.periodos,
      naoRetiradaEm: solicitacao.naoRetiradaEm ?? new Date(),
      link: buildAppUrl(`/solicitacoes/${solicitacao.id}`),
      bannerDestinatarioOriginal: ctx.bannerDestinatarioOriginal,
    })
  return { build, aindaValido }
}

/**
 * Varre até `limite` EmailEvento PENDENTE (mais antigos primeiro) e tenta
 * processar cada um via processarEmailEvento() — que faz seu próprio claim
 * atômico (PENDENTE → PROCESSANDO), então mesmo que este dispatcher rode em
 * paralelo com outra instância dele mesmo, ou com o processamento inline de
 * uma rota, no máximo um deles efetivamente chega a chamar o provedor para
 * cada evento.
 *
 * Uma falha (esperada ou inesperada) em um evento nunca aborta o lote — os
 * demais continuam sendo processados.
 */
export async function processarEmailsPendentes(limite: number = LOTE_PADRAO): Promise<ResumoDispatch> {
  // Correção pós-Codex-Review (Etapa D.2): restringir a `tipo` suportado
  // (TIPOS_EMAIL_SUPORTADOS, ver validade-evento.ts) diretamente no WHERE
  // — não só filtrar depois de buscar. Sem isso, eventos PENDENTE de tipos
  // ainda não implementados (ex.: CANCELAMENTO, REJEICAO_GESTOR — já
  // existem no enum desde a D.1, mas nenhuma rota os cria ainda) podiam
  // ocupar todo o `limite` se fossem os mais antigos, deixando eventos
  // suportados mais novos famintos (nunca alcançados pelo `take`). Tipos
  // não suportados continuam PENDENTE indefinidamente — intencional, não
  // viram FALHA/OBSOLETO/ENVIADO só por não serem processados nesta fase.
  // `payload` (Etapa D.3.6.5) já vem neste MESMO findMany — uma segunda
  // leitura do EmailEvento só para buscar payload seria redundante (ver
  // EventoParaDispatch acima). PRONTA_RETIRADA/NAO_RETIRADA simplesmente
  // ignoram este campo (sempre `null` para eles nesta fase).
  const pendentes = await prisma.emailEvento.findMany({
    where: { status: 'PENDENTE', tipo: { in: [...TIPOS_EMAIL_SUPORTADOS] } },
    orderBy: { createdAt: 'asc' },
    take: limite,
    select: { id: true, tipo: true, solicitacaoId: true, destinatario: true, payload: true },
  })

  const resumo: ResumoDispatch = {
    encontrados: pendentes.length,
    processados: 0,
    enviados: 0,
    falhas: 0,
    obsoletos: 0,
    ignorados: 0,
  }

  for (const evento of pendentes) {
    try {
      const construido = await construirTemplate(evento)
      if (!construido) {
        resumo.ignorados++
        continue
      }

      const resultado: ResultadoProcessamento = await processarEmailEvento(evento.id, construido.build, {
        aindaValido: construido.aindaValido,
      })

      // Correção pós-Codex-Review (Etapa D.2): `processados` conta só
      // claims EFETIVOS — NAO_REIVINDICADO significa que este dispatcher
      // não chegou a reivindicar o evento (outro chamador já tinha
      // pegado), então não é "processado" por este dispatcher.
      if (resultado !== 'NAO_REIVINDICADO') resumo.processados++

      if (resultado === 'ENVIADO') resumo.enviados++
      else if (resultado === 'FALHA') resumo.falhas++
      else if (resultado === 'OBSOLETO') resumo.obsoletos++
      else resumo.ignorados++ // NAO_REIVINDICADO ou PERSISTENCIA_FALHOU
    } catch (err) {
      console.error(`Dispatcher: falha inesperada ao processar EmailEvento ${evento.id}:`, err instanceof Error ? err.message : err)
      resumo.ignorados++
    }
  }

  return resumo
}
