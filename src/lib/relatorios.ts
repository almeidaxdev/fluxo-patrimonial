// src/lib/relatorios.ts
//
// Backend de Relatórios (Fase 3 — Etapa 5).
//
// Princípios seguidos em todo este arquivo (ver documento da Fase 3):
//   1) "Total de solicitações" SEMPRE conta linhas distintas da tabela
//      `Solicitacao` (nunca soma linhas de itens) — uma solicitação com
//      patrimônio + papelaria + serviço continua sendo 1 solicitação.
//   2) Atendimento Imediato NUNCA entra no denominador do cumprimento de
//      prazo (ele não tem antecedência para medir).
//   3) Todas as agregações rodam no Postgres (count/groupBy/aggregate),
//      nunca carregando todas as linhas para somar em memória.
//   4) Nenhuma consulta individual por linha (sem N+1) — os poucos loops
//      existentes (evolução mensal) rodam um número FIXO e pequeno de
//      queries agregadas em paralelo (Promise.all), nunca uma query por
//      registro do banco.

import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { StatusSolicitacao, TipoEmprestimo, PeriodoSolicitacao, STATUS_SOLICITACAO_LABELS } from '@/types'
import { normalizarItemPapelaria } from '@/lib/relatorios-formatacao'
import { tipoEmprestimoEnum, origemEnum, statusSolicitacaoEnum, periodoEnum } from '@/lib/validations'
import { dataValida } from '@/lib/query-params'

// Etapa security/input-hardening-b2: até aqui, `tipoEmprestimo`/`origem`/
// `status`/`periodo` chegavam de `searchParams.get(...) as Tipo` sem
// nenhuma checagem — um valor arbitrário na query string seria repassado
// direto ao `where` do Prisma, que rejeita o enum inválido com uma exceção
// genérica (os 4 endpoints que usam `construirFiltros` — resumo,
// operacional, pdf, excel — capturam qualquer erro como 500 "Não foi
// possível..."). Esta classe permite aos 4 chamadores distinguir "filtro
// inválido" (400, mensagem amigável) de uma falha interna de verdade (500).
export class FiltroRelatorioInvalidoError extends Error {}

// Espelha exatamente STATUS_ENCERRADOS usado na interface — status que não
// representam mais uma pendência operacional. NAO_RETIRADA é terminal
// (Etapa 9A-B): nenhuma ação adicional é esperada sobre a solicitação.
const STATUS_FINAIS: StatusSolicitacao[] = ['FINALIZADA', 'CANCELADA', 'REJEITADA_GESTOR', 'REJEITADA_PATRIMONIO', 'NAO_RETIRADA']

// =============================================================================
// FILTROS
// =============================================================================

export interface FiltrosRelatorio {
  where: Prisma.SolicitacaoWhereInput
  dataInicio: Date | null
  dataFim: Date | null
  mesAnoUnico: string | null // 'YYYY-MM' quando o filtro é um único mês (habilita comparativo com mês anterior)
}

function primeiroDiaDoMes(mesAno: string): Date {
  const [ano, mes] = mesAno.split('-').map(Number)
  return new Date(Date.UTC(ano, mes - 1, 1))
}

function primeiroDiaDoProximoMes(mesAno: string): Date {
  const [ano, mes] = mesAno.split('-').map(Number)
  return new Date(Date.UTC(ano, mes, 1)) // mes (0-indexed +1) já é o mês seguinte
}

function mesAnterior(mesAno: string): string {
  const [ano, mes] = mesAno.split('-').map(Number)
  const d = new Date(Date.UTC(ano, mes - 2, 1)) // mes-1 (0-idx) -1 = mês anterior
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * Rótulo do período selecionado (mês, intervalo personalizado ou "todos") —
 * compartilhado por PDF e Excel para nunca divergir na descrição do
 * cabeçalho do relatório.
 */
export function periodoLabel(params: URLSearchParams): string {
  const mes = params.get('mes')
  if (mes) {
    const [ano, numeroMes] = mes.split('-').map(Number)
    return new Date(ano, numeroMes - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })
  }
  const inicio = params.get('dataInicio')
  const fim = params.get('dataFim')
  const fmt = (v: string) => new Date(`${v}T00:00:00Z`).toLocaleDateString('pt-BR', { timeZone: 'UTC' })
  if (inicio && fim) return `${fmt(inicio)} a ${fmt(fim)}`
  if (inicio) return `A partir de ${fmt(inicio)}`
  if (fim) return `Até ${fmt(fim)}`
  return 'Todos os períodos'
}

/**
 * Lista legível dos filtros ativos (nunca inclui "Todos" — só aparece o que
 * o usuário de fato restringiu) — compartilhada por PDF e Excel.
 */
export async function filtrosAplicados(params: URLSearchParams): Promise<string[]> {
  const filtros: string[] = []
  const tipo = params.get('tipoEmprestimo')
  if (tipo) filtros.push(tipo === 'interno' ? 'Interna' : 'Externa')
  const origem = params.get('origem')
  if (origem) filtros.push(origem === 'RESERVA' ? 'Reserva antecipada' : 'Atendimento imediato')
  const prazo = params.get('prazo')
  if (prazo) filtros.push(prazo === 'dentro' ? 'Dentro do prazo' : 'Fora do prazo')
  const periodo = params.get('periodo')
  if (periodo) filtros.push(periodo === 'MANHA' ? 'Manhã' : periodo === 'TARDE' ? 'Tarde' : 'Noite')
  const status = params.get('status') as keyof typeof STATUS_SOLICITACAO_LABELS | null
  if (status && STATUS_SOLICITACAO_LABELS[status]) filtros.push(STATUS_SOLICITACAO_LABELS[status])
  if (params.get('pendente') === 'true') filtros.push('Pendentes')
  // Rótulo reflete a semântica real do filtro (Etapa 9A-B): esta é a regra
  // DERIVADA (retirada vencida sem registro manual) — não confundir com o
  // KPI oficial "Não retiradas", que agora conta status=NAO_RETIRADA.
  if (params.get('naoRetirada') === 'true') filtros.push('Retirada vencida sem registro')

  const categoriaId = params.get('categoriaId')
  const tipoServicoId = params.get('tipoServicoId')
  const [categoria, servico] = await Promise.all([
    categoriaId ? prisma.categoriaPatrimonio.findUnique({ where: { id: categoriaId }, select: { nome: true } }) : null,
    tipoServicoId ? prisma.tipoServico.findUnique({ where: { id: tipoServicoId }, select: { nome: true } }) : null,
  ])
  if (categoria) filtros.push(`Categoria: ${categoria.nome}`)
  if (servico) filtros.push(`Serviço: ${servico.nome}`)
  return filtros
}

/**
 * Monta o filtro (`where`) do Prisma a partir dos query params da requisição.
 * Compartilhado por TODOS os endpoints de relatório — garante que "resumo"
 * e "operacional" apliquem exatamente a mesma regra de filtragem.
 */
export function construirFiltros(searchParams: URLSearchParams): FiltrosRelatorio {
  // Etapa security/input-hardening-b3: os 3 chegavam direto para
  // `mesAno.split('-').map(Number)` / `new Date(...)` — uma string
  // não-data vira NaN/`Invalid Date`, propagado sem checagem até o `where`
  // do Prisma (exceção genérica capturada como 500 pelos 4 endpoints).
  const mes = searchParams.get('mes') // 'YYYY-MM'
  if (mes !== null && !/^\d{4}-\d{2}$/.test(mes)) {
    throw new FiltroRelatorioInvalidoError('Mês inválido.')
  }
  const dataInicioParam = searchParams.get('dataInicio')
  if (dataInicioParam !== null && !dataValida(dataInicioParam)) {
    throw new FiltroRelatorioInvalidoError('Data inicial inválida.')
  }
  const dataFimParam = searchParams.get('dataFim')
  if (dataFimParam !== null && !dataValida(dataFimParam)) {
    throw new FiltroRelatorioInvalidoError('Data final inválida.')
  }

  // Etapa security/input-hardening-b2: cada um destes 4 é um conjunto
  // fechado (enum) usado só como FILTRO — nunca gravado — mas continuava
  // chegando via `as Tipo` sem checagem nenhuma. Validados aqui, no ÚNICO
  // ponto compartilhado pelos 4 endpoints de relatório (resumo, operacional,
  // pdf, excel), para nunca precisar repetir a mesma validação 4 vezes.
  const tipoEmprestimoParam = searchParams.get('tipoEmprestimo')
  if (tipoEmprestimoParam !== null && !tipoEmprestimoEnum.safeParse(tipoEmprestimoParam).success) {
    throw new FiltroRelatorioInvalidoError('Tipo de empréstimo inválido.')
  }
  const tipoEmprestimo = tipoEmprestimoParam as TipoEmprestimo | null

  const origemParam = searchParams.get('origem')
  if (origemParam !== null && !origemEnum.safeParse(origemParam).success) {
    throw new FiltroRelatorioInvalidoError('Origem inválida.')
  }
  const origem = origemParam as 'RESERVA' | 'ATENDIMENTO_IMEDIATO' | null

  const prazo = searchParams.get('prazo') // 'dentro' | 'fora'

  const statusParam = searchParams.get('status')
  if (statusParam !== null && !statusSolicitacaoEnum.safeParse(statusParam).success) {
    throw new FiltroRelatorioInvalidoError('Status inválido.')
  }
  const status = statusParam as StatusSolicitacao | null

  const categoriaId = searchParams.get('categoriaId')
  const tipoServicoId = searchParams.get('tipoServicoId')

  const periodoParam = searchParams.get('periodo')
  if (periodoParam !== null && !periodoEnum.safeParse(periodoParam).success) {
    throw new FiltroRelatorioInvalidoError('Período inválido.')
  }
  const periodo = periodoParam as PeriodoSolicitacao | null
  // Atalhos rápidos (Etapa 6 — refinamento): não introduzem lógica nova,
  // apenas aplicam via filtro os mesmos critérios já usados nas agregações
  // (STATUS_FINAIS espelha exatamente os status considerados "encerrados"
  // no restante do relatório). `naoRetirada` (nome do parâmetro preservado
  // por compatibilidade) filtra a métrica DERIVADA "retirada vencida sem
  // registro" — não o status real NAO_RETIRADA (ver calcularOperacao).
  const pendente = searchParams.get('pendente') === 'true'
  const naoRetirada = searchParams.get('naoRetirada') === 'true'

  const where: Prisma.SolicitacaoWhereInput = {}
  let dataInicio: Date | null = null
  let dataFim: Date | null = null
  let mesAnoUnico: string | null = null

  if (mes) {
    dataInicio = primeiroDiaDoMes(mes)
    dataFim = primeiroDiaDoProximoMes(mes)
    mesAnoUnico = mes
  } else if (dataInicioParam || dataFimParam) {
    if (dataInicioParam) dataInicio = new Date(dataInicioParam)
    if (dataFimParam) {
      // `lt` (exclusivo) no dia seguinte ao informado, para incluir o dia final por inteiro.
      const f = new Date(dataFimParam)
      f.setUTCDate(f.getUTCDate() + 1)
      dataFim = f
    }
  }

  if (dataInicio || dataFim) {
    where.data = {
      ...(dataInicio ? { gte: dataInicio } : {}),
      ...(dataFim ? { lt: dataFim } : {}),
    }
  }

  if (tipoEmprestimo) where.tipoEmprestimo = tipoEmprestimo
  if (origem) where.origem = origem
  if (status) where.status = status
  if (prazo === 'dentro') where.dentroDoPrazo = true
  if (prazo === 'fora') where.dentroDoPrazo = false
  if (categoriaId) where.itensPatrimonio = { some: { patrimonio: { categoriaId } } }
  if (tipoServicoId) where.itensServico = { some: { tipoServicoId } }
  if (periodo) where.periodos = { has: periodo }

  if (pendente) {
    where.status = { notIn: STATUS_FINAIS }
  }
  if (naoRetirada) {
    // Mesma regra de "retirada vencida sem registro" documentada em
    // calcularOperacao: PRONTA_RETIRADA, nunca retirada, e a data de
    // utilização já passou. O limite superior nunca
    // pode ser mais permissivo que o período já filtrado (mes/dataFim) —
    // por isso usa o MENOR entre o fim do período selecionado e hoje, em
    // vez de simplesmente sobrescrever `lt` com hoje.
    const hoje = new Date()
    hoje.setUTCHours(0, 0, 0, 0)
    const dataAtual = (typeof where.data === 'object' && where.data ? where.data : {}) as Prisma.DateTimeFilter
    const ltExistente = dataAtual.lt instanceof Date ? dataAtual.lt : undefined
    where.status = 'PRONTA_RETIRADA'
    where.retiradaEm = null
    where.data = { ...dataAtual, lt: ltExistente && ltExistente < hoje ? ltExistente : hoje }
  }

  return { where, dataInicio, dataFim, mesAnoUnico }
}

/**
 * Adiciona um predicado INTERNO (usado para calcular uma métrica derivada,
 * ex.: origem=RESERVA para "reservas antecipadas") ao filtro já escolhido
 * pelo usuário, sem jamais sobrescrever um campo que o usuário já tenha
 * filtrado — usa `AND` do Prisma em vez de espalhar (`{...where, campo}`).
 * Se o predicado interno colidir com o filtro do usuário (ex.: usuário
 * filtrou origem=ATENDIMENTO_IMEDIATO e a métrica pede origem=RESERVA), o
 * resultado é corretamente 0 — o recorte filtrado não tem nenhuma linha que
 * satisfaça as duas condições — em vez de ignorar silenciosamente o filtro
 * do usuário e contar fora do recorte selecionado.
 */
function comFiltroAdicional(
  where: Prisma.SolicitacaoWhereInput,
  predicadoInterno: Prisma.SolicitacaoWhereInput
): Prisma.SolicitacaoWhereInput {
  return { AND: [where, predicadoInterno] }
}

function whereComPeriodo(where: Prisma.SolicitacaoWhereInput, inicio: Date, fim: Date): Prisma.SolicitacaoWhereInput {
  // Substitui apenas o filtro de data, preservando os demais filtros ativos
  // (tipo, origem, status, categoria, serviço) — usado na evolução mensal e
  // no comparativo com o mês anterior.
  const { data: _ignorado, ...resto } = where
  void _ignorado
  return { ...resto, data: { gte: inicio, lt: fim } }
}

// =============================================================================
// RESUMO COMPLETO (KPIs principais + prazo + status + operação)
// =============================================================================

export interface ResumoBasico {
  total: number
  internas: number
  externas: number
  reservasAntecipadas: number
  atendimentosImediatos: number
  dentroPrazo: number
  foraPrazo: number
  percentualDentroPrazo: number | null // null quando não há nenhuma reserva com prazo mensurável
}

/**
 * Núcleo dos KPIs — usado tanto para o período principal quanto (com um
 * `where` diferente) para o mês anterior e para cada mês da evolução
 * mensal. Mantém a MESMA lógica de cálculo em todos os casos.
 */
export async function calcularResumoBasico(where: Prisma.SolicitacaoWhereInput): Promise<ResumoBasico> {
  // Uma única groupBy por (tipoEmprestimo, origem, dentroDoPrazo) substitui
  // as 6 contagens separadas anteriores. `groupBy` nunca sobrescreve nada
  // de `where` — só agrupa dentro do recorte já filtrado — então o
  // resultado somado por grupo é idêntico ao das 6 contagens, numa única
  // consulta (Rodada 2 — otimização de performance, mesmos números da
  // Rodada 1). `tipoEmprestimo` e `origem` são enums não-nulos e exaustivos
  // (interno/externo; RESERVA/ATENDIMENTO_IMEDIATO), então somar os grupos
  // reproduz exatamente os totais anteriores.
  const grupos = await prisma.solicitacao.groupBy({
    by: ['tipoEmprestimo', 'origem', 'dentroDoPrazo'],
    where,
    _count: true,
  })

  let total = 0
  let internas = 0
  let externas = 0
  let reservasAntecipadas = 0
  let atendimentosImediatos = 0
  let dentroPrazo = 0
  let foraPrazo = 0

  for (const g of grupos as { tipoEmprestimo: string; origem: string; dentroDoPrazo: boolean | null; _count: number }[]) {
    total += g._count
    if (g.tipoEmprestimo === 'interno') internas += g._count
    else if (g.tipoEmprestimo === 'externo') externas += g._count

    if (g.origem === 'RESERVA') {
      reservasAntecipadas += g._count
      // Cumprimento de prazo: SOMENTE origem=RESERVA entra no cálculo — um
      // atendimento imediato tem dentroDoPrazo=null e nunca é contado aqui.
      if (g.dentroDoPrazo === true) dentroPrazo += g._count
      else if (g.dentroDoPrazo === false) foraPrazo += g._count
    } else if (g.origem === 'ATENDIMENTO_IMEDIATO') {
      atendimentosImediatos += g._count
    }
  }

  const totalComPrazoMensuravel = dentroPrazo + foraPrazo
  const percentualDentroPrazo = totalComPrazoMensuravel > 0 ? (dentroPrazo / totalComPrazoMensuravel) * 100 : null

  return { total, internas, externas, reservasAntecipadas, atendimentosImediatos, dentroPrazo, foraPrazo, percentualDentroPrazo }
}

export interface DistribuicaoStatus {
  status: StatusSolicitacao
  quantidade: number
}

export async function calcularDistribuicaoStatus(where: Prisma.SolicitacaoWhereInput): Promise<DistribuicaoStatus[]> {
  const grupos = await prisma.solicitacao.groupBy({ by: ['status'], where, _count: true })
  return grupos.map((g: { status: StatusSolicitacao; _count: number }) => ({ status: g.status, quantidade: g._count }))
}

export interface OperacaoResumo {
  retiradas: number
  naoRetiradas: number
  // NOVO (Etapa 9A-B): indicador operacional SEPARADO — nunca somado a
  // `naoRetiradas` — ver documentação abaixo.
  retiradasVencidasSemRegistro: number
  emUtilizacao: number
  finalizadas: number
  canceladas: number
  prontasRetirada: number
}

/**
 * Duas métricas distintas e propositalmente NUNCA somadas entre si
 * (Etapa 9A-B — ver análise técnica anterior):
 *
 *   - `naoRetiradas`: KPI GERENCIAL oficial. Conta solicitações com o
 *     status real NAO_RETIRADA — só existe quando o Patrimônio usa a ação
 *     "Marcar como não retirado" (POST /api/solicitacoes/[id]/nao-retirada).
 *     Não é mais um valor calculado/inferido: reflete uma decisão
 *     operacional registrada, com data e responsável.
 *
 *   - `retiradasVencidasSemRegistro`: alerta OPERACIONAL (não é o KPI
 *     "Não retiradas"). Uma solicitação entra aqui quando:
 *       - status ainda é PRONTA_RETIRADA (chegou a ser separada, mas nunca
 *         teve retirada registrada — `retiradaEm` continua nulo);
 *       - a data de utilização (`data`) já passou (é anterior a hoje).
 *     É um indicador CALCULADO na consulta do relatório — o status da
 *     solicitação NUNCA é alterado automaticamente por este cálculo. Serve
 *     para o Patrimônio identificar solicitações que precisam de uma ação
 *     (retirada ou "não retirado"), não para medir quantas já foram
 *     decididas como não retiradas.
 */
export async function calcularOperacao(where: Prisma.SolicitacaoWhereInput): Promise<OperacaoResumo> {
  const hoje = new Date()
  hoje.setUTCHours(0, 0, 0, 0)

  // Uma única groupBy por status cobre TODAS as contagens por status —
  // inclusive `naoRetiradas`, que agora é só mais um valor de status (não
  // precisa mais de uma query dedicada, ao contrário da versão anterior
  // baseada em regra derivada). `retiradas` e `retiradasVencidasSemRegistro`
  // cruzam `retiradaEm`/`data`, que não fazem parte da chave de
  // agrupamento, por isso continuam como contagens à parte (via
  // `comFiltroAdicional`, preservando o limite "data < hoje" combinado com
  // o período já filtrado).
  const [porStatus, retiradas, retiradasVencidasSemRegistro] = await Promise.all([
    prisma.solicitacao.groupBy({ by: ['status'], where, _count: true }),
    prisma.solicitacao.count({ where: comFiltroAdicional(where, { retiradaEm: { not: null } }) }),
    prisma.solicitacao.count({ where: comFiltroAdicional(where, { status: 'PRONTA_RETIRADA', retiradaEm: null, data: { lt: hoje } }) }),
  ])

  const contarStatus = (status: StatusSolicitacao) =>
    porStatus.find((g: { status: StatusSolicitacao }) => g.status === status)?._count ?? 0

  return {
    retiradas,
    naoRetiradas: contarStatus('NAO_RETIRADA'),
    retiradasVencidasSemRegistro,
    emUtilizacao: contarStatus('EM_UTILIZACAO'),
    finalizadas: contarStatus('FINALIZADA'),
    canceladas: contarStatus('CANCELADA'),
    prontasRetirada: contarStatus('PRONTA_RETIRADA'),
  }
}

// =============================================================================
// DISTRIBUIÇÃO POR PERÍODO (Fase 3 — Etapa 4, ajuste)
// =============================================================================

export interface PeriodoDistribuicao {
  periodo: PeriodoSolicitacao
  total: number
  reservas: number
  atendimentosImediatos: number
}

const PERIODOS_RELATORIO: PeriodoSolicitacao[] = ['MANHA', 'TARDE', 'NOITE']

/**
 * Distribuição de atendimentos por período (Manhã/Tarde/Noite), separando
 * reservas antecipadas de atendimentos imediatos.
 *
 * `periodos` é um array (uma reserva pode abranger mais de um período —
 * ex.: Manhã e Tarde). O filtro usa `has` (contém o período), então uma
 * solicitação com dois períodos selecionados é contabilizada em AMBOS os
 * baldes — reflete corretamente que o atendimento realmente ocupou os dois
 * períodos; não é dupla contagem de SOLICITAÇÃO, é contagem de OCUPAÇÃO por
 * período (dimensão diferente do "total de solicitações").
 *
 * Atendimento Imediato sempre tem exatamente 1 período (validado no
 * schema), então nunca é contado em mais de um balde.
 */
export async function calcularDistribuicaoPeriodo(where: Prisma.SolicitacaoWhereInput): Promise<PeriodoDistribuicao[]> {
  // Uma única groupBy por origem, por período, substitui as 3 contagens
  // anteriores de cada período (total/reservas/imediatos) — 3 consultas no
  // total (uma por período) em vez de 9. `origem` é um enum não-nulo e
  // exaustivo (RESERVA/ATENDIMENTO_IMEDIATO), então reservas+imediatos é
  // sempre exatamente igual ao total do período — não é uma aproximação.
  const resultados = await Promise.all(
    PERIODOS_RELATORIO.map(async (periodo) => {
      const grupos = await prisma.solicitacao.groupBy({
        by: ['origem'],
        where: comFiltroAdicional(where, { periodos: { has: periodo } }),
        _count: true,
      })
      const reservas = grupos.find((g: { origem: string }) => g.origem === 'RESERVA')?._count ?? 0
      const atendimentosImediatos = grupos.find((g: { origem: string }) => g.origem === 'ATENDIMENTO_IMEDIATO')?._count ?? 0
      return { periodo, total: reservas + atendimentosImediatos, reservas, atendimentosImediatos }
    })
  )
  return resultados
}

// =============================================================================
// ATENDIMENTO IMEDIATO — detalhamento (Etapa 6)
// =============================================================================

export interface ResumoAtendimentoImediato {
  total: number
  percentualDemanda: number // participação sobre o total geral de atendimentos do período
  comBens: number
  comPapelaria: number
  comServico: number
}

// Etapa perf/system-optimization: esta função NÃO precisa mais de
// `totalGeral` como parâmetro — ele só era usado para computar
// `percentualDemanda`, um cálculo em memória trivial que não interfere em
// nenhuma das 4 queries abaixo. Antes, `obterDadosRelatorio()` tinha que
// aguardar `calcularResumoBasico()` (o dono de `totalGeral`) terminar ANTES
// de sequer começar este Promise.all — um estágio sequencial a mais no
// caminho crítico, mesmo sem dependência real de dados entre as duas
// consultas. Retornando as 4 contagens cruas, quem chama decide o
// `percentualDemanda` depois, já com os dois resultados em mãos (ver
// obterDadosRelatorio abaixo) — o formato de ResumoAtendimentoImediato
// devolvido ao consumidor final não muda em nada.
export interface ContagensAtendimentoImediato {
  total: number
  comBens: number
  comPapelaria: number
  comServico: number
}

export async function calcularAtendimentoImediato(where: Prisma.SolicitacaoWhereInput): Promise<ContagensAtendimentoImediato> {
  const baseAtendimentoImediato = comFiltroAdicional(where, { origem: 'ATENDIMENTO_IMEDIATO' as const })

  // 4 `count` agregados no banco — custo praticamente constante em relação
  // ao volume (Postgres soma direto no índice/scan, sem materializar linha
  // nenhuma no servidor Node), ao contrário de um `findMany` que traria uma
  // linha por atendimento imediato do período filtrado.
  const [total, comBens, comPapelaria, comServico] = await Promise.all([
    prisma.solicitacao.count({ where: baseAtendimentoImediato }),
    prisma.solicitacao.count({ where: comFiltroAdicional(baseAtendimentoImediato, { itensPatrimonio: { some: {} } }) }),
    prisma.solicitacao.count({ where: comFiltroAdicional(baseAtendimentoImediato, { itensPapelaria: { some: {} } }) }),
    prisma.solicitacao.count({ where: comFiltroAdicional(baseAtendimentoImediato, { itensServico: { some: {} } }) }),
  ])

  return { total, comBens, comPapelaria, comServico }
}

// =============================================================================
// ANTECEDÊNCIA MÉDIA
// =============================================================================

export interface AntecedenciaMedia {
  internasMinutos: number | null
  externasMinutos: number | null
}

export async function calcularAntecedenciaMedia(where: Prisma.SolicitacaoWhereInput): Promise<AntecedenciaMedia> {
  // Atendimentos imediatos são excluídos automaticamente: além do filtro
  // explícito origem=RESERVA, o campo antecedenciaMinutos é sempre nulo
  // para eles, e o Prisma ignora nulos em _avg. Uma única groupBy por
  // tipoEmprestimo com _avg substitui as 2 agregações separadas anteriores.
  const grupos = await prisma.solicitacao.groupBy({
    by: ['tipoEmprestimo'],
    where: comFiltroAdicional(where, { origem: 'RESERVA', antecedenciaMinutos: { not: null } }),
    _avg: { antecedenciaMinutos: true },
  })

  const internasMinutos = grupos.find((g: { tipoEmprestimo: string }) => g.tipoEmprestimo === 'interno')?._avg.antecedenciaMinutos ?? null
  const externasMinutos = grupos.find((g: { tipoEmprestimo: string }) => g.tipoEmprestimo === 'externo')?._avg.antecedenciaMinutos ?? null

  return { internasMinutos, externasMinutos }
}

// =============================================================================
// BENS PATRIMONIAIS — total movimentado + rankings (categoria e patrimônio)
// =============================================================================

export interface RankingPatrimonio {
  patrimonioId: string
  numero: string
  marca: string
  modelo: string
  categoriaNome: string
  utilizacoes: number
}

export interface RankingCategoria {
  categoriaId: string
  categoriaNome: string
  utilizacoes: number
}

export interface ResumoBens {
  totalBensMovimentados: number
  rankingPatrimonios: RankingPatrimonio[]
  rankingCategorias: RankingCategoria[]
}

export async function calcularBens(where: Prisma.SolicitacaoWhereInput, limite = 10): Promise<ResumoBens> {
  // Uma única agregação no banco (groupBy por patrimonioId) — depois busca
  // só os detalhes dos patrimônios que apareceram (conjunto pequeno, nunca
  // "todos os bens"). Nenhuma consulta por linha.
  const porPatrimonioBruto = await prisma.itemPatrimonioSolicitacao.groupBy({
    by: ['patrimonioId'],
    where: { solicitacao: where },
    _count: true,
  })
  // Ordenação feita em JS (conjunto já pequeno — só os patrimônios que
  // efetivamente apareceram no período filtrado) para não depender de
  // sintaxe de orderBy-por-agregação específica de versão do Prisma.
  const porPatrimonio = [...porPatrimonioBruto].sort((a: { _count: number }, b: { _count: number }) => b._count - a._count)

  const totalBensMovimentados = porPatrimonio.reduce((acc: number, p: { _count: number }) => acc + p._count, 0)

  const idsUsados = porPatrimonio.map((p: { patrimonioId: string }) => p.patrimonioId)
  const patrimonios = idsUsados.length
    ? await prisma.patrimonio.findMany({
        where: { id: { in: idsUsados } },
        include: { categoria: true },
      })
    : []

  const patrimonioPorId = new Map(patrimonios.map((p) => [p.id, p]))

  const rankingPatrimonios: RankingPatrimonio[] = porPatrimonio
    .slice(0, limite)
    .map((p: { patrimonioId: string; _count: number }) => {
      const info = patrimonioPorId.get(p.patrimonioId)
      return {
        patrimonioId: p.patrimonioId,
        numero: info?.numero ?? '—',
        marca: info?.marca ?? '—',
        modelo: info?.modelo ?? '—',
        categoriaNome: info?.categoria?.nome ?? '—',
        utilizacoes: p._count,
      }
    })

  const categoriaAgregada = new Map<string, { categoriaNome: string; utilizacoes: number }>()
  for (const p of porPatrimonio) {
    const info = patrimonioPorId.get(p.patrimonioId)
    const categoriaId = info?.categoriaId ?? 'desconhecida'
    const categoriaNome = info?.categoria?.nome ?? 'Desconhecida'
    const atual = categoriaAgregada.get(categoriaId) ?? { categoriaNome, utilizacoes: 0 }
    atual.utilizacoes += p._count
    categoriaAgregada.set(categoriaId, atual)
  }

  const rankingCategorias: RankingCategoria[] = Array.from(categoriaAgregada.entries())
    .map(([categoriaId, v]) => ({ categoriaId, ...v }))
    .sort((a, b) => b.utilizacoes - a.utilizacoes)
    .slice(0, limite)

  return { totalBensMovimentados, rankingPatrimonios, rankingCategorias }
}

// =============================================================================
// PAPELARIA
// =============================================================================

export interface ItemPapelariaRanking {
  descricaoNormalizada: string
  quantidadeTotal: number
  ocorrencias: number
}

export interface ResumoPapelaria {
  solicitacoesComPapelaria: number
  quantidadeTotalItens: number
  atendimentosImediatosComPapelaria: number
  itensMaisSolicitados: ItemPapelariaRanking[]
}

export async function calcularPapelaria(where: Prisma.SolicitacaoWhereInput, limite = 10): Promise<ResumoPapelaria> {
  const [solicitacoesComPapelaria, atendimentosImediatosComPapelaria, itens] = await Promise.all([
    prisma.solicitacao.count({ where: { ...where, itensPapelaria: { some: {} } } }),
    prisma.solicitacao.count({ where: comFiltroAdicional(where, { origem: 'ATENDIMENTO_IMEDIATO', itensPapelaria: { some: {} } }) }),
    // Uma única query trazendo os itens já filtrados pelo período/filtros —
    // não é "carregar tudo para o navegador", é uma agregação no servidor
    // sobre um conjunto já delimitado pelo filtro do relatório.
    prisma.itemPapelaria.findMany({ where: { solicitacao: where }, select: { descricao: true, quantidade: true } }),
  ])

  const quantidadeTotalItens = itens.reduce((acc: number, i: { quantidade: number }) => acc + i.quantidade, 0)

  // Normalização SOMENTE para fins de agrupamento/exibição no relatório —
  // nunca altera o texto original salvo na solicitação. Equivalências de
  // acentuação são controladas e não usam fuzzy matching; descrições
  // semanticamente distintas continuam separadas.
  const agregados = new Map<string, { descricaoNormalizada: string; quantidadeTotal: number; ocorrencias: number }>()
  for (const item of itens) {
    const normalizado = normalizarItemPapelaria(item.descricao)
    const atual = agregados.get(normalizado.chave) ?? {
      descricaoNormalizada: normalizado.descricaoExibicao,
      quantidadeTotal: 0,
      ocorrencias: 0,
    }
    atual.quantidadeTotal += item.quantidade
    atual.ocorrencias += 1
    agregados.set(normalizado.chave, atual)
  }

  const itensMaisSolicitados = Array.from(agregados.entries())
    .map(([, v]) => v)
    .sort((a, b) => b.quantidadeTotal - a.quantidadeTotal)
    .slice(0, limite)

  return { solicitacoesComPapelaria, quantidadeTotalItens, atendimentosImediatosComPapelaria, itensMaisSolicitados }
}

// =============================================================================
// SERVIÇOS / MOVIMENTAÇÕES
// =============================================================================

export interface RankingServico {
  tipoServicoId: string
  nome: string
  ocorrencias: number
  quantidadeTotal: number | null
}

export interface ResumoServicos {
  solicitacoesComServico: number
  totalServicosRealizados: number
  ranking: RankingServico[]
}

export async function calcularServicos(where: Prisma.SolicitacaoWhereInput, limite = 10): Promise<ResumoServicos> {
  const [solicitacoesComServico, porTipoServico] = await Promise.all([
    prisma.solicitacao.count({ where: { ...where, itensServico: { some: {} } } }),
    prisma.itemServicoSolicitacao.groupBy({
      by: ['tipoServicoId'],
      where: { solicitacao: where },
      _count: true,
      _sum: { quantidade: true },
    }),
  ])

  const totalServicosRealizados = porTipoServico.reduce((acc: number, s: { _count: number }) => acc + s._count, 0)

  const ordenado = [...porTipoServico].sort((a: { _count: number }, b: { _count: number }) => b._count - a._count)

  const ids = ordenado.map((s: { tipoServicoId: string }) => s.tipoServicoId)
  const tipos = ids.length ? await prisma.tipoServico.findMany({ where: { id: { in: ids } } }) : []
  const tipoPorId = new Map(tipos.map((t: { id: string; nome: string }) => [t.id, t]))

  const ranking: RankingServico[] = ordenado
    .slice(0, limite)
    .map((s: { tipoServicoId: string; _count: number; _sum: { quantidade: number | null } }) => ({
      tipoServicoId: s.tipoServicoId,
      nome: tipoPorId.get(s.tipoServicoId)?.nome ?? '—',
      ocorrencias: s._count,
      quantidadeTotal: s._sum.quantidade,
    }))

  return { solicitacoesComServico, totalServicosRealizados, ranking }
}

// =============================================================================
// EVOLUÇÃO MENSAL (últimos 12 meses terminando no período filtrado)
// =============================================================================

export interface MesEvolucao extends ResumoBasico {
  mes: string // 'YYYY-MM'
}

/**
 * Lista os últimos N meses ('YYYY-MM', padrão 12) terminando no mês de
 * referência, do mais antigo para o mais recente. Extraído para ser
 * reaproveitado por qualquer função que precise da MESMA janela/ordem de
 * meses de `calcularEvolucaoMensal` (ex.: indicadores complementares da
 * exportação Excel) sem duplicar a lógica de sequência de meses.
 */
export function listarUltimosMeses(mesReferencia: string, quantidadeMeses = 12): string[] {
  const meses: string[] = []
  let atual = mesReferencia
  for (let i = 0; i < quantidadeMeses; i++) {
    meses.unshift(atual)
    atual = mesAnterior(atual)
  }
  return meses
}

/**
 * Calcula os últimos N meses (padrão 12) terminando no mês de referência.
 * Reaproveita `calcularResumoBasico` para cada mês, preservando os demais
 * filtros ativos (tipo/origem/status/categoria/serviço) — só o período
 * muda a cada iteração. São sempre N meses fixos, nunca "todos os
 * registros": N chamadas agregadas em paralelo, não uma por solicitação.
 */
export async function calcularEvolucaoMensal(
  where: Prisma.SolicitacaoWhereInput,
  mesReferencia: string,
  quantidadeMeses = 12
): Promise<MesEvolucao[]> {
  const meses = listarUltimosMeses(mesReferencia, quantidadeMeses)

  const resultados = await Promise.all(
    meses.map(async (mes) => {
      const inicio = primeiroDiaDoMes(mes)
      const fim = primeiroDiaDoProximoMes(mes)
      const resumo = await calcularResumoBasico(whereComPeriodo(where, inicio, fim))
      return { mes, ...resumo }
    })
  )

  return resultados
}

// =============================================================================
// COMPARATIVO COM O MÊS ANTERIOR
// =============================================================================

export interface ComparativoCampo {
  atual: number
  anterior: number
  variacaoPercentual: number | null // null quando anterior=0 (variação indefinida)
}

export interface ComparativoMesAnterior {
  mesAtual: string
  mesAnteriorLabel: string
  total: ComparativoCampo
  internas: ComparativoCampo
  externas: ComparativoCampo
  atendimentosImediatos: ComparativoCampo
  dentroPrazo: ComparativoCampo
  foraPrazo: ComparativoCampo
  canceladas: ComparativoCampo
  naoRetiradas: ComparativoCampo
}

function compararCampo(atual: number, anterior: number): ComparativoCampo {
  const variacaoPercentual = anterior > 0 ? ((atual - anterior) / anterior) * 100 : null
  return { atual, anterior, variacaoPercentual }
}

/**
 * Só é calculado quando o filtro aplicado é um ÚNICO mês (não em intervalos
 * personalizados) — conforme pedido ("Quando o filtro for mensal...").
 */
export async function calcularComparativoMesAnterior(
  where: Prisma.SolicitacaoWhereInput,
  mesAtual: string
): Promise<ComparativoMesAnterior> {
  const mesAnt = mesAnterior(mesAtual)

  const whereAtual = whereComPeriodo(where, primeiroDiaDoMes(mesAtual), primeiroDiaDoProximoMes(mesAtual))
  const whereAnterior = whereComPeriodo(where, primeiroDiaDoMes(mesAnt), primeiroDiaDoProximoMes(mesAnt))

  const [resumoAtual, resumoAnterior, operacaoAtual, operacaoAnterior] = await Promise.all([
    calcularResumoBasico(whereAtual),
    calcularResumoBasico(whereAnterior),
    calcularOperacao(whereAtual),
    calcularOperacao(whereAnterior),
  ])

  return {
    mesAtual,
    mesAnteriorLabel: mesAnt,
    total: compararCampo(resumoAtual.total, resumoAnterior.total),
    internas: compararCampo(resumoAtual.internas, resumoAnterior.internas),
    externas: compararCampo(resumoAtual.externas, resumoAnterior.externas),
    atendimentosImediatos: compararCampo(resumoAtual.atendimentosImediatos, resumoAnterior.atendimentosImediatos),
    dentroPrazo: compararCampo(resumoAtual.dentroPrazo, resumoAnterior.dentroPrazo),
    foraPrazo: compararCampo(resumoAtual.foraPrazo, resumoAnterior.foraPrazo),
    canceladas: compararCampo(operacaoAtual.canceladas, operacaoAnterior.canceladas),
    naoRetiradas: compararCampo(operacaoAtual.naoRetiradas, operacaoAnterior.naoRetiradas),
  }
}

// =============================================================================
// RESUMO EXECUTIVO (texto automático — sem IA, baseado em template)
// =============================================================================

function plural(n: number, singular: string, pluralForm: string): string {
  return n === 1 ? singular : pluralForm
}

export function gerarResumoExecutivo(params: {
  resumo: ResumoBasico
  categoriaMaisSolicitada: string | null
  totalServicos: number
}): string {
  const { resumo, categoriaMaisSolicitada, totalServicos } = params

  if (resumo.total === 0) {
    return 'Nenhum atendimento foi registrado no período selecionado.'
  }

  const frases: string[] = []

  frases.push(
    `No período selecionado foram registrados ${resumo.total} ${plural(resumo.total, 'atendimento', 'atendimentos')}, ` +
      `sendo ${resumo.reservasAntecipadas} ${plural(resumo.reservasAntecipadas, 'reserva antecipada', 'reservas antecipadas')} ` +
      `e ${resumo.atendimentosImediatos} ${plural(resumo.atendimentosImediatos, 'atendimento imediato', 'atendimentos imediatos')}.`
  )

  if (resumo.percentualDentroPrazo !== null) {
    frases.push(
      `Entre as reservas antecipadas, ${resumo.percentualDentroPrazo.toFixed(1)}% foram realizadas dentro do prazo recomendado ` +
        `e ${(100 - resumo.percentualDentroPrazo).toFixed(1)}% fora do prazo.`
    )
  }

  if (categoriaMaisSolicitada) {
    frases.push(`${categoriaMaisSolicitada} foi a categoria patrimonial mais solicitada no período.`)
  }

  if (totalServicos > 0) {
    frases.push(`Foram registrados ${totalServicos} ${plural(totalServicos, 'serviço/movimentação realizado', 'serviços/movimentações realizados')} pelo Patrimônio.`)
  }

  return frases.join(' ')
}

// Composicao unica consumida pela tela e pela exportacao PDF. Manter esta
// orquestracao aqui impede que os dois formatos divirjam nos KPIs.
export async function obterDadosRelatorio(searchParams: URLSearchParams) {
  const { where, mesAnoUnico } = construirFiltros(searchParams)
  const agora = new Date()
  const mesReferencia = mesAnoUnico ?? `${agora.getUTCFullYear()}-${String(agora.getUTCMonth() + 1).padStart(2, '0')}`
  // Etapa perf/system-optimization: `resumo` (dono de `resumo.total`, usado
  // só para o percentual de atendimentoImediato) entrou NO MESMO Promise.all
  // das demais 9 consultas — antes era aguardado sozinho antes de sequer
  // começar as outras, um estágio sequencial a mais sem dependência real de
  // dados entre elas (só `percentualDemanda`, calculado abaixo, depende de
  // `resumo.total`, e isso é trivial em memória depois que ambos resolvem).
  const [resumo, statusDist, operacao, distribuicaoPeriodo, contagensAtendimentoImediato, antecedenciaMedia, bens, papelaria, servicos, evolucaoMensal, comparativoMesAnterior] = await Promise.all([
    calcularResumoBasico(where),
    calcularDistribuicaoStatus(where), calcularOperacao(where), calcularDistribuicaoPeriodo(where),
    calcularAtendimentoImediato(where), calcularAntecedenciaMedia(where), calcularBens(where),
    calcularPapelaria(where), calcularServicos(where), calcularEvolucaoMensal(where, mesReferencia),
    mesAnoUnico ? calcularComparativoMesAnterior(where, mesAnoUnico) : Promise.resolve(null),
  ])
  const atendimentoImediato: ResumoAtendimentoImediato = {
    ...contagensAtendimentoImediato,
    percentualDemanda: resumo.total > 0 ? (contagensAtendimentoImediato.total / resumo.total) * 100 : 0,
  }
  return {
    resumo, statusDist, operacao, distribuicaoPeriodo, atendimentoImediato, antecedenciaMedia,
    bens, papelaria, servicos, evolucaoMensal, comparativoMesAnterior, mesReferencia,
    resumoExecutivo: gerarResumoExecutivo({ resumo, categoriaMaisSolicitada: bens.rankingCategorias[0]?.categoriaNome ?? null, totalServicos: servicos.totalServicosRealizados }),
  }
}

export async function obterDetalhamentoRelatorio(searchParams: URLSearchParams, limite = 15) {
  const { where } = construirFiltros(searchParams)
  const [solicitacoes, total] = await Promise.all([
    prisma.solicitacao.findMany({
      where,
      select: {
        numero: true, tipoEmprestimo: true, origem: true, status: true, data: true,
        dentroDoPrazo: true, ambiente: true, local: true, cidade: true,
        solicitante: { select: { nome: true } },
        _count: { select: { itensPatrimonio: true, itensPapelaria: true, itensServico: true } },
      },
      orderBy: { data: 'desc' },
      take: limite,
    }),
    prisma.solicitacao.count({ where }),
  ])
  return { solicitacoes, total }
}

// =============================================================================
// EXPORTAÇÃO EXCEL (Fase 3 — Etapa 8) — detalhamento completo por aba
// =============================================================================
//
// Diferente de `obterDetalhamentoRelatorio` (usado pelo PDF, limitado a uma
// amostra), estas funções trazem o recorte FILTRADO completo — mas sempre
// numa única consulta por aba (nunca uma consulta por linha/item/mês), com
// `select` estreito trazendo só os campos que cada aba realmente usa.

/** Uma linha por solicitação — base das abas "Solicitações" e "Prazos". */
export async function obterSolicitacoesCompletas(where: Prisma.SolicitacaoWhereInput) {
  return prisma.solicitacao.findMany({
    where,
    select: {
      numero: true,
      createdAt: true,
      data: true,
      tipoEmprestimo: true,
      origem: true,
      ambiente: true,
      local: true,
      cidade: true,
      finalidade: true,
      atividadeExterna: true,
      periodos: true,
      status: true,
      prazoHoras: true,
      antecedenciaMinutos: true,
      dentroDoPrazo: true,
      prazoReferenciaEm: true,
      retiradaEm: true,
      devolucaoEm: true,
      devolucaoCondicao: true,
      devolucaoCondicaoTextoLegado: true,
      devolucaoObs: true,
      naoRetiradaEm: true,
      observacoes: true,
      solicitante: { select: { nome: true, email: true } },
      _count: { select: { itensPatrimonio: true, itensPapelaria: true, itensServico: true } },
    },
    orderBy: { data: 'desc' },
  })
}

export type SolicitacaoCompleta = Awaited<ReturnType<typeof obterSolicitacoesCompletas>>[number]

/** Uma linha por relação solicitação × bem patrimonial — aba "Bens Movimentados". */
export async function obterBensMovimentados(where: Prisma.SolicitacaoWhereInput) {
  return prisma.itemPatrimonioSolicitacao.findMany({
    where: { solicitacao: where },
    select: {
      solicitacao: {
        select: {
          numero: true, data: true, tipoEmprestimo: true, origem: true, periodos: true, status: true,
          retiradaEm: true, devolucaoEm: true,
          solicitante: { select: { nome: true } },
        },
      },
      patrimonio: { select: { numero: true, marca: true, modelo: true, categoria: { select: { nome: true } } } },
    },
    orderBy: { solicitacao: { data: 'desc' } },
  })
}

export type BemMovimentado = Awaited<ReturnType<typeof obterBensMovimentados>>[number]

/** Uma linha por item de papelaria — aba "Papelaria". */
export async function obterPapelariaCompleta(where: Prisma.SolicitacaoWhereInput) {
  return prisma.itemPapelaria.findMany({
    where: { solicitacao: where },
    select: {
      descricao: true,
      quantidade: true,
      solicitacao: {
        select: {
          numero: true, data: true, tipoEmprestimo: true, origem: true, periodos: true, status: true,
          solicitante: { select: { nome: true } },
        },
      },
    },
    orderBy: { solicitacao: { data: 'desc' } },
  })
}

export type ItemPapelariaCompleto = Awaited<ReturnType<typeof obterPapelariaCompleta>>[number]

/** Uma linha por serviço/movimentação — aba "Serviços". */
export async function obterServicosCompletos(where: Prisma.SolicitacaoWhereInput) {
  return prisma.itemServicoSolicitacao.findMany({
    where: { solicitacao: where },
    select: {
      quantidade: true,
      ambiente: true,
      observacao: true,
      tipoServico: { select: { nome: true } },
      solicitacao: {
        select: {
          numero: true, data: true, tipoEmprestimo: true, origem: true, periodos: true, status: true,
          solicitante: { select: { nome: true } },
        },
      },
    },
    orderBy: { solicitacao: { data: 'desc' } },
  })
}

export type ServicoCompleto = Awaited<ReturnType<typeof obterServicosCompletos>>[number]

export interface IndicadoresMensaisComplementares {
  mes: string
  finalizadas: number
  canceladas: number
  naoRetiradas: number
  retiradasVencidasSemRegistro: number
  bensMovimentados: number
  solicitacoesComPapelaria: number
  servicosRealizados: number
}

/**
 * Métricas mensais que `calcularEvolucaoMensal` não calcula (finalizadas/
 * canceladas/não retiradas/bens/papelaria/serviços por mês) — usadas só na
 * aba "Indicadores Mensais" do Excel. Usa a MESMA janela de meses de
 * `listarUltimosMeses` (garante alinhamento por índice com
 * `calcularEvolucaoMensal`) e SEMPRE 4 consultas fixas sobre a janela
 * inteira — nunca uma consulta por mês — depois agrupa em memória.
 */
export async function calcularIndicadoresMensaisComplementares(
  where: Prisma.SolicitacaoWhereInput,
  mesReferencia: string,
  quantidadeMeses = 12
): Promise<IndicadoresMensaisComplementares[]> {
  const meses = listarUltimosMeses(mesReferencia, quantidadeMeses)
  const inicioJanela = primeiroDiaDoMes(meses[0])
  const fimJanela = primeiroDiaDoProximoMes(meses[meses.length - 1])
  const whereJanela = whereComPeriodo(where, inicioJanela, fimJanela)

  const hoje = new Date()
  hoje.setUTCHours(0, 0, 0, 0)

  function chaveMes(data: Date): string {
    return `${data.getUTCFullYear()}-${String(data.getUTCMonth() + 1).padStart(2, '0')}`
  }

  const [solicitacoes, itensPatrimonio, solicitacoesComPapelariaBrutas, itensServico] = await Promise.all([
    prisma.solicitacao.findMany({ where: whereJanela, select: { data: true, status: true, retiradaEm: true } }),
    prisma.itemPatrimonioSolicitacao.findMany({ where: { solicitacao: whereJanela }, select: { solicitacao: { select: { data: true } } } }),
    prisma.solicitacao.findMany({ where: comFiltroAdicional(whereJanela, { itensPapelaria: { some: {} } }), select: { data: true } }),
    prisma.itemServicoSolicitacao.findMany({ where: { solicitacao: whereJanela }, select: { solicitacao: { select: { data: true } } } }),
  ])

  const porMes = new Map<string, IndicadoresMensaisComplementares>()
  for (const mes of meses) {
    porMes.set(mes, { mes, finalizadas: 0, canceladas: 0, naoRetiradas: 0, retiradasVencidasSemRegistro: 0, bensMovimentados: 0, solicitacoesComPapelaria: 0, servicosRealizados: 0 })
  }

  for (const s of solicitacoes) {
    const bucket = porMes.get(chaveMes(s.data))
    if (!bucket) continue
    if (s.status === 'FINALIZADA') bucket.finalizadas++
    if (s.status === 'CANCELADA') bucket.canceladas++
    // KPI oficial (status real) e alerta operacional (regra derivada) —
    // nunca somados entre si (ver documentação de calcularOperacao).
    if (s.status === 'NAO_RETIRADA') bucket.naoRetiradas++
    if (s.status === 'PRONTA_RETIRADA' && s.retiradaEm === null && s.data < hoje) bucket.retiradasVencidasSemRegistro++
  }
  for (const item of itensPatrimonio) {
    const bucket = porMes.get(chaveMes(item.solicitacao.data))
    if (bucket) bucket.bensMovimentados++
  }
  for (const s of solicitacoesComPapelariaBrutas) {
    const bucket = porMes.get(chaveMes(s.data))
    if (bucket) bucket.solicitacoesComPapelaria++
  }
  for (const item of itensServico) {
    const bucket = porMes.get(chaveMes(item.solicitacao.data))
    if (bucket) bucket.servicosRealizados++
  }

  return meses.map((mes) => porMes.get(mes)!)
}

// Composição única consumida pela exportação Excel — reaproveita
// `obterDadosRelatorio` (mesmo pipeline do dashboard/PDF) para a aba Resumo
// e adiciona só as consultas extras de detalhamento completo por aba.
export async function obterDadosExcel(searchParams: URLSearchParams) {
  const { where } = construirFiltros(searchParams)
  const dados = await obterDadosRelatorio(searchParams)
  const [solicitacoes, bensMovimentados, papelaria, servicos, indicadoresComplementares] = await Promise.all([
    obterSolicitacoesCompletas(where),
    obterBensMovimentados(where),
    obterPapelariaCompleta(where),
    obterServicosCompletos(where),
    calcularIndicadoresMensaisComplementares(where, dados.mesReferencia),
  ])
  return { dados, solicitacoes, bensMovimentados, papelaria, servicos, indicadoresComplementares }
}
