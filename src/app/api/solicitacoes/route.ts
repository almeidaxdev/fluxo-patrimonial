// src/app/api/solicitacoes/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getSession } from '@/lib/auth'
import { getValidatedMutationSession } from '@/lib/session-validation'
import { isPatrimonioOuAdmin, podeSolicitarParaOutro } from '@/lib/permissions'
import { criarSolicitacaoSchema, escopoSolicitacaoEnum, statusSolicitacaoEnum, tipoEmprestimoEnum, filtroSolicitacaoEnum } from '@/lib/validations'
import { parsePaginacao, dataValida } from '@/lib/query-params'
import { parseJsonBody } from '@/lib/http'
import { registrarHistorico } from '@/lib/historico'
import { criarNotificacao } from '@/lib/notificacoes'
import { STATUS_BLOQUEIAM_DISPONIBILIDADE, STATUS_EM_ANDAMENTO_SOLICITANTE } from '@/lib/status'
import { calcularPrazo } from '@/lib/prazo'
import { buildAppUrl, processarEmailEvento, criarValidadorDeEvento } from '@/lib/email'
import {
  construirPayloadSolicitacaoAguardandoGestor,
  renderSolicitacaoAguardandoGestorFromPayload,
  type ConstruirPayloadSolicitacaoAguardandoGestorInput,
  type SolicitacaoAguardandoGestorPayloadV1,
} from '@/lib/email/payloads/solicitacao-aguardando-gestor'
import {
  construirPayloadSolicitacaoAguardandoPatrimonio,
  renderSolicitacaoAguardandoPatrimonioFromPayload,
  type ConstruirPayloadSolicitacaoAguardandoPatrimonioInput,
  type SolicitacaoAguardandoPatrimonioPayloadV1,
} from '@/lib/email/payloads/solicitacao-aguardando-patrimonio'
import { deduplicarDestinatarios, resolverEmailPatrimonioOuNull } from '@/lib/email/destinatarios'
import { PeriodoSolicitacao, StatusSolicitacao } from '@/types'
import { isDemoModeAtivo, getDemoMaxSolicitacoes, respostaLimiteSolicitacoesDemo } from '@/lib/demo-mode'
import { checkSensitiveRateLimit, RATE_LIMIT_RETRY_AFTER_SECONDS, RATE_LIMIT_RESPONSE_BODY } from '@/lib/rate-limit'

const includePadrao = {
  solicitante: { select: { id: true, nome: true, email: true } },
  criadoPor: { select: { id: true, nome: true, email: true } },
  gestor: { select: { id: true, nome: true, email: true } },
  itensPatrimonio: { include: { patrimonio: { include: { categoria: true } } } },
  itensPapelaria: true,
  itensServico: { include: { tipoServico: true } },
  assinatura: true,
}

// Etapa perf/system-optimization: `includePadrao` acima é usado pelo POST
// (que precisa dos itens/assinatura completos para montar os payloads de
// e-mail dentro da MESMA transação — nunca tocar nisso). As 4 telas que
// consomem este GET (Todas as Solicitações, Minhas Solicitações, Pendências,
// Aprovações — auditado via grep em cada uma) só renderizam número, status,
// tipoEmprestimo, origem, data, períodos, atividadeExterna e o nome do
// solicitante — nunca itensPatrimonio/itensPapelaria/itensServico/
// assinatura/criadoPor/gestor. Um `select` dedicado para a LISTAGEM evita
// que cada linha da tabela carregue (e o Postgres monte) esses relacionamentos
// aninhados inteiros — que só o detalhe de UMA solicitação (GET /api/
// solicitacoes/[id], rota separada) de fato precisa.
const selectListagem = {
  id: true,
  numero: true,
  tipoEmprestimo: true,
  origem: true,
  status: true,
  data: true,
  periodos: true,
  atividadeExterna: true,
  solicitante: { select: { id: true, nome: true, email: true } },
}

export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ message: 'Não autorizado.' }, { status: 401 })

  const { searchParams } = new URL(req.url)

  // Etapa security/input-hardening-b2: `escopo`/`status`/`tipoEmprestimo`
  // são conjuntos fechados usados só como FILTRO desta listagem (nunca
  // gravados) — chegavam sem checagem (`status` via `as StatusSolicitacao`,
  // `tipoEmprestimo` repassado direto ao `where`). Um valor arbitrário aqui
  // não é uma falha de autorização (o `where` só RESTRINGE ainda mais a
  // busca dentro do escopo já decidido pela sessão), mas devolvia 0
  // resultados silenciosamente em vez de um erro claro — validado
  // explicitamente para dar 400 com mensagem amigável.
  const escopoParam = searchParams.get('escopo') || 'minhas' // 'minhas' | 'todas' | 'gestor'
  const parsedEscopo = escopoSolicitacaoEnum.safeParse(escopoParam)
  if (!parsedEscopo.success) {
    return NextResponse.json({ message: 'Escopo inválido.' }, { status: 400 })
  }
  const escopo = parsedEscopo.data

  const statusParam = searchParams.get('status')
  if (statusParam !== null && !statusSolicitacaoEnum.safeParse(statusParam).success) {
    return NextResponse.json({ message: 'Status inválido.' }, { status: 400 })
  }
  const status = statusParam as StatusSolicitacao | null

  // Etapa feat/admin-dashboard-operational: preset semântico para filtros
  // que representam MAIS DE UM status (ex.: "em andamento" — card pessoal
  // "Minhas solicitações em andamento", que nunca teve um único status
  // real). Conjunto fechado (`filtroSolicitacaoEnum`) — um valor fora dele
  // é rejeitado com 400, nunca ignorado silenciosamente.
  const filtroParam = searchParams.get('filtro')
  if (filtroParam !== null && !filtroSolicitacaoEnum.safeParse(filtroParam).success) {
    return NextResponse.json({ message: 'Filtro inválido.' }, { status: 400 })
  }
  const filtro = filtroParam as 'em_andamento' | null

  const tipoEmprestimoParam = searchParams.get('tipoEmprestimo')
  if (tipoEmprestimoParam !== null && !tipoEmprestimoEnum.safeParse(tipoEmprestimoParam).success) {
    return NextResponse.json({ message: 'Tipo de empréstimo inválido.' }, { status: 400 })
  }
  const tipoEmprestimo = tipoEmprestimoParam

  // Etapa security/input-hardening-b3: `numero` chegava direto para
  // `parseInt(numero)` mais abaixo — um valor não numérico vira `NaN`, que
  // o Prisma rejeita com uma exceção genérica (500) em vez de um 400 com
  // causa clara. Validado aqui, ANTES de qualquer uso.
  const numero = searchParams.get('numero')
  if (numero !== null && !Number.isInteger(Number(numero))) {
    return NextResponse.json({ message: 'Número inválido.' }, { status: 400 })
  }

  const solicitanteId = searchParams.get('solicitanteId')
  const gestorId = searchParams.get('gestorId')

  // Etapa security/input-hardening-b3: `data`/`dataInicio`/`dataFim`
  // chegavam direto para `new Date(...)` — uma string não-data vira
  // `Invalid Date`, que o Prisma também rejeita com uma exceção genérica em
  // vez de um 400 claro. `dataValida` (src/lib/query-params.ts) é o mesmo
  // helper usado pelos demais endpoints com filtro de data — nunca duplicar
  // a checagem.
  const data = searchParams.get('data')
  if (data !== null && !dataValida(data)) {
    return NextResponse.json({ message: 'Data inválida.' }, { status: 400 })
  }
  const dataInicio = searchParams.get('dataInicio')
  if (dataInicio !== null && !dataValida(dataInicio)) {
    return NextResponse.json({ message: 'Data inicial inválida.' }, { status: 400 })
  }
  const dataFim = searchParams.get('dataFim')
  if (dataFim !== null && !dataValida(dataFim)) {
    return NextResponse.json({ message: 'Data final inválida.' }, { status: 400 })
  }

  // Etapa security/input-hardening-b3: teto de 100 (mesmo já aplicado em
  // GET /api/relatorios/operacional) — o default de 20 é preservado
  // integralmente; só um `limit` explicitamente maior que 100 (ou
  // inválido/negativo/NaN) é que passa a ser clampado em vez de repassado
  // cru ao `take` do Prisma.
  const { page, limit, skip } = parsePaginacao(searchParams, { limitPadrao: 20, limiteMaximo: 100 })

  const where: Record<string, unknown> = {}

  // Regra obrigatória (Módulo 05): "Minhas Solicitações" SEMPRE filtra pelo
  // usuário autenticado, independentemente do perfil (colaborador, gestor,
  // Patrimônio ou administrador). Somente com escopo=todas — e apenas para
  // Patrimônio/administrador — a listagem geral é liberada. O escopo=gestor
  // é restrito ao próprio usuário autenticado como gestor (nunca a outro).
  if (escopo === 'gestor') {
    where.gestorId = session.id
  } else if (escopo === 'todas') {
    // Etapa security/session-revocation: GET "privilegiado" — só ESTE ramo
    // (não escopo=minhas/gestor, que continuam em getSession() puro, sem
    // round-trip extra) — expõe solicitações de TODOS os usuários para
    // Patrimônio/Administrador. Revalida no banco em vez de confiar em
    // isPatrimonioOuAdmin(session) sobre a claim do JWT, para que um usuário
    // rebaixado/desativado não continue enxergando esta listagem ampla por
    // até 24h (ver docs/ARQUITETURA.md, seção "Revogação de sessão").
    const validacao = await getValidatedMutationSession()
    if (!validacao.valido) return validacao.resposta
    if (!isPatrimonioOuAdmin(validacao.user)) {
      return NextResponse.json({ message: 'Sem permissão para consultar todas as solicitações.' }, { status: 403 })
    }
    if (solicitanteId) where.solicitanteId = solicitanteId
    if (gestorId) where.gestorId = gestorId
  } else {
    where.solicitanteId = session.id
  }

  // `status` (um valor exato) tem precedência sobre `filtro` (um preset de
  // vários status) quando ambos chegam juntos — nunca combinados/anded.
  if (status) where.status = status
  else if (filtro === 'em_andamento') where.status = { in: STATUS_EM_ANDAMENTO_SOLICITANTE }
  if (tipoEmprestimo) where.tipoEmprestimo = tipoEmprestimo
  if (numero) where.numero = parseInt(numero)

  if (data) {
    const d = new Date(data)
    d.setUTCHours(0, 0, 0, 0)
    where.data = d
  } else if (dataInicio || dataFim) {
    const range: Record<string, Date> = {}
    if (dataInicio) range.gte = new Date(dataInicio)
    if (dataFim) range.lte = new Date(dataFim)
    where.data = range
  }

  const [solicitacoes, total] = await Promise.all([
    prisma.solicitacao.findMany({
      where,
      select: selectListagem,
      orderBy: [{ data: 'asc' }, { numero: 'desc' }],
      skip,
      take: limit,
    }),
    prisma.solicitacao.count({ where }),
  ])

  return NextResponse.json({ solicitacoes, total, page, limit }, { status: 200 })
}

export async function POST(req: NextRequest) {
  const validacao = await getValidatedMutationSession()
  if (!validacao.valido) return validacao.resposta

  // Fluxo Patrimonial — Demo: duas proteções ADICIONAIS, ativas SOMENTE
  // quando DEMO_MODE=true (DEMO_MODE=false preserva este handler byte a
  // byte em relação a antes desta etapa). Nunca aplicadas a nenhuma outra
  // ação do fluxo (aprovação/separação/retirada/devolução/cancelamento/
  // assinatura) — só à CRIAÇÃO, que é o único ponto por onde um visitante
  // consegue fazer o volume de dados crescer sem limite.
  if (isDemoModeAtivo()) {
    // 1) Rate limit por sessão (mesma infraestrutura de login/cadastro —
    // ver src/lib/rate-limit.ts; best-effort/fail-open, nunca uma barreira
    // absoluta — ver docs/DEMO_MODE.md). Identificador é o usuário
    // AUTENTICADO (não IP): todo visitante da demo pública compartilha a
    // MESMA conta (ver POST /api/demo/entrar), então um balde por conta é
    // exatamente o comportamento desejado aqui.
    const { limited } = await checkSensitiveRateLimit({
      request: req,
      namespace: 'demo-solicitacoes-criar',
      identifier: validacao.user.id,
    })
    if (limited) {
      return NextResponse.json(RATE_LIMIT_RESPONSE_BODY, {
        status: 429,
        headers: { 'Retry-After': String(RATE_LIMIT_RETRY_AFTER_SECONDS) },
      })
    }

    // 2) Limite global independente (defesa em profundidade — nunca
    // confia só no rate limit acima, que pode estar fail-open por falta de
    // configuração no Firewall). Não precisa ser perfeito sob concorrência
    // extrema (ver docs/DEMO_MODE.md) — é uma válvula de segurança para o
    // contexto de demo, não uma garantia matemática; o reset periódico é
    // quem de fato restaura o volume ao dataset original.
    const totalAtual = await prisma.solicitacao.count()
    if (totalAtual >= getDemoMaxSolicitacoes()) {
      return respostaLimiteSolicitacoesDemo()
    }
  }

  try {
    const corpo = await parseJsonBody(req)
    if (!corpo.ok) return corpo.resposta
    const parsed = criarSolicitacaoSchema.safeParse(corpo.data)
    if (!parsed.success) {
      return NextResponse.json({ message: parsed.error.errors[0]?.message ?? 'Dados inválidos.' }, { status: 400 })
    }
    const d = parsed.data

    // Segurança (Etapa security/request-for-another): solicitanteId
    // omitido → o próprio usuário autenticado (nunca um valor "adivinhado").
    // Todo o restante da rota usa exclusivamente `solicitanteIdEfetivo` a
    // partir daqui — nunca mais `d.solicitanteId` bruto.
    const solicitanteIdEfetivo = d.solicitanteId ?? validacao.user.id

    // "Solicitar para outro colaborador" (solicitanteIdEfetivo !==
    // session.id) só é permitido a Gestor/Patrimônio/Administrador OU a um
    // colaborador com a CAPACIDADE explícita `podeSolicitarParaOutro`
    // concedida por um Administrador (ver podeSolicitarParaOutro() em
    // src/lib/permissions.ts — regra de negócio aprovada, ver
    // docs/REGRAS_DE_NEGOCIO.md). Gate único, ANTES de qualquer
    // leitura/escrita, decidido só pela sessão validada (claims do JWT —
    // nunca por um valor vindo do body) — sem round-trip extra ao banco, e
    // cobre igualmente reserva interna, externa e Atendimento Imediato
    // (que já teria, de qualquer forma, passado pela checagem de
    // isPatrimonioOuAdmin abaixo).
    if (solicitanteIdEfetivo !== validacao.user.id && !podeSolicitarParaOutro(validacao.user)) {
      return NextResponse.json(
        { message: 'Você não possui permissão para criar solicitações em nome de outro colaborador.' },
        { status: 403 }
      )
    }

    // Atendimento Imediato (Fase 3 — Etapa 4): somente Patrimônio/Admin.
    // Nunca confiar apenas no schema — validado aqui no backend.
    if (d.origem === 'ATENDIMENTO_IMEDIATO' && !isPatrimonioOuAdmin(validacao.user)) {
      return NextResponse.json({ message: 'Você não possui permissão para registrar atendimento imediato.' }, { status: 403 })
    }

    // duplicidade de bens na própria solicitação
    if (new Set(d.patrimonioIds).size !== d.patrimonioIds.length) {
      return NextResponse.json({ message: 'Não é permitido selecionar o mesmo bem mais de uma vez.' }, { status: 400 })
    }

    const solicitante = await prisma.user.findUnique({ where: { id: solicitanteIdEfetivo } })
    if (!solicitante || !solicitante.ativo) {
      return NextResponse.json({ message: 'Solicitante inválido.' }, { status: 400 })
    }

    if (d.tipoEmprestimo === 'externo') {
      const gestor = await prisma.user.findUnique({ where: { id: d.gestorId! } })
      if (!gestor || !gestor.ativo || !gestor.podeSerGestor) {
        return NextResponse.json({ message: 'Gestor selecionado é inválido.' }, { status: 400 })
      }
    }

    // Atendimento Imediato sempre é tratado como fluxo interno simplificado
    // — não há gestor, atividade externa nem aprovação envolvidos, pois o
    // atendimento já ocorreu no momento do registro.
    const tipoEmprestimoFinal = d.origem === 'ATENDIMENTO_IMEDIATO' ? 'interno' : d.tipoEmprestimo

    const dataObj = new Date(d.data)
    dataObj.setUTCHours(0, 0, 0, 0)

    // Domínio (Etapa domain-flow): propriedade da solicitação como um todo,
    // relevante SOMENTE quando há pelo menos um bem de categoria "Notebook"
    // entre os selecionados — nunca confiar no front para essa detecção.
    // Independe de interno/externo (a regra antiga que zerava domínio em
    // reserva interna deixou de existir).
    const temNotebook = d.patrimonioIds.length > 0
      ? (await prisma.patrimonio.findMany({
          where: { id: { in: d.patrimonioIds } },
          include: { categoria: true },
        })).some((p: { categoria: { nome: string } }) => p.categoria.nome.toLowerCase() === 'notebook')
      : false

    const dominioAtivo = temNotebook && d.notebooksComDominio === true
    if (dominioAtivo && !d.tipoDominio) {
      return NextResponse.json(
        { message: 'Selecione o tipo de domínio (Educacional ou Administrativo) para os notebooks desta solicitação.' },
        { status: 400 }
      )
    }
    // Sem notebook ou domínio desligado: sempre normalizado para null,
    // mesmo que o payload tente enviar um tipo — nunca rejeitado nesse caso.
    const notebooksComDominioFinal = temNotebook ? dominioAtivo : null
    const tipoDominioFinal = dominioAtivo ? d.tipoDominio! : null

    const resultado = await prisma.$transaction(async (tx) => {
      // Revalidação de disponibilidade dentro da transação (proteção contra
      // condição de corrida — combinada com a constraint única de item).
      //
      // Atendimento Imediato (Etapa 4): não reserva uma data/período futuro
      // (o atendimento já está acontecendo agora), então a checagem por
      // data/período não se aplica. Em vez disso, verifica-se apenas se o
      // bem já está fisicamente em uso (EM_UTILIZACAO, ainda não devolvido)
      // — reservas futuras não bloqueiam o atendimento imediato, pois o bem
      // continua fisicamente disponível no Patrimônio até a retirada.
      if (d.patrimonioIds.length > 0) {
        const patrimonios = await tx.patrimonio.findMany({ where: { id: { in: d.patrimonioIds } } })
        if (patrimonios.length !== d.patrimonioIds.length || patrimonios.some((p: { ativo: boolean }) => !p.ativo)) {
          throw new ErroNegocio('Um ou mais bens selecionados não estão mais disponíveis.')
        }

        if (d.origem === 'ATENDIMENTO_IMEDIATO') {
          const emUso = await tx.solicitacao.findMany({
            where: {
              status: 'EM_UTILIZACAO',
              itensPatrimonio: { some: { patrimonioId: { in: d.patrimonioIds } } },
            },
            select: { itensPatrimonio: { select: { patrimonioId: true } } },
          })
          const idsEmUso = new Set(
            emUso.flatMap((s: { itensPatrimonio: { patrimonioId: string }[] }) => s.itensPatrimonio.map((i) => i.patrimonioId))
          )
          const conflito = d.patrimonioIds.find((id) => idsEmUso.has(id))
          if (conflito) {
            throw new ErroNegocio('Este bem já está em uso no momento e não pode ser atendido imediatamente.')
          }
        } else {
          const conflitantes = await tx.solicitacao.findMany({
            where: {
              data: dataObj,
              status: { in: STATUS_BLOQUEIAM_DISPONIBILIDADE },
              periodos: { hasSome: d.periodos as PeriodoSolicitacao[] },
              itensPatrimonio: { some: { patrimonioId: { in: d.patrimonioIds } } },
            },
            select: { itensPatrimonio: { select: { patrimonioId: true } } },
          })
          const idsOcupados = new Set(
            conflitantes.flatMap((s: { itensPatrimonio: { patrimonioId: string }[] }) =>
              s.itensPatrimonio.map((i: { patrimonioId: string }) => i.patrimonioId)
            )
          )
          const conflito = d.patrimonioIds.find((id) => idsOcupados.has(id))
          if (conflito) {
            throw new ErroNegocio('Este bem deixou de estar disponível para a data e período selecionados.')
          }
        }
      }

      // Serviços/Movimentações (Fase 3 — Etapa 3): valida que os tipos
      // selecionados existem e estão ativos, mesmo padrão de segurança já
      // usado para bens patrimoniais.
      if (d.servicos.length > 0) {
        const tiposServicoIds = d.servicos.map((s) => s.tipoServicoId)
        const tiposServico = await tx.tipoServico.findMany({ where: { id: { in: tiposServicoIds } } })
        if (tiposServico.length !== new Set(tiposServicoIds).size || tiposServico.some((t: { ativo: boolean }) => !t.ativo)) {
          throw new ErroNegocio('Um ou mais serviços selecionados não estão mais disponíveis.')
        }
      }

      const statusInicial: StatusSolicitacao =
        d.origem === 'ATENDIMENTO_IMEDIATO'
          ? d.patrimonioIds.length > 0
            ? 'EM_UTILIZACAO'
            : 'FINALIZADA'
          : tipoEmprestimoFinal === 'externo'
            ? 'AGUARDANDO_GESTOR'
            : 'AGUARDANDO_PATRIMONIO'

      // Fase 3: calcula e persiste a situação de prazo no momento exato da
      // criação — nunca recalculado depois (ver src/lib/prazo.ts). Vale
      // igualmente para solicitações que contenham apenas serviços — o
      // prazo é da solicitação como um todo, não por tipo de item.
      //
      // Atendimento Imediato (Etapa 4): NÃO se aplica o conceito de prazo/
      // antecedência — não houve reserva antecipada para haver antecedência
      // a medir. Os campos ficam explicitamente nulos (nunca entram nos
      // indicadores de dentro/fora do prazo).
      const prazo = d.origem === 'ATENDIMENTO_IMEDIATO' ? null : calcularPrazo(tipoEmprestimoFinal, dataObj, d.periodos as PeriodoSolicitacao[])

      const agora = new Date()

      const solicitacao = await tx.solicitacao.create({
        data: {
          tipoEmprestimo: tipoEmprestimoFinal,
          origem: d.origem,
          solicitanteId: solicitanteIdEfetivo,
          criadoPorId: validacao.user.id,
          ambiente: tipoEmprestimoFinal === 'interno' ? d.ambiente : null,
          finalidade: d.finalidade,
          atividadeExterna: tipoEmprestimoFinal === 'externo' ? d.atividadeExterna : null,
          local: tipoEmprestimoFinal === 'externo' ? d.local : null,
          cidade: tipoEmprestimoFinal === 'externo' ? d.cidade : null,
          gestorId: tipoEmprestimoFinal === 'externo' ? d.gestorId : null,
          observacoes: d.observacoes,
          data: dataObj,
          periodos: d.periodos as PeriodoSolicitacao[],
          notebooksComDominio: notebooksComDominioFinal,
          tipoDominio: tipoDominioFinal,
          status: statusInicial,
          prazoHoras: prazo?.prazoHoras,
          antecedenciaMinutos: prazo?.antecedenciaMinutos,
          dentroDoPrazo: prazo?.dentroDoPrazo,
          prazoReferenciaEm: prazo?.prazoReferenciaEm,
          // Atendimento Imediato com bem patrimonial: a retirada já
          // aconteceu no ato do registro, reaproveitando os mesmos campos
          // usados pelo fluxo normal de retirada (permite usar a ação
          // "Registrar devolução" já existente sem nenhum código novo).
          ...(statusInicial === 'EM_UTILIZACAO' && d.origem === 'ATENDIMENTO_IMEDIATO'
            ? { retiradaEm: agora, retiradaPorId: validacao.user.id }
            : {}),
          itensPatrimonio: {
            create: d.patrimonioIds.map((patrimonioId) => ({ patrimonioId })),
          },
          itensPapelaria: {
            create: d.itensPapelaria.map((i) => ({ descricao: i.descricao, quantidade: i.quantidade })),
          },
          itensServico: {
            create: d.servicos.map((s) => ({
              tipoServicoId: s.tipoServicoId,
              quantidade: s.quantidade,
              ambiente: s.ambiente,
              observacao: s.observacao,
            })),
          },
        },
        include: includePadrao,
      })

      await registrarHistorico(tx, {
        solicitacaoId: solicitacao.id,
        usuarioId: validacao.user.id,
        acao: 'CRIACAO',
        statusNovo: statusInicial,
        descricao:
          d.origem === 'ATENDIMENTO_IMEDIATO'
            ? `Atendimento imediato registrado por ${validacao.user.nome}.`
            : `Solicitação criada (${tipoEmprestimoFinal === 'externo' ? 'empréstimo externo' : 'empréstimo interno'}).`,
      })

      // Etapa email-gestor-pendente: evento de e-mail criado na MESMA
      // transação que persiste a solicitação com status AGUARDANDO_GESTOR
      // — nunca antes disso estar consistente. Vazio para qualquer outro
      // caso (interna, Atendimento Imediato, ou externa sem gestor válido
      // — este último nem chega aqui, já barrado antes da transação).
      let eventoAguardandoGestor: { eventoId: string; payload: SolicitacaoAguardandoGestorPayloadV1 } | null = null

      // Etapa email-patrimonio-solicitacao-interna: reaproveita o MESMO
      // evento/template/payload já usado por SOLICITACAO_AGUARDANDO_PATRIMONIO
      // em /aprovar-gestor (fluxo externo, após aprovação do gestor) — aqui
      // é para o fluxo INTERNO, que já nasce em AGUARDANDO_PATRIMONIO sem
      // gestor envolvido. Um evento por membro ativo da equipe Patrimônio.
      const eventosAguardandoPatrimonio: { eventoId: string; payload: SolicitacaoAguardandoPatrimonioPayloadV1 }[] = []

      // Atendimento Imediato já nasce resolvido (EM_UTILIZACAO ou
      // FINALIZADA) — não há gestor nem Patrimônio para notificar sobre uma
      // decisão pendente, pois não existe decisão pendente.
      if (d.origem !== 'ATENDIMENTO_IMEDIATO') {
        if (statusInicial === 'AGUARDANDO_GESTOR' && d.gestorId) {
          await criarNotificacao(tx, {
            usuarioId: d.gestorId,
            solicitacaoId: solicitacao.id,
            titulo: 'Nova atividade externa para aprovação',
            mensagem: `A solicitação #${solicitacao.numero} aguarda sua decisão.`,
            tipo: 'APROVACAO_GESTOR',
          })

          // SOLICITACAO_AGUARDANDO_GESTOR (Etapa email-gestor-pendente) —
          // exclusivo do gestor indicado; nunca ao solicitante, ao
          // Patrimônio nem a administradores nesta etapa. AGUARDANDO_GESTOR
          // só existe para tipoEmprestimo='externo' (ver statusInicial
          // acima), então solicitacao.gestor sempre existe aqui — mesma
          // garantia já usada pela validação de gestor antes da transação.
          const gestor = solicitacao.gestor!
          const dadosParaSnapshot: ConstruirPayloadSolicitacaoAguardandoGestorInput = {
            numero: solicitacao.numero,
            nomeGestor: gestor.nome,
            nomeSolicitante: solicitacao.solicitante.nome,
            data: solicitacao.data,
            periodos: solicitacao.periodos,
            finalidade: solicitacao.finalidade,
            atividadeExterna: solicitacao.atividadeExterna,
            local: solicitacao.local,
            cidade: solicitacao.cidade,
            observacoes: solicitacao.observacoes,
            itensPatrimonio: solicitacao.itensPatrimonio.map((item) => ({
              numero: item.patrimonio.numero,
              marca: item.patrimonio.marca,
              modelo: item.patrimonio.modelo,
              categoria: item.patrimonio.categoria.nome,
            })),
            itensPapelaria: solicitacao.itensPapelaria,
            itensServico: solicitacao.itensServico.map((item) => ({
              tipoServicoNome: item.tipoServico.nome,
              quantidade: item.quantidade,
              ambiente: item.ambiente,
            })),
            notebooksComDominio: solicitacao.notebooksComDominio,
            tipoDominio: solicitacao.tipoDominio,
          }
          const payload = construirPayloadSolicitacaoAguardandoGestor(dadosParaSnapshot)
          const evento = await tx.emailEvento.create({
            data: {
              solicitacaoId: solicitacao.id,
              tipo: 'SOLICITACAO_AGUARDANDO_GESTOR',
              destinatario: gestor.email,
              status: 'PENDENTE',
              tentativas: 0,
              payload: payload as unknown as Prisma.InputJsonValue,
            },
          })
          eventoAguardandoGestor = { eventoId: evento.id, payload }
        } else {
          // Etapa email-patrimonio-solicitacao-interna: mesma leitura
          // reaproveitada como gate de elegibilidade do e-mail logo abaixo,
          // sem segunda query à equipe Patrimônio (mesmo padrão de
          // /aprovar-gestor). Só `id` no select (Etapa
          // email-patrimonio-caixa-grupo: o e-mail de cada membro deixou de
          // ser necessário — o e-mail de grupo agora vem de
          // EMAIL_PATRIMONIO_RECIPIENT, não do banco).
          const equipePatrimonio = await tx.user.findMany({
            where: { ativo: true, permissao: 'patrimonio' },
            select: { id: true },
          })
          for (const membro of equipePatrimonio) {
            await criarNotificacao(tx, {
              usuarioId: membro.id,
              solicitacaoId: solicitacao.id,
              titulo: 'Nova solicitação aguardando análise',
              mensagem: `A solicitação #${solicitacao.numero} está aguardando análise do Patrimônio.`,
              tipo: 'ANALISE_PATRIMONIO',
            })
          }

          // Sem membro ativo do Patrimônio: a solicitação segue criada
          // normalmente — `destinatarios` fica vazio, nenhum EmailEvento é
          // criado (mesmo comportamento de /aprovar-gestor).
          if (equipePatrimonio.length > 0) {
            const dadosParaSnapshot: ConstruirPayloadSolicitacaoAguardandoPatrimonioInput = {
              numero: solicitacao.numero,
              nomeSolicitante: solicitacao.solicitante.nome,
              // Solicitação interna nasce direto em AGUARDANDO_PATRIMONIO —
              // não existe gestor aprovador nem atividade externa/local/
              // cidade envolvidos (ver payloads/solicitacao-aguardando-patrimonio.ts).
              nomeGestorAprovador: null,
              tipoEmprestimo: 'interno',
              data: solicitacao.data,
              periodos: solicitacao.periodos,
              ambiente: solicitacao.ambiente,
              finalidade: solicitacao.finalidade,
              atividadeExterna: null,
              local: null,
              cidade: null,
              observacoes: solicitacao.observacoes,
              itensPatrimonio: solicitacao.itensPatrimonio.map((item) => ({
                numero: item.patrimonio.numero,
                marca: item.patrimonio.marca,
                modelo: item.patrimonio.modelo,
                categoria: item.patrimonio.categoria.nome,
              })),
              itensPapelaria: solicitacao.itensPapelaria,
              itensServico: solicitacao.itensServico.map((item) => ({
                tipoServicoNome: item.tipoServico.nome,
                quantidade: item.quantidade,
                ambiente: item.ambiente,
              })),
              notebooksComDominio: solicitacao.notebooksComDominio,
              tipoDominio: solicitacao.tipoDominio,
            }
            // Um único payload — IDÊNTICO para todos os destinatários (mesmo
            // princípio de /aprovar-gestor: não há `papel` a variar aqui).
            const payload = construirPayloadSolicitacaoAguardandoPatrimonio(dadosParaSnapshot)

            // Caixa de grupo do Patrimônio (Etapa
            // email-patrimonio-caixa-grupo): `equipePatrimonio.length > 0`
            // (já sabido pelo `if` acima) é o gate de elegibilidade — o
            // mesmo de sempre, só que agora resolve para NO MÁXIMO 1
            // EmailEvento (a caixa de grupo), nunca mais um por membro.
            // Mesmo helper de dedup usado por /aprovar-gestor —
            // `emailSolicitante: null` descarta deliberadamente o branch
            // "solicitante" (este e-mail nunca vai para o solicitante).
            const emailPatrimonio = resolverEmailPatrimonioOuNull('SOLICITACAO_AGUARDANDO_PATRIMONIO')
            const destinatarios = deduplicarDestinatarios(null, emailPatrimonio)

            for (const destinatario of destinatarios) {
              // Solicitação recém-criada (id novo) — nunca há EmailEvento
              // preexistente para esse [solicitacaoId, tipo, destinatario],
              // então `create` simples é suficiente (mesmo padrão já usado
              // acima para SOLICITACAO_AGUARDANDO_GESTOR nesta mesma rota;
              // diferente de /aprovar-gestor, que usa upsert por poder ser
              // chamada mais de uma vez sobre a MESMA solicitação).
              const evento = await tx.emailEvento.create({
                data: {
                  solicitacaoId: solicitacao.id,
                  tipo: 'SOLICITACAO_AGUARDANDO_PATRIMONIO',
                  destinatario: destinatario.email,
                  status: 'PENDENTE',
                  tentativas: 0,
                  payload: payload as unknown as Prisma.InputJsonValue,
                },
              })
              eventosAguardandoPatrimonio.push({ eventoId: evento.id, payload })
            }
          }
        }
      }

      if (solicitanteIdEfetivo !== validacao.user.id) {
        await criarNotificacao(tx, {
          usuarioId: solicitanteIdEfetivo,
          solicitacaoId: solicitacao.id,
          titulo: d.origem === 'ATENDIMENTO_IMEDIATO' ? 'Atendimento imediato registrado em seu nome' : 'Solicitação criada em seu nome',
          mensagem:
            d.origem === 'ATENDIMENTO_IMEDIATO'
              ? `${validacao.user.nome} registrou um atendimento imediato #${solicitacao.numero} para você.`
              : `${validacao.user.nome} criou a solicitação #${solicitacao.numero} para você.`,
          tipo: 'CRIACAO',
        })
      }

      return { solicitacao, eventoAguardandoGestor, eventosAguardandoPatrimonio }
    }, {
      // Correção pós-P2028 em produção (Vercel/serverless): esta transação
      // é a única, entre as 12 que o projeto usa, cujo caminho AGUARDANDO_
      // PATRIMONIO/interno soma DOIS loops sequenciais escaláveis com o
      // tamanho da equipe Patrimônio ativa — um `criarNotificacao` e um
      // `tx.emailEvento.create` por destinatário — em cima das ~5 queries
      // fixas já existentes (revalidação de disponibilidade/serviços,
      // create da solicitação, histórico, findMany da equipe). Cada `await
      // tx.*` é um round-trip de rede real ao pooler do Supabase; os
      // defaults do Prisma (maxWait: 2000ms, timeout: 5000ms) foram
      // dimensionados para poucas queries locais de baixa latência, não
      // para essa cadeia crescendo linearmente com N destinatários a
      // partir de uma function serverless (latência por round-trip maior
      // e mais variável que em dev local). Ao estourar o timeout, o
      // Prisma encerra a transação "por baixo" — a próxima chamada em
      // `tx` (aqui, tipicamente um `emailEvento.create` no meio do loop)
      // falha com P2028 ("Transaction not found"), não com um erro de
      // timeout explícito.
      //
      // maxWait: 5000 — tempo para OBTER a transação (conexão do pool),
      // não para executá-la; o default de 2000ms já é justo em dev local,
      // mais ainda sob contenção do pooler compartilhado em serverless.
      // timeout: 15000 — cobre confortavelmente o pior caso hoje (equipe
      // Patrimônio pequena, poucas dezenas de round-trips) sem virar um
      // valor arbitrariamente alto só para mascarar lentidão — se a
      // equipe crescer a ponto de aproximar desse teto, o sinal certo é
      // otimizar as queries desta rota, não alargar o timeout de novo.
      maxWait: 5000,
      timeout: 15000,
    })

    // Fora da transação (mesmo padrão de /confirmar-patrimonio e
    // /assinatura/confirmar — ver comentários lá): a intenção de envio já
    // foi commitada como EmailEvento PENDENTE junto da criação da
    // solicitação. O envio real acontece só agora — uma falha do provedor
    // aqui nunca desfaz a criação nem afeta a resposta desta rota
    // (processarEmailEvento nunca lança). Fonte exclusiva: o payload já
    // persistido no commit acima (nunca reconstruído a partir de
    // `resultado.solicitacao`) — mesma leitura que o dispatcher usará se
    // este processo morrer antes de chegar aqui. aindaValido (mesma regra
    // do dispatcher — ver validade-evento.ts) protege contra a janela
    // entre o commit e este envio: se a solicitação já tiver sido
    // aprovada/rejeitada/cancelada nesse meio-tempo, o evento vira
    // OBSOLETO em vez de notificar uma decisão que já não existe mais.
    if (resultado.eventoAguardandoGestor) {
      const { eventoId, payload } = resultado.eventoAguardandoGestor
      await processarEmailEvento(
        eventoId,
        (ctx) => renderSolicitacaoAguardandoGestorFromPayload(payload, buildAppUrl(`/solicitacoes/${resultado.solicitacao.id}`), ctx.bannerDestinatarioOriginal),
        { aindaValido: criarValidadorDeEvento('SOLICITACAO_AGUARDANDO_GESTOR', resultado.solicitacao.id) ?? undefined }
      )
    }

    // Etapa email-patrimonio-solicitacao-interna: mesmo padrão acima, mas
    // podem existir vários eventos (um por membro da equipe Patrimônio) —
    // allSettled (mesmo princípio de /aprovar-gestor) para que a falha de
    // um destinatário nunca afete a resposta desta rota nem os demais envios.
    if (resultado.eventosAguardandoPatrimonio.length > 0) {
      const resultadosEnvio = await Promise.allSettled(
        resultado.eventosAguardandoPatrimonio.map((evento) =>
          processarEmailEvento(
            evento.eventoId,
            (ctx) =>
              renderSolicitacaoAguardandoPatrimonioFromPayload(evento.payload, buildAppUrl(`/solicitacoes/${resultado.solicitacao.id}`), ctx.bannerDestinatarioOriginal),
            { aindaValido: criarValidadorDeEvento('SOLICITACAO_AGUARDANDO_PATRIMONIO', resultado.solicitacao.id) ?? undefined }
          )
        )
      )
      for (const envio of resultadosEnvio) {
        if (envio.status === 'rejected') {
          console.error(
            'SOLICITACAO_AGUARDANDO_PATRIMONIO: falha inesperada ao processar e-mail pós-commit (criação da solicitação não é afetada):',
            envio.reason instanceof Error ? envio.reason.message : envio.reason
          )
        }
      }
    }

    return NextResponse.json({ solicitacao: resultado.solicitacao }, { status: 201 })
  } catch (e) {
    if (e instanceof ErroNegocio) {
      return NextResponse.json({ message: e.message }, { status: 409 })
    }
    console.error(e)
    return NextResponse.json({ message: 'Erro interno no servidor.' }, { status: 500 })
  }
}

class ErroNegocio extends Error {}
