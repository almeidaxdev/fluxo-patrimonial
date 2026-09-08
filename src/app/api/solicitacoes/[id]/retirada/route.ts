// src/app/api/solicitacoes/[id]/retirada/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getValidatedMutationSession } from '@/lib/session-validation'
import { isPatrimonioOuAdmin } from '@/lib/permissions'
import { registrarHistorico } from '@/lib/historico'
import { criarNotificacao } from '@/lib/notificacoes'
import { retiradaSchema } from '@/lib/validations'
import { ErroNegocio } from '@/lib/erros'

// Concorrência (Etapa 9A-B): proteção simétrica à rota irmã
// /api/solicitacoes/[id]/nao-retirada — ver o comentário lá para a
// explicação completa do mecanismo. Aqui, `status: 'PRONTA_RETIRADA'` é o
// único status de origem permitido para EM_UTILIZACAO em
// TRANSICOES_PERMITIDAS (src/lib/status.ts).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const validacao = await getValidatedMutationSession()
  if (!validacao.valido) return validacao.resposta
  if (!isPatrimonioOuAdmin(validacao.user)) return NextResponse.json({ message: 'Sem permissão.' }, { status: 403 })

  const { id } = await params

  try {
    const body = await req.json().catch(() => ({}))
    const parsed = retiradaSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ message: 'Dados inválidos.' }, { status: 400 })
    }

    const resultado = await prisma.$transaction(async (tx) => {
      // `naoRetiradaEm: null` é defesa extra (nunca registrar retirada sobre
      // uma solicitação já marcada como não retirada) — redundante com a
      // condição de status na prática, mas explícita por segurança.
      const atualizadas = await tx.solicitacao.updateMany({
        where: { id, status: 'PRONTA_RETIRADA', naoRetiradaEm: null },
        data: {
          status: 'EM_UTILIZACAO',
          retiradaEm: new Date(),
          retiradaPorId: validacao.user.id,
          retiradaObs: parsed.data.observacoes,
        },
      })

      if (atualizadas.count === 0) {
        // Reconsulta OBRIGATÓRIA: o estado pode ter mudado entre a
        // requisição chegar e o updateMany rodar (ex.: "não retirado"
        // registrado concorrentemente). A mensagem reflete o estado ATUAL.
        const atual = await tx.solicitacao.findUnique({ where: { id }, select: { status: true } })
        if (!atual) throw new ErroNegocio('Solicitação não encontrada.', 404)
        if (atual.status === 'NAO_RETIRADA') {
          throw new ErroNegocio('Esta solicitação já foi marcada como não retirada.', 409)
        }
        if (atual.status === 'EM_UTILIZACAO' || atual.status === 'FINALIZADA') {
          throw new ErroNegocio('Esta solicitação já teve a retirada registrada.', 409)
        }
        throw new ErroNegocio('Esta solicitação não está pronta para retirada.', 409)
      }

      const atualizada = await tx.solicitacao.findUniqueOrThrow({ where: { id } })

      // Histórico e notificação só rodam depois de confirmado que ESTA
      // requisição efetuou a transição (atualizadas.count === 1) — nunca
      // são criados para uma tentativa que perdeu a corrida.
      await registrarHistorico(tx, {
        solicitacaoId: id,
        usuarioId: validacao.user.id,
        acao: 'RETIRADA',
        statusAnterior: 'PRONTA_RETIRADA',
        statusNovo: 'EM_UTILIZACAO',
        descricao: `Retirada registrada por ${validacao.user.nome}.`,
      })

      await criarNotificacao(tx, {
        usuarioId: atualizada.solicitanteId,
        solicitacaoId: id,
        titulo: 'Retirada registrada',
        mensagem: `A retirada dos itens da solicitação #${atualizada.numero} foi registrada.`,
        tipo: 'RETIRADA',
      })

      return atualizada
    })

    return NextResponse.json({ solicitacao: resultado }, { status: 200 })
  } catch (e) {
    if (e instanceof ErroNegocio) return NextResponse.json({ message: e.message }, { status: e.status })
    console.error(e)
    return NextResponse.json({ message: 'Não foi possível registrar a retirada. Atualize a página e tente novamente.' }, { status: 500 })
  }
}
