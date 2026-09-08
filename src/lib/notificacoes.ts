// src/lib/notificacoes.ts
import { Prisma } from '@prisma/client'

type TxClient = Prisma.TransactionClient

interface CriarNotificacaoInput {
  usuarioId: string
  titulo: string
  mensagem: string
  solicitacaoId?: string | null
  link?: string | null
  tipo?: string | null
}

/**
 * Cria uma notificação interna. Deve ser chamada a partir de eventos de
 * domínio (mudanças de status, aprovações, etc.), nunca duplicada em telas.
 */
export async function criarNotificacao(tx: TxClient, input: CriarNotificacaoInput) {
  return tx.notificacao.create({
    data: {
      usuarioId: input.usuarioId,
      titulo: input.titulo,
      mensagem: input.mensagem,
      solicitacaoId: input.solicitacaoId ?? null,
      link: input.link ?? (input.solicitacaoId ? `/solicitacoes/${input.solicitacaoId}` : null),
      tipo: input.tipo ?? null,
    },
  })
}
