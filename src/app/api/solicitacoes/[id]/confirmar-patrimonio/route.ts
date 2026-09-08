// src/app/api/solicitacoes/[id]/confirmar-patrimonio/route.ts
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
import { buscarDestinatariosReservaConfirmada } from '@/lib/email/destinatarios'
import { ErroNegocio } from '@/lib/erros'
import { StatusSolicitacao } from '@/types'

// Concorrência (Etapa D.3.0 — análise de robustez para RESERVA_CONFIRMADA):
// mesmo padrão seguro adotado em /separacao (ver aquela rota para a
// explicação completa do mecanismo). `podeTransitar(solicitacao.status,
// 'CONFIRMADA')` continua sendo usado apenas como checagem lógica (não é
// um status real persistido — ver src/lib/status.ts), mas a transição em
// si passou a ser condicionada ao status EXATO lido, nunca a um conjunto
// de origens — se outra transação mudar o status entre a leitura e o
// updateMany, este updateMany casa 0 linhas em vez de "aceitar" um status
// diferente do que gerou `statusAnterior` no histórico.
//
// RESERVA_CONFIRMADA (Etapa D.3.4) — SOMENTE fluxo interno nesta rodada:
// tipoEmprestimo === 'externo' continua indo para
// AGUARDANDO_ENVIO_ASSINATURA sem nenhum EmailEvento criado aqui — o
// e-mail do fluxo externo será disparado em /assinatura/confirmar, numa
// etapa futura (guarda explícita mais abaixo). Só tipoEmprestimo ===
// 'interno' (→ EM_SEPARACAO) cria RESERVA_CONFIRMADA, para o solicitante e
// para toda a equipe Patrimônio ativa.
//
// Snapshot histórico (Etapa D.3.6.4 — achado do Codex Review na Etapa D.3):
// o conteúdo do e-mail é CONGELADO em EmailEvento.payload dentro desta
// MESMA transação, usando os dados de `atualizada` (lidos aqui, no momento
// da confirmação) — nunca relidos depois do commit. O envio inline abaixo
// usa exclusivamente esse payload já persistido (via
// renderReservaConfirmadaFromPayload), não os campos de `atualizada`
// diretamente — a mesma fonte que o dispatcher usará quando for adaptado
// (D.3.6.5) para recuperar eventos abandonados sem depender do catálogo
// (Patrimonio/CategoriaPatrimonio) atual.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const validacao = await getValidatedMutationSession()
  if (!validacao.valido) return validacao.resposta
  if (!isPatrimonioOuAdmin(validacao.user)) return NextResponse.json({ message: 'Sem permissão.' }, { status: 403 })

  const { id } = await params

  try {
    const resultado = await prisma.$transaction(async (tx) => {
      const antes = await tx.solicitacao.findUnique({ where: { id }, select: { status: true, tipoEmprestimo: true } })
      if (!antes) throw new ErroNegocio('Solicitação não encontrada.', 404)

      if (!podeTransitar(antes.status, 'CONFIRMADA')) {
        throw new ErroNegocio('Esta solicitação não está mais aguardando confirmação do Patrimônio.', 409)
      }

      // Fluxo externo confirmado aguarda decisão de envio de assinatura;
      // fluxo interno pode ir direto para separação.
      const fluxoInterno = antes.tipoEmprestimo === 'interno'
      const proximoStatus: StatusSolicitacao = fluxoInterno ? 'EM_SEPARACAO' : 'AGUARDANDO_ENVIO_ASSINATURA'

      const atualizadas = await tx.solicitacao.updateMany({
        where: { id, status: antes.status },
        data: {
          status: proximoStatus,
          patrimonioDecisaoEm: new Date(),
          patrimonioDecisorId: validacao.user.id,
        },
      })

      if (atualizadas.count === 0) {
        // O status mudou entre a leitura acima e este update — outra
        // transação concorrente alterou a solicitação. Não é seguro
        // assumir o novo status nem tentar de novo automaticamente com
        // ele: nenhum histórico, notificação ou EmailEvento é criado para
        // este status "adivinhado" — o usuário repete a operação com o
        // estado atual.
        throw new ErroNegocio('Esta solicitação foi alterada por outra operação. Atualize a página e tente novamente.', 409)
      }

      // Histórico, notificação e (só no fluxo interno) EmailEvento só
      // rodam depois de confirmado que ESTA requisição efetuou a transição
      // (atualizadas.count === 1) — nunca para uma tentativa que perdeu a
      // corrida.
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
        acao: 'CONFIRMACAO_PATRIMONIO',
        statusAnterior: antes.status,
        statusNovo: proximoStatus,
        descricao: `Confirmada pelo Patrimônio (${validacao.user.nome}).`,
      })

      await criarNotificacao(tx, {
        usuarioId: atualizada.solicitanteId,
        solicitacaoId: id,
        titulo: 'Solicitação confirmada pelo Patrimônio',
        mensagem: `Sua solicitação #${atualizada.numero} foi confirmada pelo Patrimônio.`,
        tipo: 'CONFIRMACAO_PATRIMONIO',
      })

      // Guarda explícita (Etapa D.3.4): o fluxo externo NÃO cria
      // RESERVA_CONFIRMADA nesta rodada — ver comentário no topo do
      // arquivo. eventosCriados fica vazio para ele.
      const eventosCriados: { eventoId: string; payload: ReservaConfirmadaPayloadV1 }[] = []

      if (fluxoInterno) {
        // Dados-fonte do snapshot (Etapa D.3.6.4) — lidos AGORA, dentro da
        // transação; nunca relidos depois do commit. Reserva interna não
        // passa por assinatura — `assinaturaConfirmadaEm: null` sempre.
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
          assinaturaConfirmadaEm: null,
        }

        // User.email é obrigatório e único no schema (nunca nulo/vazio) —
        // não há cenário real de "solicitante sem e-mail" a tratar aqui.
        // A deduplicação (solicitante também sendo Patrimônio, e-mails
        // repetidos/case-insensitive) acontece dentro do helper — nunca há
        // risco de violar a unique constraint [solicitacaoId, tipo,
        // destinatario] criando os eventos abaixo.
        const destinatarios = await buscarDestinatariosReservaConfirmada(tx, atualizada.solicitante.email)

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
      }

      return { atualizada, eventosCriados }
    })

    // Fora da transação (mesmo padrão da Etapa D.2 — ver /separacao): a
    // intenção de envio já foi commitada como EmailEvento(s) PENDENTE junto
    // da transição de status. O envio real acontece só agora — uma falha
    // do provedor aqui nunca desfaz a confirmação nem afeta a resposta
    // desta rota (processarEmailEvento nunca lança). Roda em paralelo para
    // os poucos destinatários típicos (solicitante + equipe Patrimônio),
    // cada um com claim/estado independente no próprio EmailEvento.
    //
    // Fonte única (Etapa D.3.6.4): usa EXCLUSIVAMENTE o payload já
    // persistido no commit acima — nunca reconstruído a partir de
    // `resultado.atualizada` nem relido do catálogo. `link` continua
    // calculado aqui (nunca guardado no snapshot), dentro do callback de
    // build, para que uma falha de APP_URL só apareça DEPOIS do claim (ver
    // buildAppUrl abaixo).
    //
    // Sem aindaValido (Etapa D.3.4): RESERVA_CONFIRMADA é um registro
    // histórico de que a confirmação ocorreu — "foi confirmada", não "está
    // confirmada" (ver template) — permanece verdadeiro mesmo que a
    // solicitação avance ou seja cancelada depois. Diferente de
    // PRONTA_RETIRADA/NAO_RETIRADA, não há checagem de obsolescência.
    //
    // RESERVA_CONFIRMADA ainda não foi adicionado ao dispatcher (D.3.6.5,
    // rodada futura): se o processo morrer entre o commit acima e o envio
    // abaixo, o(s) EmailEvento ficam PENDENTE indefinidamente até essa
    // etapa futura — aceitável nesta etapa isolada.
    //
    // Isolamento entre destinatários (correção pós-auditoria — mesmo padrão
    // adotado em /assinatura/confirmar, /aprovar-gestor e /cancelar):
    // Promise.allSettled, não Promise.all — processarEmailEvento() já
    // documenta que nunca lança (toda falha vira EmailEvento.status =
    // 'FALHA'), mas um Promise.all aqui deixaria a rota inteira reportar
    // 500 (negócio já confirmado!) se ALGUMA exceção verdadeiramente
    // inesperada escapasse; allSettled garante que cada destinatário tem
    // sua chance de processamento independente da sorte dos demais, e que
    // a resposta desta rota nunca vira erro por causa de e-mail.
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
