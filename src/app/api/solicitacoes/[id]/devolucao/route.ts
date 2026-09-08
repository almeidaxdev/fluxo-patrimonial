// src/app/api/solicitacoes/[id]/devolucao/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getValidatedMutationSession } from '@/lib/session-validation'
import { isPatrimonioOuAdmin } from '@/lib/permissions'
import { registrarHistorico } from '@/lib/historico'
import { criarNotificacao } from '@/lib/notificacoes'
import { devolucaoSchema } from '@/lib/validations'
import { parseJsonBody } from '@/lib/http'
import { ErroNegocio } from '@/lib/erros'
import { CONDICAO_DEVOLUCAO_LABELS } from '@/types'

// Concorrência (Etapa 9A-C, mesmo padrão da Etapa 9A-B): o `updateMany`
// abaixo é a única fonte de verdade sobre a transição — não um
// `findUnique` prévio seguido de `update` incondicional. `status:
// 'EM_UTILIZACAO'` é o único status de origem permitido para FINALIZADA em
// TRANSICOES_PERMITIDAS (src/lib/status.ts). Duas devoluções simultâneas
// (ou uma devolução concorrendo com qualquer outra transição que tire a
// solicitação de EM_UTILIZACAO): o segundo `updateMany` a rodar sempre casa
// 0 linhas sob READ COMMITTED, e a rota devolve 409.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const validacao = await getValidatedMutationSession()
  if (!validacao.valido) return validacao.resposta
  if (!isPatrimonioOuAdmin(validacao.user)) return NextResponse.json({ message: 'Sem permissão.' }, { status: 403 })

  const { id } = await params

  try {
    const corpo = await parseJsonBody(req)
    if (!corpo.ok) return corpo.resposta
    const parsed = devolucaoSchema.safeParse(corpo.data)
    if (!parsed.success) {
      return NextResponse.json({ message: parsed.error.errors[0]?.message ?? 'Dados inválidos.' }, { status: 400 })
    }

    const resultado = await prisma.$transaction(async (tx) => {
      const atualizadas = await tx.solicitacao.updateMany({
        where: { id, status: 'EM_UTILIZACAO' },
        data: {
          status: 'FINALIZADA',
          devolucaoEm: new Date(),
          devolucaoPorId: validacao.user.id,
          devolucaoCondicao: parsed.data.condicao,
          devolucaoObs: parsed.data.observacoes,
        },
      })

      if (atualizadas.count === 0) {
        // Reconsulta OBRIGATÓRIA: o estado pode ter mudado entre a
        // requisição chegar e o updateMany rodar (ex.: outra devolução
        // registrada concorrentemente).
        const atual = await tx.solicitacao.findUnique({ where: { id }, select: { status: true } })
        if (!atual) throw new ErroNegocio('Solicitação não encontrada.', 404)
        throw new ErroNegocio('Esta solicitação não está em utilização.', 409)
      }

      const atualizada = await tx.solicitacao.findUniqueOrThrow({ where: { id } })

      // Histórico e notificação só rodam depois de confirmado que ESTA
      // requisição efetuou a transição (atualizadas.count === 1) — nunca
      // são criados para uma tentativa que perdeu a corrida.
      await registrarHistorico(tx, {
        solicitacaoId: id,
        usuarioId: validacao.user.id,
        acao: 'DEVOLUCAO',
        statusAnterior: 'EM_UTILIZACAO',
        statusNovo: 'FINALIZADA',
        descricao: `Devolução registrada por ${validacao.user.nome}. Condição: ${CONDICAO_DEVOLUCAO_LABELS[parsed.data.condicao]}.`,
      })

      await criarNotificacao(tx, {
        usuarioId: atualizada.solicitanteId,
        solicitacaoId: id,
        titulo: 'Devolução concluída',
        mensagem: `A devolução dos itens da solicitação #${atualizada.numero} foi concluída. Obrigado!`,
        tipo: 'DEVOLUCAO',
      })

      return atualizada
    })

    return NextResponse.json({ solicitacao: resultado }, { status: 200 })
  } catch (e) {
    if (e instanceof ErroNegocio) return NextResponse.json({ message: e.message }, { status: e.status })
    console.error(e)
    return NextResponse.json({ message: 'Não foi possível registrar a devolução. Atualize a página e tente novamente.' }, { status: 500 })
  }
}
