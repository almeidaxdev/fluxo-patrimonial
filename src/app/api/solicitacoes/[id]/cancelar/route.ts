// src/app/api/solicitacoes/[id]/cancelar/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getValidatedMutationSession } from '@/lib/session-validation'
import { isPatrimonioOuAdmin } from '@/lib/permissions'
import { statusOrigemPermitidos } from '@/lib/status'
import { registrarHistorico } from '@/lib/historico'
import { criarNotificacao } from '@/lib/notificacoes'
import { buildAppUrl, processarEmailEvento, criarValidadorDeEvento } from '@/lib/email'
import { construirPayloadCancelamento, renderCancelamentoFromPayload, type ConstruirPayloadCancelamentoInput, type CancelamentoPayloadV1 } from '@/lib/email/payloads/cancelamento'
import { deduplicarDestinatarios, resolverEmailPatrimonioOuNull, type DestinatarioReservaConfirmada } from '@/lib/email/destinatarios'
import { ErroNegocio } from '@/lib/erros'
import type { StatusSolicitacao } from '@/types'

// Todos os status a partir dos quais CANCELADA é hoje permitida (Etapa
// 9A-B — correção de concorrência), derivado de TRANSICOES_PERMITIDAS
// (src/lib/status.ts) — nunca hardcoded aqui, para nunca divergir da regra
// de negócio vigente se a matriz de transições mudar.
const STATUS_ORIGEM_CANCELAMENTO = statusOrigemPermitidos('CANCELADA')

// Etapa email-cancelamento — quais status ANTERIORES ao cancelamento
// indicam que o Patrimônio já está operacionalmente envolvido (preparação
// física/retirada), e portanto deve ser avisado por e-mail:
//
// - ASSINATURA_CONFIRMADA: a notificação in-app já enviada a toda a
//   equipe Patrimônio neste status (ver /assinatura/confirmar) diz
//   literalmente "Pode seguir para separação" — equivalente, no fluxo
//   externo, ao instante em que o fluxo interno entra em EM_SEPARACAO.
// - EM_SEPARACAO: equipamentos sendo fisicamente separados.
// - PRONTA_RETIRADA: equipamentos já separados, aguardando retirada.
//
// Deliberadamente EXCLUÍDOS (cancelamento "inicial", só o solicitante
// recebe — confirmado pelo pedido, não assumido):
// - AGUARDANDO_GESTOR / AGUARDANDO_PATRIMONIO: decisão ainda não tomada,
//   nenhum trabalho físico do Patrimônio começou.
// - AGUARDANDO_ENVIO_ASSINATURA / AGUARDANDO_ASSINATURA: reserva já
//   confirmada pelo Patrimônio, mas ainda aguardando a etapa documental —
//   nenhuma preparação física começou (só começa em ASSINATURA_CONFIRMADA).
// - CONFIRMADA: achado da investigação — este status é hoje INALCANÇÁVEL
//   na prática (nenhuma rota grava `status: 'CONFIRMADA'`; /confirmar-patrimonio
//   pula direto para EM_SEPARACAO ou AGUARDANDO_ENVIO_ASSINATURA — ver
//   aquela rota). Mantido fora da lista por segurança/simetria com
//   AGUARDANDO_ENVIO_ASSINATURA (mesma fase conceitual: reserva confirmada,
//   preparação física ainda não iniciada), documentado aqui caso volte a
//   ser um status real no futuro.
//
// EM_UTILIZACAO não aparece nem como origem possível: `TRANSICOES_PERMITIDAS['EM_UTILIZACAO']`
// só permite ['FINALIZADA'] (src/lib/status.ts) — cancelamento não é
// possível a partir desse status, então não há decisão a tomar aqui.
const STATUS_ANTERIOR_PATRIMONIO_OPERACIONAL: readonly StatusSolicitacao[] = ['ASSINATURA_CONFIRMADA', 'EM_SEPARACAO', 'PRONTA_RETIRADA']

// Cancelamento: permitido ao solicitante (enquanto ainda não finalizada/em
// utilização) ou ao Patrimônio/administrador a qualquer momento anterior à
// finalização.
//
// Concorrência (P2 do Codex Review): o update condicional só pode casar o
// status EXATO lido inicialmente (`status: solicitacao.status`), nunca
// "qualquer status ainda cancelável" — se qualquer transição concorrente
// mudou o status entre a leitura e o update (mesmo para outro status que
// também permitiria cancelamento, ex.: CONFIRMADA → EM_SEPARACAO), o
// updateMany casa 0 linhas e a rota devolve 409 em vez de gravar um
// `statusAnterior` desatualizado no histórico. Isso é mais estrito que
// "qualquer status cancelável no momento do update" (opção descartada) —
// prioriza previsibilidade e auditoria exata sobre deixar o cancelamento
// vencer após uma transição concorrente para outro status também cancelável.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const validacao = await getValidatedMutationSession()
  if (!validacao.valido) return validacao.resposta

  const { id } = await params

  try {
    const resultado = await prisma.$transaction(async (tx) => {
      // Leitura prévia para dados imutáveis (solicitanteId, numero), a
      // checagem de PERMISSÃO, e o status que será exigido pelo update
      // atômico logo abaixo — nunca usado sozinho para decidir a transição.
      const solicitacao = await tx.solicitacao.findUnique({
        where: { id },
        select: { solicitanteId: true, numero: true, status: true },
      })
      if (!solicitacao) throw new ErroNegocio('Solicitação não encontrada.', 404)

      const podeCancelar = solicitacao.solicitanteId === validacao.user.id || isPatrimonioOuAdmin(validacao.user)
      if (!podeCancelar) throw new ErroNegocio('Você não possui permissão para cancelar esta solicitação.', 403)

      if (!STATUS_ORIGEM_CANCELAMENTO.includes(solicitacao.status)) {
        throw new ErroNegocio('Esta solicitação não pode mais ser cancelada.', 409)
      }

      // Só efetua o cancelamento se o status ATUAL da linha, no exato
      // momento do UPDATE, ainda for o mesmo lido acima — garante que
      // `statusAnterior` no histórico é sempre o status real substituído,
      // nunca um valor obtido antes de uma transição concorrente.
      const atualizadas = await tx.solicitacao.updateMany({
        where: { id, status: solicitacao.status },
        data: { status: 'CANCELADA' },
      })

      if (atualizadas.count === 0) {
        // Reconsulta OBRIGATÓRIA: o estado mudou entre a requisição chegar
        // e o updateMany rodar (ex.: retirada, "não retirado" ou outra
        // transição registrados concorrentemente).
        const atual = await tx.solicitacao.findUnique({ where: { id }, select: { status: true } })
        if (!atual) throw new ErroNegocio('Solicitação não encontrada.', 404)
        throw new ErroNegocio('Esta solicitação não pode mais ser cancelada.', 409)
      }

      // Histórico e notificação só rodam depois de confirmado que ESTA
      // requisição efetuou a transição (atualizadas.count === 1) — nunca
      // são criados para uma tentativa que perdeu a corrida.
      await registrarHistorico(tx, {
        solicitacaoId: id,
        usuarioId: validacao.user.id,
        acao: 'CANCELAMENTO',
        statusAnterior: solicitacao.status,
        statusNovo: 'CANCELADA',
        descricao: `Cancelada por ${validacao.user.nome}.`,
      })

      if (solicitacao.solicitanteId !== validacao.user.id) {
        await criarNotificacao(tx, {
          usuarioId: solicitacao.solicitanteId,
          solicitacaoId: id,
          titulo: 'Solicitação cancelada',
          mensagem: `Sua solicitação #${solicitacao.numero} foi cancelada.`,
          tipo: 'CANCELAMENTO',
        })
      }

      // Etapa email-cancelamento: snapshot histórico (mesmo padrão das
      // features de e-mail anteriores) — dados lidos AGORA, dentro da
      // transação. Leitura separada (não reaproveita a leitura enxuta
      // acima) para trazer os includes necessários ao payload, sem alterar
      // o formato da resposta desta rota.
      const dadosSolicitacao = await tx.solicitacao.findUniqueOrThrow({
        where: { id },
        include: {
          solicitante: { select: { nome: true, email: true } },
          itensPatrimonio: { include: { patrimonio: { select: { numero: true, marca: true, modelo: true, categoria: { select: { nome: true } } } } } },
          itensPapelaria: { select: { descricao: true, quantidade: true } },
          itensServico: { include: { tipoServico: { select: { nome: true } } } },
        },
      })

      const dadosParaSnapshot: ConstruirPayloadCancelamentoInput = {
        numero: dadosSolicitacao.numero,
        nomeSolicitante: dadosSolicitacao.solicitante.nome,
        tipoEmprestimo: dadosSolicitacao.tipoEmprestimo,
        data: dadosSolicitacao.data,
        periodos: dadosSolicitacao.periodos,
        ambiente: dadosSolicitacao.ambiente,
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
        canceladoPorNome: validacao.user.nome,
        // A rota ainda não recebe/persiste motivo de cancelamento (achado
        // da investigação — ver comentário no topo de payloads/cancelamento.ts).
        // Sempre `null` neste momento; nunca um valor inventado.
        motivo: null,
      }

      // Regra de destinatários do Patrimônio (item 3 do pedido): só avisa
      // a equipe Patrimônio quando o status ANTERIOR ao cancelamento
      // (capturado ACIMA, em `solicitacao.status`, antes do updateMany —
      // nunca reconsultado depois) indica que o Patrimônio já estava
      // operacionalmente envolvido — ver STATUS_ANTERIOR_PATRIMONIO_OPERACIONAL
      // no topo do arquivo.
      // Caixa de grupo do Patrimônio (Etapa email-patrimonio-caixa-grupo):
      // `patrimonioElegivel` continua exatamente a mesma regra de negócio
      // de sempre (status ANTERIOR ao cancelamento indica envolvimento
      // operacional do Patrimônio — ver STATUS_ANTERIOR_PATRIMONIO_OPERACIONAL
      // acima); só QUEM recebe mudou — não mais uma query trazendo os
      // e-mails de cada membro ativo, e sim o endereço fixo de
      // EMAIL_PATRIMONIO_RECIPIENT quando elegível.
      const patrimonioElegivel = STATUS_ANTERIOR_PATRIMONIO_OPERACIONAL.includes(solicitacao.status)
      const emailPatrimonio = patrimonioElegivel ? resolverEmailPatrimonioOuNull('CANCELAMENTO') : null

      // Mesmo helper de dedup usado por RESERVA_CONFIRMADA (Etapa D.3.3 —
      // ver src/lib/email/destinatarios.ts): garante que o solicitante
      // nunca recebe dois e-mails se o endereço coincidir com o da caixa
      // de grupo (SOLICITANTE prevalece — item 6 do pedido).
      const destinatarios: DestinatarioReservaConfirmada[] = deduplicarDestinatarios(dadosSolicitacao.solicitante.email, emailPatrimonio)

      const eventosCriados: { eventoId: string; payload: CancelamentoPayloadV1 }[] = []
      for (const destinatario of destinatarios) {
        const payload = construirPayloadCancelamento(dadosParaSnapshot, destinatario.papel)

        // Idempotência: upsert atômico na unique [solicitacaoId, tipo,
        // destinatario] — nunca uma unique violation virando 500.
        const evento = await tx.emailEvento.upsert({
          where: {
            solicitacaoId_tipo_destinatario: {
              solicitacaoId: id,
              tipo: 'CANCELAMENTO',
              destinatario: destinatario.email,
            },
          },
          create: {
            solicitacaoId: id,
            tipo: 'CANCELAMENTO',
            destinatario: destinatario.email,
            status: 'PENDENTE',
            tentativas: 0,
            payload: payload as unknown as Prisma.InputJsonValue,
          },
          update: {},
        })
        eventosCriados.push({ eventoId: evento.id, payload })
      }

      const atualizada = await tx.solicitacao.findUniqueOrThrow({ where: { id } })
      return { atualizada, eventosCriados }
    })

    // Fora da transação (mesmo padrão de /confirmar-patrimonio e
    // /assinatura/confirmar): a intenção de envio já foi commitada como
    // EmailEvento(s) PENDENTE junto do cancelamento. allSettled (não
    // Promise.all) — um destinatário nunca pode fazer a resposta desta
    // rota virar 500 por causa de e-mail (processarEmailEvento() já nunca
    // lança, mas allSettled é defesa extra contra qualquer exceção
    // verdadeiramente inesperada).
    const resultadosEnvio = await Promise.allSettled(
      resultado.eventosCriados.map((evento) =>
        processarEmailEvento(
          evento.eventoId,
          (ctx) => renderCancelamentoFromPayload(evento.payload, buildAppUrl(`/solicitacoes/${id}`), ctx.bannerDestinatarioOriginal),
          { aindaValido: criarValidadorDeEvento('CANCELAMENTO', id) ?? undefined }
        )
      )
    )
    for (const envio of resultadosEnvio) {
      if (envio.status === 'rejected') {
        console.error(
          'CANCELAMENTO: falha inesperada ao processar e-mail pós-commit (cancelamento de negócio não é afetado):',
          envio.reason instanceof Error ? envio.reason.message : envio.reason
        )
      }
    }

    return NextResponse.json({ solicitacao: resultado.atualizada }, { status: 200 })
  } catch (e) {
    if (e instanceof ErroNegocio) return NextResponse.json({ message: e.message }, { status: e.status })
    console.error(e)
    return NextResponse.json({ message: 'Erro interno no servidor.' }, { status: 500 })
  }
}
