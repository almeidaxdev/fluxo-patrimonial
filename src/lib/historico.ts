// src/lib/historico.ts
import { Prisma } from '@prisma/client'

type TxClient = Prisma.TransactionClient

interface RegistrarHistoricoInput {
  solicitacaoId: string
  usuarioId?: string | null
  acao: string
  statusAnterior?: string | null
  statusNovo?: string | null
  descricao?: string | null
  metadata?: Record<string, unknown>
}

/**
 * Registra um evento imutável na timeline da solicitação.
 * Deve ser chamado sempre dentro da mesma transação da ação que o originou.
 */
export async function registrarHistorico(tx: TxClient, input: RegistrarHistoricoInput) {
  return tx.historicoSolicitacao.create({
    data: {
      solicitacaoId: input.solicitacaoId,
      usuarioId: input.usuarioId ?? null,
      acao: input.acao,
      statusAnterior: input.statusAnterior ?? null,
      statusNovo: input.statusNovo ?? null,
      descricao: input.descricao ?? null,
      metadata: input.metadata as Prisma.InputJsonValue | undefined,
    },
  })
}
