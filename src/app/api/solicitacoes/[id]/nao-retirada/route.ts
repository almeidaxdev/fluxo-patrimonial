// src/app/api/solicitacoes/[id]/nao-retirada/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getValidatedMutationSession } from '@/lib/session-validation'
import { isPatrimonioOuAdmin } from '@/lib/permissions'
import { calcularReferenciaUtilizacao } from '@/lib/prazo'
import { registrarHistorico } from '@/lib/historico'
import { criarNotificacao } from '@/lib/notificacoes'
import { buildAppUrl, processarEmailEvento, criarValidadorDeEvento } from '@/lib/email'
import { renderNaoRetiradaEmail } from '@/lib/email/templates/nao-retirada'
import { ErroNegocio } from '@/lib/erros'

// "Não retirado" (Etapa 9A-B): o Patrimônio preparou o item (a solicitação
// chegou a PRONTA_RETIRADA), mas o solicitante não compareceu para retirar.
// Distinto de "Cancelada" — não exige observação/justificativa (ver análise
// da Etapa 9A). Só registra status, data e usuário responsável.
//
// Concorrência: o `updateMany` abaixo é a ÚNICA fonte de verdade sobre a
// transição — não um `findUnique` prévio seguido de `update` incondicional.
// `status: 'PRONTA_RETIRADA'` só aparece aqui porque é o único status de
// origem permitido para NAO_RETIRADA em TRANSICOES_PERMITIDAS
// (src/lib/status.ts) — se essa regra mudar lá, precisa mudar aqui também.
// Sob READ COMMITTED (padrão do Postgres/Prisma), um UPDATE concorrente que
// tenta mexer na mesma linha bloqueia até a transação vencedora committar, e
// então reavalia o WHERE contra o valor já commitado — por isso a rota
// irmã (/retirada) nunca consegue "vencer" depois que esta já commitou, e
// vice-versa: o segundo `updateMany` a rodar sempre casa 0 linhas.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const validacao = await getValidatedMutationSession()
  if (!validacao.valido) return validacao.resposta
  if (!isPatrimonioOuAdmin(validacao.user)) return NextResponse.json({ message: 'Sem permissão.' }, { status: 403 })

  const { id } = await params

  try {
    const resultado = await prisma.$transaction(async (tx) => {
      // Regra temporal (P1 do Codex Review): "não retirado" só é válido
      // depois que a data/horário de início do período de utilização já
      // passou — mesma referência (data + período mais cedo) usada em
      // src/lib/prazo.ts para prazo/antecedência (calcularReferenciaUtilizacao),
      // nunca uma regra paralela. `data`/`periodos` são imutáveis após a
      // criação da solicitação — não há corrida possível nesta leitura, ao
      // contrário de `status`, que é validado atomicamente mais abaixo.
      const solicitacaoData = await tx.solicitacao.findUnique({ where: { id }, select: { data: true, periodos: true } })
      if (!solicitacaoData) throw new ErroNegocio('Solicitação não encontrada.', 404)

      const referencia = calcularReferenciaUtilizacao(solicitacaoData.data, solicitacaoData.periodos)
      if (referencia === null || Date.now() < referencia.getTime()) {
        throw new ErroNegocio('Esta solicitação ainda não atingiu a data/horário de retirada.', 409)
      }

      // `retiradaEm: null` é defesa extra (nunca marcar NAO_RETIRADA sobre
      // uma solicitação que já teve retirada registrada) — redundante com a
      // condição de status na prática (retiradaEm só é setado junto com a
      // saída de PRONTA_RETIRADA), mas explícita por segurança.
      const atualizadas = await tx.solicitacao.updateMany({
        where: { id, status: 'PRONTA_RETIRADA', retiradaEm: null },
        data: {
          status: 'NAO_RETIRADA',
          naoRetiradaEm: new Date(),
          naoRetiradaPorId: validacao.user.id,
        },
      })

      if (atualizadas.count === 0) {
        // Reconsulta OBRIGATÓRIA: o estado pode ter mudado entre a
        // requisição chegar e o updateMany rodar (ex.: retirada registrada
        // concorrentemente). A mensagem reflete o estado ATUAL, não o que
        // foi lido antes.
        const atual = await tx.solicitacao.findUnique({ where: { id }, select: { status: true } })
        if (!atual) throw new ErroNegocio('Solicitação não encontrada.', 404)
        if (atual.status === 'NAO_RETIRADA') {
          throw new ErroNegocio('Esta solicitação já foi registrada como não retirada.', 409)
        }
        if (atual.status === 'EM_UTILIZACAO' || atual.status === 'FINALIZADA') {
          throw new ErroNegocio('Esta solicitação já teve a retirada registrada.', 409)
        }
        throw new ErroNegocio('Esta solicitação não está pronta para retirada.', 409)
      }

      const atualizada = await tx.solicitacao.findUniqueOrThrow({
        where: { id },
        include: { solicitante: { select: { nome: true, email: true } } },
      })

      // Histórico, notificação e EmailEvento só rodam depois de confirmado
      // que ESTA requisição efetuou a transição (atualizadas.count === 1) —
      // nunca são criados para uma tentativa que perdeu a corrida. Isso
      // também garante que o EmailEvento (chave única
      // solicitacaoId+tipo+destinatario) nunca seja criado duas vezes.
      await registrarHistorico(tx, {
        solicitacaoId: id,
        usuarioId: validacao.user.id,
        acao: 'NAO_RETIRADA',
        statusAnterior: 'PRONTA_RETIRADA',
        statusNovo: 'NAO_RETIRADA',
        descricao: `Solicitação marcada como não retirada por ${validacao.user.nome}.`,
      })

      await criarNotificacao(tx, {
        usuarioId: atualizada.solicitanteId,
        solicitacaoId: id,
        titulo: 'Solicitação marcada como não retirada',
        mensagem: `A solicitação #${atualizada.numero} foi marcada como não retirada pelo Patrimônio.`,
        tipo: 'NAO_RETIRADA',
      })

      // User.email é obrigatório e único no schema (nunca nulo/vazio) — não
      // há cenário real de "solicitante sem e-mail" a tratar aqui.
      const evento = await tx.emailEvento.create({
        data: {
          solicitacaoId: id,
          tipo: 'NAO_RETIRADA',
          destinatario: atualizada.solicitante.email,
          status: 'PENDENTE',
          tentativas: 0,
        },
      })

      return { atualizada, eventoId: evento.id }
    })

    // Fora da transação (Etapa D.2, item 5/9): a intenção de envio já foi
    // commitada como EmailEvento PENDENTE junto da transição de status. Uma
    // falha do Resend aqui nunca desfaz NAO_RETIRADA nem afeta a resposta
    // desta rota (ver processarEmailEvento, que nunca lança).
    //
    // aindaValido (correção pós-Codex-Review): mesma regra usada pelo
    // dispatcher (validade-evento.ts) — NAO_RETIRADA já é status terminal
    // hoje, então esta checagem não deve encontrar nada na prática, mas o
    // caminho fica consistente com PRONTA_RETIRADA e protegido caso essa
    // premissa mude no futuro.
    await processarEmailEvento(
      resultado.eventoId,
      (ctx) =>
        renderNaoRetiradaEmail({
          nomeSolicitante: resultado.atualizada.solicitante.nome,
          numero: resultado.atualizada.numero,
          data: resultado.atualizada.data,
          periodos: resultado.atualizada.periodos,
          naoRetiradaEm: resultado.atualizada.naoRetiradaEm ?? new Date(),
          link: buildAppUrl(`/solicitacoes/${id}`),
          bannerDestinatarioOriginal: ctx.bannerDestinatarioOriginal,
        }),
      { aindaValido: criarValidadorDeEvento('NAO_RETIRADA', id) ?? undefined }
    )

    return NextResponse.json({ solicitacao: resultado.atualizada }, { status: 200 })
  } catch (e) {
    if (e instanceof ErroNegocio) return NextResponse.json({ message: e.message }, { status: e.status })
    console.error(e)
    return NextResponse.json({ message: 'Não foi possível registrar. Atualize a página e tente novamente.' }, { status: 500 })
  }
}
