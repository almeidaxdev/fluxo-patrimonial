// src/app/api/solicitacoes/[id]/assinatura/confirmar/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getValidatedMutationSession } from '@/lib/session-validation'
import { isPatrimonioOuAdmin } from '@/lib/permissions'
import { podeTransitar } from '@/lib/status'
import { registrarHistorico } from '@/lib/historico'
import { criarNotificacao } from '@/lib/notificacoes'
import { buildAppUrl, processarEmailEvento } from '@/lib/email'
import {
  construirPayloadReservaConfirmada,
  renderReservaConfirmadaFromPayload,
  type ConstruirPayloadReservaConfirmadaInput,
  type ReservaConfirmadaPayloadV1,
} from '@/lib/email/payloads/reserva-confirmada'
import { deduplicarDestinatarios, resolverEmailPatrimonioOuNull } from '@/lib/email/destinatarios'
import { ErroNegocio } from '@/lib/erros'

// O solicitante confirma manualmente que assinou (não há integração
// automática nesta versão). O Patrimônio também pode corrigir/validar
// manualmente esta informação, se necessário.
//
// Concorrência (Etapa D.3.0 — análise de robustez para RESERVA_CONFIRMADA):
// mesmo padrão seguro adotado em /separacao — o updateMany usa o status
// EXATO lido (`AGUARDANDO_ASSINATURA`, único status de origem permitido
// para ASSINATURA_CONFIRMADA), não uma condição incondicional depois de
// um `findUnique` + `update` separados. `tx.assinatura.update` só roda
// depois de confirmado que ESTA requisição venceu a corrida — antes disso,
// se o updateMany falhar, a transação inteira é revertida pelo `throw`,
// então nunca fica um registro de assinatura confirmada "órfão" sem a
// transição de status correspondente.
//
// RESERVA_CONFIRMADA (Etapa D.3.5) — este é o gatilho do FLUXO EXTERNO: só
// depois que a etapa de assinatura é concluída a reserva externa é
// considerada efetivamente confirmada (ver /confirmar-patrimonio — Etapa
// D.3.4 — que para tipoEmprestimo === 'externo' só avança até
// AGUARDANDO_ENVIO_ASSINATURA, sem criar RESERVA_CONFIRMADA; o fluxo
// interno cria o evento em /confirmar-patrimonio mesmo e não passa por
// aqui). Mesma infraestrutura de destinatários/dedup/envio da D.3.4 —
// nenhuma regra nova.
//
// Snapshot histórico (Etapa D.3.6.4 — achado do Codex Review na Etapa
// D.3): o conteúdo do e-mail é CONGELADO em EmailEvento.payload dentro
// desta MESMA transação, usando os dados de `atualizada` e o `confirmadaEm`
// recém-persistido em Assinatura — nunca relidos depois do commit. O envio
// inline abaixo usa exclusivamente esse payload já persistido (via
// renderReservaConfirmadaFromPayload).
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const validacao = await getValidatedMutationSession()
  if (!validacao.valido) return validacao.resposta

  const { id } = await params

  try {
    const resultado = await prisma.$transaction(async (tx) => {
      const antes = await tx.solicitacao.findUnique({ where: { id }, select: { status: true, solicitanteId: true } })
      if (!antes) throw new ErroNegocio('Solicitação não encontrada.', 404)

      const podeConfirmar = antes.solicitanteId === validacao.user.id || isPatrimonioOuAdmin(validacao.user)
      if (!podeConfirmar) {
        throw new ErroNegocio('Você não possui permissão para confirmar esta assinatura.', 403)
      }

      if (!podeTransitar(antes.status, 'ASSINATURA_CONFIRMADA')) {
        throw new ErroNegocio('Esta solicitação não está aguardando assinatura.', 409)
      }

      const atualizadas = await tx.solicitacao.updateMany({
        where: { id, status: antes.status },
        data: { status: 'ASSINATURA_CONFIRMADA' },
      })

      if (atualizadas.count === 0) {
        // O status mudou entre a leitura acima e este update — outra
        // transação concorrente alterou a solicitação. Nenhum registro de
        // assinatura, histórico, notificação ou EmailEvento é criado para
        // essa tentativa perdedora — o usuário repete a operação com o
        // estado atual.
        throw new ErroNegocio('Esta solicitação foi alterada por outra operação. Atualize a página e tente novamente.', 409)
      }

      const confirmadaEm = new Date()
      await tx.assinatura.update({
        where: { solicitacaoId: id },
        data: { confirmadaPorId: validacao.user.id, confirmadaEm },
      })

      // Histórico, notificações e EmailEvento só rodam depois de confirmado
      // que ESTA requisição efetuou a transição (atualizadas.count === 1) —
      // nunca para uma tentativa que perdeu a corrida.
      const atualizada = await tx.solicitacao.findUniqueOrThrow({
        where: { id },
        include: {
          solicitante: { select: { nome: true, email: true } },
          itensPatrimonio: { include: { patrimonio: { select: { numero: true, marca: true, modelo: true, categoria: { select: { nome: true } } } } } },
          itensPapelaria: { select: { descricao: true, quantidade: true } },
          itensServico: { include: { tipoServico: { select: { nome: true } } } },
        },
      })

      await registrarHistorico(tx, {
        solicitacaoId: id,
        usuarioId: validacao.user.id,
        acao: 'CONFIRMACAO_ASSINATURA',
        statusAnterior: antes.status,
        statusNovo: 'ASSINATURA_CONFIRMADA',
        descricao: `Assinatura confirmada por ${validacao.user.nome}.`,
      })

      const equipePatrimonioIds = await tx.user.findMany({ where: { ativo: true, permissao: 'patrimonio' }, select: { id: true } })
      for (const membro of equipePatrimonioIds) {
        await criarNotificacao(tx, {
          usuarioId: membro.id,
          solicitacaoId: id,
          titulo: 'Assinatura confirmada',
          mensagem: `A assinatura da solicitação #${atualizada.numero} foi confirmada. Pode seguir para separação.`,
          tipo: 'ASSINATURA_CONFIRMADA',
        })
      }

      // RESERVA_CONFIRMADA (Etapa D.3.5/D.3.6.4): mesmo helper/dedup da
      // D.3.4. Dados-fonte do snapshot lidos AGORA, dentro da transação —
      // `assinaturaConfirmadaEm` usa o MESMO `confirmadaEm` já persistido
      // em Assinatura acima (nunca um novo Date() gerado separadamente).
      const dadosParaSnapshot: ConstruirPayloadReservaConfirmadaInput = {
        numero: atualizada.numero,
        nomeSolicitante: atualizada.solicitante.nome,
        tipoEmprestimo: atualizada.tipoEmprestimo,
        data: atualizada.data,
        periodos: atualizada.periodos,
        ambiente: atualizada.ambiente,
        finalidade: atualizada.finalidade,
        atividadeExterna: atualizada.atividadeExterna,
        local: atualizada.local,
        cidade: atualizada.cidade,
        observacoes: atualizada.observacoes,
        itensPatrimonio: atualizada.itensPatrimonio.map((item) => ({
          numero: item.patrimonio.numero,
          marca: item.patrimonio.marca,
          modelo: item.patrimonio.modelo,
          categoria: item.patrimonio.categoria.nome,
        })),
        itensPapelaria: atualizada.itensPapelaria,
        itensServico: atualizada.itensServico.map((item) => ({
          tipoServicoNome: item.tipoServico.nome,
          quantidade: item.quantidade,
          ambiente: item.ambiente,
        })),
        notebooksComDominio: atualizada.notebooksComDominio,
        tipoDominio: atualizada.tipoDominio,
        assinaturaConfirmadaEm: confirmadaEm,
      }

      // Caixa de grupo do Patrimônio (Etapa email-patrimonio-caixa-grupo):
      // reaproveita o MESMO `equipePatrimonioIds` já buscado acima para as
      // notificações in-app — nunca uma segunda query só para decidir se
      // o Patrimônio é elegível para o e-mail de grupo (mesmo gate: existe
      // pelo menos um usuário ativo com permissao='patrimonio'?).
      //
      // User.email é obrigatório e único no schema (nunca nulo/vazio) —
      // não há cenário real de "solicitante sem e-mail" a tratar aqui.
      // A deduplicação (solicitante e caixa de grupo, endereços
      // repetidos/case-insensitive) acontece dentro do helper — nunca há
      // risco de violar a unique constraint [solicitacaoId, tipo,
      // destinatario] criando os eventos abaixo.
      const emailPatrimonio = equipePatrimonioIds.length > 0 ? resolverEmailPatrimonioOuNull('RESERVA_CONFIRMADA') : null
      const destinatarios = deduplicarDestinatarios(atualizada.solicitante.email, emailPatrimonio)
      const eventosCriados: { eventoId: string; payload: ReservaConfirmadaPayloadV1 }[] = []

      for (const destinatario of destinatarios) {
        // Um payload por destinatário — só `papel` muda entre eles; cada
        // um é um objeto novo, nunca uma referência compartilhada
        // persistida (ver construirPayloadReservaConfirmada).
        const payload = construirPayloadReservaConfirmada(dadosParaSnapshot, destinatario.papel)
        const evento = await tx.emailEvento.create({
          data: {
            solicitacaoId: id,
            tipo: 'RESERVA_CONFIRMADA',
            destinatario: destinatario.email,
            status: 'PENDENTE',
            tentativas: 0,
            payload: payload as unknown as Prisma.InputJsonValue,
          },
        })
        eventosCriados.push({ eventoId: evento.id, payload })
      }

      return { atualizada, eventosCriados }
    })

    // Fora da transação (mesmo padrão da Etapa D.2/D.3.4): a intenção de
    // envio já foi commitada como EmailEvento(s) PENDENTE junto da
    // transição de status. O envio real acontece só agora — uma falha do
    // provedor aqui nunca desfaz a confirmação nem afeta a resposta desta
    // rota.
    //
    // Fonte única (Etapa D.3.6.4): usa EXCLUSIVAMENTE o payload já
    // persistido no commit acima — nunca reconstruído a partir de
    // `resultado.atualizada` nem relido do catálogo/da Assinatura. `link`
    // continua calculado aqui (nunca guardado no snapshot), dentro do
    // callback de build, para que uma falha de APP_URL só apareça DEPOIS
    // do claim.
    //
    // Isolamento entre destinatários (Etapa D.3.5): Promise.allSettled, não
    // Promise.all — processarEmailEvento() já documenta que nunca lança
    // (toda falha vira EmailEvento.status = 'FALHA'), mas um Promise.all
    // aqui deixaria a rota inteira reportar 500 (negócio já confirmado!) se
    // ALGUMA exceção verdadeiramente inesperada escapasse; allSettled
    // garante que cada destinatário tem sua chance de processamento
    // independente da sorte dos demais, e que a resposta desta rota nunca
    // vira erro por causa de e-mail.
    //
    // Sem aindaValido (Etapa D.3.5): RESERVA_CONFIRMADA é um registro
    // histórico — "foi confirmada após a conclusão da etapa de assinatura",
    // não "está confirmada" (ver template) — permanece verdadeiro mesmo que
    // a solicitação avance ou seja cancelada depois.
    //
    // RESERVA_CONFIRMADA ainda não foi adicionado ao dispatcher (D.3.6.5,
    // rodada futura): se o processo morrer entre o commit acima e o envio
    // abaixo, o(s) EmailEvento ficam PENDENTE indefinidamente até essa
    // etapa futura — aceitável nesta etapa isolada.
    const resultadosEnvio = await Promise.allSettled(
      resultado.eventosCriados.map((evento) =>
        processarEmailEvento(evento.eventoId, (ctx) => renderReservaConfirmadaFromPayload(evento.payload, buildAppUrl(`/solicitacoes/${id}`), ctx.bannerDestinatarioOriginal))
      )
    )
    for (const envio of resultadosEnvio) {
      if (envio.status === 'rejected') {
        console.error(
          'RESERVA_CONFIRMADA: falha inesperada ao processar e-mail pós-commit (confirmação de negócio não é afetada):',
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
