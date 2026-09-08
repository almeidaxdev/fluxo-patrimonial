// src/app/api/solicitacoes/[id]/assinatura/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { Prisma, type StatusEmailEvento } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getSession } from '@/lib/auth'
import { getValidatedMutationSession } from '@/lib/session-validation'
import { isPatrimonioOuAdmin } from '@/lib/permissions'
import { registrarHistorico } from '@/lib/historico'
import { criarNotificacao } from '@/lib/notificacoes'
import { enviarAssinaturaSchema } from '@/lib/validations'
import { buildAppUrl, processarEmailEvento, criarValidadorDeEvento, geracaoIdempotenciaDoPayload } from '@/lib/email'
import {
  construirPayloadAssinaturaPendente,
  renderAssinaturaPendenteFromPayload,
  type ConstruirPayloadAssinaturaPendenteInput,
} from '@/lib/email/payloads/assinatura-pendente'
import { ErroNegocio } from '@/lib/erros'
import { checkSensitiveRateLimit, RATE_LIMIT_RETRY_AFTER_SECONDS, RATE_LIMIT_RESPONSE_BODY } from '@/lib/rate-limit'
import { parseJsonBody } from '@/lib/http'

// Envia (ou reenvia) o link de assinatura. Primeiro envio permitido em
// CONFIRMADA (fluxo "Não agora" seguido de envio posterior) ou
// AGUARDANDO_ENVIO_ASSINATURA; reenvio (Etapa fix/signature-resend)
// permitido também em AGUARDANDO_ASSINATURA, quando o link já foi enviado
// antes e precisa ser reenviado (falha de entrega, ou o solicitante não
// recebeu/perdeu o e-mail).
//
// Concorrência do reenvio — DOIS gates independentes, cada um cobrindo uma
// janela de corrida diferente (ver auditoria da Etapa fix/signature-resend):
//
// GATE 1 (Solicitacao.status + Solicitacao.updatedAt, abaixo): protege
// requests VERDADEIRAMENTE simultâneas. Diferente das demais transições
// desta rota, AGUARDANDO_ASSINATURA → AGUARDANDO_ASSINATURA é uma
// AUTO-transição — comparar só `status` no WHERE não basta, porque o valor
// "antes" e "depois" é o mesmo: sob READ COMMITTED, quando a segunda
// chamada concorrente é liberada do lock da linha (após a primeira
// commitar), o Postgres reavalia o WHERE dela contra o valor JÁ COMMITADO
// — que continua igual (a primeira gravou o MESMO status) — então a
// segunda também bateria. `updatedAt` (já existe no schema, `@updatedAt`,
// sem migração) resolve isso: TODA escrita nesta linha bate `updatedAt`,
// inclusive uma auto-transição — a segunda chamada, ao reavaliar seu WHERE
// com o `updatedAt` que ela leu ANTES da primeira commitar, não bate mais.
//
// GATE 2 (EmailEvento.status, mais abaixo): cobre a janela que o Gate 1
// NÃO cobre — uma request B que chega DEPOIS que a request A já commitou
// por completo (o lock da linha de Solicitacao, que A segurou durante toda
// a sua transação, já foi liberado; B lê um `updatedAt` novo, sem
// concorrência real na leitura, e passaria o Gate 1 normalmente) enquanto
// o EmailEvento de A ainda está PENDENTE ou PROCESSANDO (o processamento
// inline de A, que roda FORA da transação, ainda não terminou). Sem este
// segundo gate, B recriaria histórico/notificação/rearme para um reenvio
// que já está em andamento. Ver ESTADOS_ELEGIVEIS_PARA_REARME abaixo.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ message: 'Não autorizado.' }, { status: 401 })

  const { id } = await params

  // Rate limit por (solicitação + usuário) — Etapa security/rate-limit,
  // namespace 'assinatura'. Distinto da idempotência/concorrência dos dois
  // gates documentados acima: aqueles impedem DOIS envios físicos para a
  // MESMA tentativa concorrente; este limite contém reenvios repetidos ao
  // longo do TEMPO (cliques manuais espaçados), que os gates de concorrência
  // não cobrem, sem substituir nenhum deles.
  //
  // Etapa security/session-revocation: usa `session.id` (claim do JWT, sem
  // consulta ao banco) só como IDENTIFICADOR do limitador — nunca para
  // autorizar a ação. Mantido ANTES da revalidação no banco logo abaixo,
  // mesmo princípio já aplicado ao login (S4): abuso por volume é contido
  // antes de custar uma consulta ao banco.
  const { limited } = await checkSensitiveRateLimit({ request: req, namespace: 'assinatura', identifier: `${id}:${session.id}` })
  if (limited) {
    return NextResponse.json(RATE_LIMIT_RESPONSE_BODY, {
      status: 429,
      headers: { 'Retry-After': String(RATE_LIMIT_RETRY_AFTER_SECONDS) },
    })
  }

  // A checagem de permissão usa exclusivamente os dados FRESCOS devolvidos
  // aqui (`validacao.user`), nunca `session` (claims do JWT, potencialmente
  // desatualizadas) — dali em diante `session` só existe para o
  // identificador do rate limit acima.
  const validacao = await getValidatedMutationSession()
  if (!validacao.valido) return validacao.resposta
  if (!isPatrimonioOuAdmin(validacao.user)) return NextResponse.json({ message: 'Sem permissão.' }, { status: 403 })

  try {
    const corpo = await parseJsonBody(req)
    if (!corpo.ok) return corpo.resposta
    const parsed = enviarAssinaturaSchema.safeParse(corpo.data)
    if (!parsed.success) {
      return NextResponse.json({ message: 'O link informado não é válido.' }, { status: 400 })
    }

    const resultado = await prisma.$transaction(async (tx) => {
      const solicitacao = await tx.solicitacao.findUnique({ where: { id } })
      if (!solicitacao) throw new ErroNegocio('Solicitação não encontrada.', 404)
      if (solicitacao.tipoEmprestimo !== 'externo') {
        throw new ErroNegocio('Assinatura documental aplica-se apenas a atividades externas.', 400)
      }
      if (!['AGUARDANDO_ENVIO_ASSINATURA', 'CONFIRMADA', 'AGUARDANDO_ASSINATURA'].includes(solicitacao.status)) {
        throw new ErroNegocio('Esta solicitação não está apta para envio de assinatura.', 409)
      }

      // Reenvio (Etapa fix/signature-resend): quando o status lido já é
      // AGUARDANDO_ASSINATURA, este POST é um REENVIO do link já enviado
      // antes (não um primeiro envio) — mesma rota, sem transição real de
      // status. Usado só para escolher a redação do histórico/notificação
      // abaixo; a concorrência é resolvida pelos dois gates (ver comentário
      // no topo do arquivo), não por este flag.
      const isReenvio = solicitacao.status === 'AGUARDANDO_ASSINATURA'

      // GATE 1 — ver comentário no topo do arquivo. `updatedAt` é lido do
      // MESMO `solicitacao` acima, nunca uma segunda leitura (evitaria
      // reintroduzir a janela que este gate existe para fechar).
      const atualizadas = await tx.solicitacao.updateMany({
        where: { id, status: solicitacao.status, updatedAt: solicitacao.updatedAt },
        data: { status: 'AGUARDANDO_ASSINATURA' },
      })

      if (atualizadas.count === 0) {
        // Reconsulta OBRIGATÓRIA: distingue "solicitação removida" (404) de
        // "outra chamada já efetivou uma transição/reenvio" (409) — nunca
        // gravado efeito colateral (nem `assinatura.upsert`) para a chamada
        // que perdeu a corrida.
        const atual = await tx.solicitacao.findUnique({ where: { id }, select: { status: true } })
        if (!atual) throw new ErroNegocio('Solicitação não encontrada.', 404)
        throw new ErroNegocio('Esta solicitação já foi atualizada por outra operação. Atualize a página.', 409)
      }

      // Lido AGORA (dentro da transação, depois do Gate 1 confirmado) —
      // fornece `solicitante.email` (chave do EmailEvento, necessária para
      // o Gate 2 logo abaixo) e os dados para o snapshot do payload.
      // Reaproveitado também para a resposta final da rota mais abaixo.
      const dadosSolicitacao = await tx.solicitacao.findUniqueOrThrow({
        where: { id },
        include: {
          solicitante: { select: { nome: true, email: true } },
          itensPatrimonio: { include: { patrimonio: { select: { numero: true, marca: true, modelo: true, categoria: { select: { nome: true } } } } } },
          itensPapelaria: { select: { descricao: true, quantidade: true } },
          itensServico: { include: { tipoServico: { select: { nome: true } } } },
        },
      })

      const dadosParaSnapshot: ConstruirPayloadAssinaturaPendenteInput = {
        numero: dadosSolicitacao.numero,
        nomeSolicitante: dadosSolicitacao.solicitante.nome,
        data: dadosSolicitacao.data,
        periodos: dadosSolicitacao.periodos,
        finalidade: dadosSolicitacao.finalidade,
        atividadeExterna: dadosSolicitacao.atividadeExterna,
        local: dadosSolicitacao.local,
        cidade: dadosSolicitacao.cidade,
        observacoes: dadosSolicitacao.observacoes,
        itensPatrimonio: dadosSolicitacao.itensPatrimonio.map((item) => ({
          numero: item.patrimonio.numero,
          marca: item.patrimonio.marca,
          modelo: item.patrimonio.modelo,
          categoria: item.patrimonio.categoria.nome,
        })),
        itensPapelaria: dadosSolicitacao.itensPapelaria,
        itensServico: dadosSolicitacao.itensServico.map((item) => ({
          tipoServicoNome: item.tipoServico.nome,
          quantidade: item.quantidade,
          ambiente: item.ambiente,
        })),
        notebooksComDominio: dadosSolicitacao.notebooksComDominio,
        tipoDominio: dadosSolicitacao.tipoDominio,
      }

      // GATE 2 — ver comentário no topo do arquivo. Roda ANTES de qualquer
      // efeito colateral definitivo (Assinatura, histórico, notificação):
      // se rejeitar, lança e a transação inteira é revertida pelo Prisma —
      // inclusive a auto-transição do Gate 1 acima — então uma chamada
      // rejeitada aqui nunca persiste NADA (ver "ORDEM DA TRANSAÇÃO" na
      // auditoria: nenhum rollback parcial é possível).
      //
      // Só ENVIADO, FALHA e OBSOLETO são elegíveis para reabertura:
      // - FALHA/OBSOLETO: o provedor NUNCA confirmou entrega para a
      //   tentativa anterior — FALHA pode ser uma rejeição definitiva OU um
      //   timeout/erro de rede depois de o provedor já ter aceitado a
      //   requisição (a aplicação não distingue os dois — ver send-email.ts
      //   /providers/resend.ts, que colapsam qualquer exceção no mesmo
      //   `success:false` genérico); OBSOLETO é histórico (só ocorreria se,
      //   em algum momento, a solicitação tivesse saído de AGUARDANDO_
      //   ASSINATURA — mas a máquina de estados em src/lib/status.ts não
      //   tem NENHUMA transição de volta para AGUARDANDO_ASSINATURA a
      //   partir de ASSINATURA_CONFIRMADA/CANCELADA, então isso nunca
      //   coexiste de verdade com o Gate 1 já confirmado; incluído mesmo
      //   assim, defensivamente, com a MESMA semântica de FALHA: nunca
      //   houve entrega física confirmada).
      // - ENVIADO: a ÚNICA reabertura que representa uma intenção lógica
      //   NOVA de verdade — o provedor CONFIRMOU a entrega da tentativa
      //   anterior, então um reenvio a partir daqui é deliberadamente um
      //   segundo e-mail físico, não uma repetição de algo incerto.
      // - PENDENTE/PROCESSANDO: NUNCA reabertos — um reenvio já está
      //   enfileirado ou em voo; rebobiná-lo furaria o claim atômico de
      //   processarEmailEvento() (duas reivindicações concorrentes do MESMO
      //   evento).
      //
      // GERAÇÃO LÓGICA (Etapa fix/signature-resend — 2ª rodada, correção da
      // auditoria de idempotência): a distinção acima (FALHA/OBSOLETO vs
      // ENVIADO) decide se a REABERTURA preserva ou incrementa a "geração"
      // gravada no payload (ver AssinaturaPendentePayloadV1.geracao e o
      // comentário completo em processar-evento.ts::idempotencyKeyParaEvento).
      // Resumo: reabrir de FALHA/OBSOLETO preserva a MESMA geração (retry
      // técnico do mesmo envio lógico, incerto se já foi entregue — a chave
      // de idempotência DEVE continuar igual); reabrir de ENVIADO incrementa
      // (reenvio explícito de algo já confirmado entregue — a chave DEVE
      // mudar, para não depender de o provedor deduplicar). `tentativas`
      // (inalterado) continua sendo só o contador técnico de claims — nunca
      // usado para decidir geração.
      const ESTADOS_ELEGIVEIS_PARA_REARME: StatusEmailEvento[] = ['ENVIADO', 'FALHA', 'OBSOLETO']
      const MENSAGEM_ENVIO_EM_ANDAMENTO = 'Já existe um envio de assinatura em andamento para esta solicitação. Aguarde a conclusão e tente novamente.'

      const eventoExistente = await tx.emailEvento.findUnique({
        where: {
          solicitacaoId_tipo_destinatario: {
            solicitacaoId: id,
            tipo: 'ASSINATURA_PENDENTE',
            destinatario: dadosSolicitacao.solicitante.email,
          },
        },
        select: { id: true, status: true, payload: true },
      })

      let eventoId: string
      let payload: ReturnType<typeof construirPayloadAssinaturaPendente>
      if (!eventoExistente) {
        // Nenhum EmailEvento ainda para esta chave — primeiro envio real,
        // ou solicitação antiga (anterior a esta etapa) sem evento algum.
        // Geração inicial: 1. `create` simples é seguro aqui: só esta rota
        // cria eventos ASSINATURA_PENDENTE, e o Gate 1 acima já garante
        // posse exclusiva desta solicitação para toda a duração da
        // transação (o lock da linha de Solicitacao, adquirido pelo
        // updateMany do Gate 1, só é liberado no commit/rollback — nenhuma
        // outra chamada concorrente para o MESMO id chega a rodar este
        // trecho ao mesmo tempo).
        payload = construirPayloadAssinaturaPendente(dadosParaSnapshot, 1)
        const criado = await tx.emailEvento.create({
          data: {
            solicitacaoId: id,
            tipo: 'ASSINATURA_PENDENTE',
            destinatario: dadosSolicitacao.solicitante.email,
            status: 'PENDENTE',
            tentativas: 0,
            payload: payload as unknown as Prisma.InputJsonValue,
          },
        })
        eventoId = criado.id
      } else if (eventoExistente.status === 'PENDENTE' || eventoExistente.status === 'PROCESSANDO') {
        throw new ErroNegocio(MENSAGEM_ENVIO_EM_ANDAMENTO, 409)
      } else {
        // Geração: preserva se reabrindo de FALHA/OBSOLETO (retry técnico
        // do mesmo envio lógico, possivelmente ambíguo — ver comentário
        // acima), incrementa se reabrindo de ENVIADO (reenvio explícito de
        // algo já confirmado entregue). Lida do payload ATUAL do evento
        // (genérico, sem parser específico — mesma função usada por
        // processar-evento.ts, garantindo que os dois lados nunca
        // divirjam sobre o que "geração" significa).
        const geracaoAnterior = geracaoIdempotenciaDoPayload(eventoExistente.payload)
        const geracao = eventoExistente.status === 'ENVIADO' ? geracaoAnterior + 1 : geracaoAnterior
        payload = construirPayloadAssinaturaPendente(dadosParaSnapshot, geracao)

        // Reabertura atômica: o WHERE condiciona a transição ao estado
        // elegível LIDO ACIMA — se, entre esta leitura e esta escrita,
        // outra coisa já tiver mudado o status (ex.: processarEmailEvento()
        // do lado de fora de uma chamada anterior acabou de reivindicar o
        // evento e ele não está mais em um estado elegível), `count` vem 0
        // e tratamos como conflito, nunca como sucesso silencioso.
        const rearmadas = await tx.emailEvento.updateMany({
          where: { id: eventoExistente.id, status: { in: ESTADOS_ELEGIVEIS_PARA_REARME } },
          data: { status: 'PENDENTE', erro: null, enviadoEm: null, payload: payload as unknown as Prisma.InputJsonValue },
        })
        if (rearmadas.count === 0) {
          throw new ErroNegocio(MENSAGEM_ENVIO_EM_ANDAMENTO, 409)
        }
        eventoId = eventoExistente.id
      }

      // A partir daqui, os dois gates já confirmaram que esta é a ÚNICA
      // chamada com permissão para gravar os efeitos deste reenvio/envio.
      await tx.assinatura.upsert({
        where: { solicitacaoId: id },
        create: {
          solicitacaoId: id,
          link: parsed.data.link,
          enviadoPorId: validacao.user.id,
          enviadoEm: new Date(),
        },
        update: {
          link: parsed.data.link,
          enviadoPorId: validacao.user.id,
          enviadoEm: new Date(),
        },
      })

      await registrarHistorico(tx, {
        solicitacaoId: id,
        usuarioId: validacao.user.id,
        acao: isReenvio ? 'REENVIO_LINK_ASSINATURA' : 'ENVIO_LINK_ASSINATURA',
        statusAnterior: solicitacao.status,
        statusNovo: 'AGUARDANDO_ASSINATURA',
        descricao: isReenvio
          ? `Link de assinatura reenviado por ${validacao.user.nome}.`
          : `Link de assinatura encaminhado por ${validacao.user.nome}.`,
      })

      await criarNotificacao(tx, {
        usuarioId: solicitacao.solicitanteId,
        solicitacaoId: id,
        titulo: 'Assinatura de documentos pendente',
        mensagem: isReenvio
          ? `O link de assinatura da sua solicitação #${solicitacao.numero} foi reenviado. Realize a assinatura dos documentos para retirada dos equipamentos.`
          : `Sua solicitação #${solicitacao.numero} foi confirmada. Realize a assinatura dos documentos para retirada dos equipamentos.`,
        tipo: 'ASSINATURA_PENDENTE',
      })

      // Só disponível agora (após os dois gates confirmados) — mesmo padrão
      // de /cancelar.
      const atualizada = await tx.solicitacao.findUniqueOrThrow({ where: { id } })

      return { atualizada, eventoId, payload }
    })

    // Fora da transação (mesmo padrão de /confirmar-patrimonio,
    // /assinatura/confirmar e POST /api/solicitacoes — ver comentários
    // lá): a intenção de envio já foi commitada como EmailEvento PENDENTE
    // junto do envio/reenvio do link de assinatura. Fonte exclusiva: o
    // payload já persistido no commit — nunca reconstruído a partir de
    // `resultado.atualizada`. aindaValido protege contra a janela entre o
    // commit e este envio: se a assinatura já tiver sido confirmada ou a
    // solicitação cancelada nesse meio-tempo, o evento vira OBSOLETO em vez
    // de notificar uma pendência que já não existe mais.
    //
    // idempotencyKeyParaEvento (Etapa fix/signature-resend — 2ª rodada,
    // correção da auditoria de idempotência) agora usa a "geração lógica"
    // gravada no payload por este Gate 2 (nunca `tentativas`) — reabrir de
    // ENVIADO gera uma chave de idempotência DIFERENTE perante o provedor
    // (reenvio explícito não depende de o Resend deduplicar um envio já
    // confirmado); reabrir de FALHA/OBSOLETO preserva a MESMA chave (retry
    // de um resultado incerto continua protegido contra entrega física
    // duplicada). Ver src/lib/email/processar-evento.ts.
    await processarEmailEvento(
      resultado.eventoId,
      (ctx) => renderAssinaturaPendenteFromPayload(resultado.payload, buildAppUrl(`/solicitacoes/${id}`), ctx.bannerDestinatarioOriginal),
      { aindaValido: criarValidadorDeEvento('ASSINATURA_PENDENTE', id) ?? undefined }
    )

    return NextResponse.json({ solicitacao: resultado.atualizada }, { status: 200 })
  } catch (e) {
    if (e instanceof ErroNegocio) return NextResponse.json({ message: e.message }, { status: e.status })
    console.error(e)
    return NextResponse.json({ message: 'Erro interno no servidor.' }, { status: 500 })
  }
}
