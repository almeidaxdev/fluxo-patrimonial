// src/app/api/solicitacoes/[id]/aprovar-gestor/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getValidatedMutationSession } from '@/lib/session-validation'
import { podeTransitar } from '@/lib/status'
import { registrarHistorico } from '@/lib/historico'
import { criarNotificacao } from '@/lib/notificacoes'
import { buildAppUrl, processarEmailEvento, criarValidadorDeEvento } from '@/lib/email'
import {
  construirPayloadSolicitacaoAguardandoPatrimonio,
  renderSolicitacaoAguardandoPatrimonioFromPayload,
  type ConstruirPayloadSolicitacaoAguardandoPatrimonioInput,
  type SolicitacaoAguardandoPatrimonioPayloadV1,
} from '@/lib/email/payloads/solicitacao-aguardando-patrimonio'
import { deduplicarDestinatarios, resolverEmailPatrimonioOuNull } from '@/lib/email/destinatarios'
import { ErroNegocio } from '@/lib/erros'

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const validacao = await getValidatedMutationSession()
  if (!validacao.valido) return validacao.resposta

  const { id } = await params

  try {
    const resultado = await prisma.$transaction(async (tx) => {
      const solicitacao = await tx.solicitacao.findUnique({ where: { id } })
      if (!solicitacao) throw new ErroNegocio('Solicitação não encontrada.', 404)

      // Regra: gestor só aprova solicitações atribuídas a ele (nunca confiar no frontend).
      if (solicitacao.gestorId !== validacao.user.id) {
        throw new ErroNegocio('Você não possui permissão para aprovar esta solicitação.', 403)
      }

      if (!podeTransitar(solicitacao.status, 'AGUARDANDO_PATRIMONIO')) {
        throw new ErroNegocio('Esta solicitação não está mais aguardando decisão do gestor.', 409)
      }

      // Concorrência (Etapa fix/atomic-request-transitions — mesmo padrão
      // já usado em /cancelar): o update condicional só pode casar o status
      // EXATO lido acima — se qualquer transição concorrente mudou o
      // status entre a leitura e este update (ex.: duas aprovações
      // simultâneas do mesmo gestor), a atualização casa 0 linhas e a rota
      // devolve 409 em vez de registrar histórico/notificação/e-mail
      // duplicados para uma corrida perdida.
      const atualizadas = await tx.solicitacao.updateMany({
        where: { id, status: solicitacao.status },
        data: { status: 'AGUARDANDO_PATRIMONIO', gestorDecisaoEm: new Date() },
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
        acao: 'APROVACAO_GESTOR',
        statusAnterior: solicitacao.status,
        statusNovo: 'AGUARDANDO_PATRIMONIO',
        descricao: `Atividade externa aprovada pelo gestor ${validacao.user.nome}.`,
      })

      await criarNotificacao(tx, {
        usuarioId: solicitacao.solicitanteId,
        solicitacaoId: id,
        titulo: 'Gestor aprovou sua solicitação',
        mensagem: `Sua solicitação #${solicitacao.numero} foi aprovada pelo gestor e segue para o Patrimônio.`,
        tipo: 'APROVACAO_GESTOR',
      })

      // Etapa email-aguardando-patrimonio: mesma leitura já usada para as
      // notificações in-app abaixo — nenhuma segunda query à equipe
      // Patrimônio. Só `id` no select (Etapa email-patrimonio-caixa-grupo:
      // o e-mail de cada membro deixou de ser necessário — o e-mail de
      // grupo agora vem de EMAIL_PATRIMONIO_RECIPIENT, não do banco).
      const equipePatrimonio = await tx.user.findMany({ where: { ativo: true, permissao: 'patrimonio' }, select: { id: true } })
      for (const membro of equipePatrimonio) {
        await criarNotificacao(tx, {
          usuarioId: membro.id,
          solicitacaoId: id,
          titulo: 'Atividade externa aprovada pelo gestor',
          mensagem: `A solicitação #${solicitacao.numero} está aguardando análise do Patrimônio.`,
          tipo: 'ANALISE_PATRIMONIO',
        })
      }

      // Sem usuário Patrimônio ativo (item 18 do pedido): a aprovação
      // segue normalmente — `destinatarios` fica vazio, o loop abaixo não
      // roda, nenhum EmailEvento é criado. Nenhum erro funcional é
      // inventado para o gestor só por faltar destinatário de e-mail.
      const eventosCriados: { eventoId: string; payload: SolicitacaoAguardandoPatrimonioPayloadV1 }[] = []

      if (equipePatrimonio.length > 0) {
        // Etapa email-aguardando-patrimonio: snapshot histórico (mesmo
        // padrão das features de e-mail anteriores) — dados lidos AGORA,
        // dentro da transação. Leitura separada (não reaproveita
        // `atualizada`, sem os includes necessários) para não alterar o
        // formato da resposta desta rota.
        const dadosSolicitacao = await tx.solicitacao.findUniqueOrThrow({
          where: { id },
          include: {
            solicitante: { select: { nome: true } },
            itensPatrimonio: { include: { patrimonio: { select: { numero: true, marca: true, modelo: true, categoria: { select: { nome: true } } } } } },
            itensPapelaria: { select: { descricao: true, quantidade: true } },
            itensServico: { include: { tipoServico: { select: { nome: true } } } },
          },
        })

        const dadosParaSnapshot: ConstruirPayloadSolicitacaoAguardandoPatrimonioInput = {
          numero: dadosSolicitacao.numero,
          nomeSolicitante: dadosSolicitacao.solicitante.nome,
          nomeGestorAprovador: validacao.user.nome,
          // Aprovação de gestor só existe para tipoEmprestimo='externo' —
          // reserva interna nunca passa por esta rota (ver POST
          // /api/solicitacoes, onde SOLICITACAO_AGUARDANDO_PATRIMONIO
          // também é criado, para o caso interno — Etapa
          // email-patrimonio-solicitacao-interna).
          tipoEmprestimo: 'externo',
          data: dadosSolicitacao.data,
          periodos: dadosSolicitacao.periodos,
          ambiente: null,
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
        // Um único payload — IDÊNTICO para todos os destinatários (não há
        // `papel` a variar aqui, diferente de RESERVA_CONFIRMADA/CANCELAMENTO).
        const payload = construirPayloadSolicitacaoAguardandoPatrimonio(dadosParaSnapshot)

        // Caixa de grupo do Patrimônio (Etapa email-patrimonio-caixa-grupo):
        // `equipePatrimonio.length > 0` (já sabido pelo `if` acima) é o
        // gate de elegibilidade — o mesmo de sempre, só que agora resolve
        // para NO MÁXIMO 1 EmailEvento (a caixa de grupo), nunca mais um
        // por membro. Mesmo helper de dedup usado por RESERVA_CONFIRMADA/
        // CANCELAMENTO (src/lib/email/destinatarios.ts) — `emailSolicitante:
        // null` descarta deliberadamente o branch "solicitante" (este
        // e-mail nunca vai para o solicitante).
        const emailPatrimonio = resolverEmailPatrimonioOuNull('SOLICITACAO_AGUARDANDO_PATRIMONIO')
        const destinatarios = deduplicarDestinatarios(null, emailPatrimonio)

        for (const destinatario of destinatarios) {
          // Idempotência: upsert atômico na unique [solicitacaoId, tipo,
          // destinatario] — nunca uma unique violation virando 500.
          const evento = await tx.emailEvento.upsert({
            where: {
              solicitacaoId_tipo_destinatario: {
                solicitacaoId: id,
                tipo: 'SOLICITACAO_AGUARDANDO_PATRIMONIO',
                destinatario: destinatario.email,
              },
            },
            create: {
              solicitacaoId: id,
              tipo: 'SOLICITACAO_AGUARDANDO_PATRIMONIO',
              destinatario: destinatario.email,
              status: 'PENDENTE',
              tentativas: 0,
              payload: payload as unknown as Prisma.InputJsonValue,
            },
            update: {},
          })
          eventosCriados.push({ eventoId: evento.id, payload })
        }
      }

      // Só disponível agora (após a transição atômica confirmada acima) —
      // mesmo padrão de /cancelar: nunca reaproveita a leitura de antes do
      // updateMany como se já refletisse o novo status.
      const atualizada = await tx.solicitacao.findUniqueOrThrow({ where: { id } })

      return { atualizada, eventosCriados }
    }, {
      // Correção pós-P2028 confirmado em produção (Runtime Logs da Vercel —
      // PrismaClientKnownRequestError, "Transaction not found"): mesma causa
      // e mesmo remédio já aplicados em POST /api/solicitacoes (ver
      // comentário completo lá). Esta transação soma, além das queries fixas
      // (leitura, updateMany condicional, histórico, findMany da equipe
      // Patrimônio), um loop de `criarNotificacao` por membro ativo do
      // Patrimônio, uma releitura completa com includes e um
      // `emailEvento.upsert` — cada `await tx.*` é um round-trip real ao
      // pooler do Supabase a partir de uma function serverless, e os
      // defaults do Prisma (maxWait: 2000ms, timeout: 5000ms) não cobrem
      // essa cadeia. Mesmos valores homologados, sem inventar um novo teto.
      maxWait: 5000,
      timeout: 15000,
    })

    // Fora da transação (mesmo padrão de /confirmar-patrimonio e
    // /assinatura/confirmar): a intenção de envio já foi commitada como
    // EmailEvento(s) PENDENTE junto da aprovação. allSettled (não
    // Promise.all) — um destinatário nunca pode fazer a resposta desta
    // rota virar 500 por causa de e-mail.
    const resultadosEnvio = await Promise.allSettled(
      resultado.eventosCriados.map((evento) =>
        processarEmailEvento(
          evento.eventoId,
          (ctx) => renderSolicitacaoAguardandoPatrimonioFromPayload(evento.payload, buildAppUrl(`/solicitacoes/${id}`), ctx.bannerDestinatarioOriginal),
          { aindaValido: criarValidadorDeEvento('SOLICITACAO_AGUARDANDO_PATRIMONIO', id) ?? undefined }
        )
      )
    )
    for (const envio of resultadosEnvio) {
      if (envio.status === 'rejected') {
        console.error(
          'SOLICITACAO_AGUARDANDO_PATRIMONIO: falha inesperada ao processar e-mail pós-commit (aprovação de negócio não é afetada):',
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
