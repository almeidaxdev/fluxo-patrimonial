// src/app/api/solicitacoes/[id]/rejeitar-gestor/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getValidatedMutationSession } from '@/lib/session-validation'
import { podeTransitar } from '@/lib/status'
import { registrarHistorico } from '@/lib/historico'
import { criarNotificacao } from '@/lib/notificacoes'
import { rejeitarSchema } from '@/lib/validations'
import { parseJsonBody } from '@/lib/http'
import { buildAppUrl, processarEmailEvento, criarValidadorDeEvento } from '@/lib/email'
import { construirPayloadRejeicao, renderRejeicaoFromPayload, type ConstruirPayloadRejeicaoInput } from '@/lib/email/payloads/rejeicao'
import { ErroNegocio } from '@/lib/erros'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const validacao = await getValidatedMutationSession()
  if (!validacao.valido) return validacao.resposta

  const { id } = await params

  try {
    const corpo = await parseJsonBody(req)
    if (!corpo.ok) return corpo.resposta
    const parsed = rejeitarSchema.safeParse(corpo.data)
    if (!parsed.success) {
      return NextResponse.json({ message: parsed.error.errors[0]?.message ?? 'Justificativa é obrigatória.' }, { status: 400 })
    }

    const resultado = await prisma.$transaction(async (tx) => {
      const solicitacao = await tx.solicitacao.findUnique({ where: { id } })
      if (!solicitacao) throw new ErroNegocio('Solicitação não encontrada.', 404)

      if (solicitacao.gestorId !== validacao.user.id) {
        throw new ErroNegocio('Você não possui permissão para rejeitar esta solicitação.', 403)
      }
      if (!podeTransitar(solicitacao.status, 'REJEITADA_GESTOR')) {
        throw new ErroNegocio('Esta solicitação não está mais aguardando decisão do gestor.', 409)
      }

      // Concorrência (Etapa fix/atomic-request-transitions — mesmo padrão
      // já usado em /cancelar): o update condicional só pode casar o status
      // EXATO lido acima — se qualquer transição concorrente mudou o
      // status entre a leitura e este update, a atualização casa 0 linhas e
      // a rota devolve 409 em vez de registrar histórico/notificação/e-mail
      // duplicados para uma corrida perdida.
      const atualizadas = await tx.solicitacao.updateMany({
        where: { id, status: solicitacao.status },
        data: { status: 'REJEITADA_GESTOR', gestorDecisaoEm: new Date(), motivoRejeicaoGestor: parsed.data.motivo },
      })

      if (atualizadas.count === 0) {
        // Reconsulta OBRIGATÓRIA: distingue "solicitação removida" (404) de
        // "outra chamada já efetivou uma transição" (409) — nunca gravado
        // efeito colateral para a chamada que perdeu a corrida.
        const atual = await tx.solicitacao.findUnique({ where: { id }, select: { status: true } })
        if (!atual) throw new ErroNegocio('Solicitação não encontrada.', 404)
        throw new ErroNegocio('Esta solicitação já foi atualizada por outra operação. Atualize a página.', 409)
      }

      await registrarHistorico(tx, {
        solicitacaoId: id,
        usuarioId: validacao.user.id,
        acao: 'REJEICAO_GESTOR',
        statusAnterior: solicitacao.status,
        statusNovo: 'REJEITADA_GESTOR',
        descricao: `Rejeitada pelo gestor ${validacao.user.nome}. Motivo: ${parsed.data.motivo}`,
      })

      await criarNotificacao(tx, {
        usuarioId: solicitacao.solicitanteId,
        solicitacaoId: id,
        titulo: 'Solicitação rejeitada pelo gestor',
        mensagem: `Sua solicitação #${solicitacao.numero} foi rejeitada. Motivo: ${parsed.data.motivo}`,
        tipo: 'REJEICAO_GESTOR',
      })

      // Etapa email-rejeicoes: snapshot histórico (mesmo padrão das
      // features de e-mail anteriores) — dados lidos AGORA, dentro da
      // transação. Leitura separada (não reaproveita `atualizada`, sem os
      // includes necessários) para não alterar o formato da resposta desta
      // rota.
      const dadosSolicitacao = await tx.solicitacao.findUniqueOrThrow({
        where: { id },
        include: {
          solicitante: { select: { nome: true, email: true } },
          itensPatrimonio: { include: { patrimonio: { select: { numero: true, marca: true, modelo: true, categoria: { select: { nome: true } } } } } },
          itensPapelaria: { select: { descricao: true, quantidade: true } },
          itensServico: { include: { tipoServico: { select: { nome: true } } } },
        },
      })

      const dadosParaSnapshot: ConstruirPayloadRejeicaoInput = {
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
        motivo: parsed.data.motivo,
      }
      const payload = construirPayloadRejeicao(dadosParaSnapshot, 'gestor')

      // Idempotência: upsert atômico na unique [solicitacaoId, tipo,
      // destinatario] — nunca uma unique violation virando 500; se o
      // evento já existir (nova chamada, corrida), `update: {}` não o toca.
      const evento = await tx.emailEvento.upsert({
        where: {
          solicitacaoId_tipo_destinatario: {
            solicitacaoId: id,
            tipo: 'REJEICAO_GESTOR',
            destinatario: dadosSolicitacao.solicitante.email,
          },
        },
        create: {
          solicitacaoId: id,
          tipo: 'REJEICAO_GESTOR',
          destinatario: dadosSolicitacao.solicitante.email,
          status: 'PENDENTE',
          tentativas: 0,
          payload: payload as unknown as Prisma.InputJsonValue,
        },
        update: {},
      })

      // Só disponível agora (após a transição atômica confirmada acima) —
      // mesmo padrão de /cancelar.
      const atualizada = await tx.solicitacao.findUniqueOrThrow({ where: { id } })

      return { atualizada, eventoId: evento.id, payload }
    })

    // Fora da transação (mesmo padrão das features de e-mail anteriores):
    // sem `aindaValido` (REJEITADA_GESTOR é status terminal — ver
    // validade-evento.ts).
    await processarEmailEvento(
      resultado.eventoId,
      (ctx) => renderRejeicaoFromPayload(resultado.payload, buildAppUrl(`/solicitacoes/${id}`), ctx.bannerDestinatarioOriginal),
      { aindaValido: criarValidadorDeEvento('REJEICAO_GESTOR', id) ?? undefined }
    )

    return NextResponse.json({ solicitacao: resultado.atualizada }, { status: 200 })
  } catch (e) {
    if (e instanceof ErroNegocio) return NextResponse.json({ message: e.message }, { status: e.status })
    console.error(e)
    return NextResponse.json({ message: 'Erro interno no servidor.' }, { status: 500 })
  }
}
