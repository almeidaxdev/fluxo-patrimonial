// src/app/api/solicitacoes/[id]/separacao/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getValidatedMutationSession } from '@/lib/session-validation'
import { isPatrimonioOuAdmin } from '@/lib/permissions'
import { podeTransitar } from '@/lib/status'
import { registrarHistorico } from '@/lib/historico'
import { criarNotificacao } from '@/lib/notificacoes'
import { buildAppUrl, processarEmailEvento, criarValidadorDeEvento } from '@/lib/email'
import { renderProntaRetiradaEmail } from '@/lib/email/templates/pronta-retirada'
import { ErroNegocio } from '@/lib/erros'

// Concorrência (Etapa D.2): mesmo padrão seguro adotado em
// /api/solicitacoes/[id]/retirada e /api/solicitacoes/[id]/nao-retirada —
// `updateMany` condicional como ÚNICA fonte de verdade sobre a transição
// (não um `findUnique` prévio seguido de `update` incondicional, como esta
// rota fazia antes). PRONTA_RETIRADA aceita múltiplos status de origem
// (CONFIRMADA, ASSINATURA_CONFIRMADA, EM_SEPARACAO — ver src/lib/status.ts),
// mas — diferente das rotas irmãs, que comparam com um único valor
// literal — o WHERE aqui usa o status EXATO lido logo abaixo
// (`status: antes.status`), não `statusOrigemPermitidos('PRONTA_RETIRADA')`
// (correção pós-Codex-Review): se o WHERE aceitasse qualquer origem
// permitida, uma transição concorrente que mudasse o status ENTRE a
// leitura e o updateMany (ex.: CONFIRMADA → EM_SEPARACAO, ambas origens
// válidas) faria este updateMany "aceitar" silenciosamente o novo status,
// mas o histórico registrado abaixo continuaria dizendo `statusAnterior:
// CONFIRMADA` — impreciso. Amarrar o WHERE ao valor exato lido garante
// que o histórico nunca minta: ou o status não mudou (e o registro é
// fiel), ou mudou e a transição não se aplica aqui (count === 0 → 409,
// sem histórico/notificação/EmailEvento — ver abaixo).
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const validacao = await getValidatedMutationSession()
  if (!validacao.valido) return validacao.resposta
  if (!isPatrimonioOuAdmin(validacao.user)) return NextResponse.json({ message: 'Sem permissão.' }, { status: 403 })

  const { id } = await params

  try {
    const resultado = await prisma.$transaction(async (tx) => {
      const antes = await tx.solicitacao.findUnique({ where: { id }, select: { status: true } })
      if (!antes) throw new ErroNegocio('Solicitação não encontrada.', 404)

      if (!podeTransitar(antes.status, 'PRONTA_RETIRADA')) {
        throw new ErroNegocio('Esta solicitação não está apta para separação/retirada neste momento.', 409)
      }

      const atualizadas = await tx.solicitacao.updateMany({
        where: { id, status: antes.status },
        data: { status: 'PRONTA_RETIRADA', separadoEm: new Date(), separadoPorId: validacao.user.id },
      })

      if (atualizadas.count === 0) {
        // O status mudou entre a leitura acima e este update — outra
        // transação concorrente alterou a solicitação (mesmo que para um
        // status que também seria uma origem válida para PRONTA_RETIRADA).
        // Não é seguro assumir o novo status nem tentar de novo
        // automaticamente com ele: nenhum histórico, notificação ou
        // EmailEvento é criado para este status "adivinhado" — o usuário
        // repete a operação e o fluxo recomeça com o estado atualizado.
        throw new ErroNegocio('Esta solicitação foi alterada por outra operação. Atualize a página e tente novamente.', 409)
      }

      // Histórico, notificação e EmailEvento só rodam depois de confirmado
      // que ESTA requisição efetuou a transição (atualizadas.count === 1) —
      // nunca para uma tentativa que perdeu a corrida. Isso também garante
      // que o EmailEvento (chave única solicitacaoId+tipo+destinatario)
      // nunca seja criado duas vezes para o mesmo evento de negócio.
      const atualizada = await tx.solicitacao.findUniqueOrThrow({
        where: { id },
        include: {
          solicitante: { select: { nome: true, email: true } },
          itensPatrimonio: { include: { patrimonio: { select: { numero: true, marca: true, modelo: true } } } },
          itensPapelaria: { select: { descricao: true, quantidade: true } },
        },
      })

      await registrarHistorico(tx, {
        solicitacaoId: id,
        usuarioId: validacao.user.id,
        acao: 'SEPARACAO',
        statusAnterior: antes.status,
        statusNovo: 'PRONTA_RETIRADA',
        descricao: `Equipamentos separados por ${validacao.user.nome}.`,
      })

      await criarNotificacao(tx, {
        usuarioId: atualizada.solicitanteId,
        solicitacaoId: id,
        titulo: 'Pronta para retirada',
        mensagem: `Sua solicitação #${atualizada.numero} está pronta para retirada.`,
        tipo: 'PRONTA_RETIRADA',
      })

      // User.email é obrigatório e único no schema (nunca nulo/vazio) — não
      // há cenário real de "solicitante sem e-mail" a tratar aqui.
      const evento = await tx.emailEvento.create({
        data: {
          solicitacaoId: id,
          tipo: 'PRONTA_RETIRADA',
          destinatario: atualizada.solicitante.email,
          status: 'PENDENTE',
          tentativas: 0,
        },
      })

      return { atualizada, eventoId: evento.id }
    })

    // Fora da transação (Etapa D.2, item 5/9): a intenção de envio já foi
    // commitada como EmailEvento PENDENTE junto da transição de status. O
    // envio real do e-mail acontece só agora — uma falha do Resend aqui
    // nunca desfaz PRONTA_RETIRADA nem afeta a resposta desta rota (ver
    // processarEmailEvento, que nunca lança).
    //
    // aindaValido (correção pós-Codex-Review): entre o COMMIT acima e esta
    // chamada, outra requisição concorrente (/retirada, /cancelar,
    // /nao-retirada) pode ter mudado o status da solicitação — a mesma
    // regra usada pelo dispatcher (validade-evento.ts) garante que, se
    // isso acontecer, o e-mail "pronta para retirada" NÃO é enviado
    // desatualizado; o evento vira OBSOLETO em vez disso.
    await processarEmailEvento(
      resultado.eventoId,
      (ctx) =>
        renderProntaRetiradaEmail({
          nomeSolicitante: resultado.atualizada.solicitante.nome,
          numero: resultado.atualizada.numero,
          data: resultado.atualizada.data,
          periodos: resultado.atualizada.periodos,
          itensPatrimonio: resultado.atualizada.itensPatrimonio.map((item) => ({
            numero: item.patrimonio.numero,
            marca: item.patrimonio.marca,
            modelo: item.patrimonio.modelo,
          })),
          itensPapelaria: resultado.atualizada.itensPapelaria,
          link: buildAppUrl(`/solicitacoes/${id}`),
          bannerDestinatarioOriginal: ctx.bannerDestinatarioOriginal,
        }),
      { aindaValido: criarValidadorDeEvento('PRONTA_RETIRADA', id) ?? undefined }
    )

    return NextResponse.json({ solicitacao: resultado.atualizada }, { status: 200 })
  } catch (e) {
    if (e instanceof ErroNegocio) return NextResponse.json({ message: e.message }, { status: e.status })
    console.error(e)
    return NextResponse.json({ message: 'Erro interno no servidor.' }, { status: 500 })
  }
}
