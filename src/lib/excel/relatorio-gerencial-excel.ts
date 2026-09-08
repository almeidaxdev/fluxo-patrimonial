// src/lib/excel/relatorio-gerencial-excel.ts
//
// Exportação Excel Analítica (Fase 3 — Etapa 8).
//
// Consome exatamente os dados já calculados por `obterDadosExcel` (mesmo
// pipeline de filtros/KPIs do dashboard e do PDF) — este arquivo só formata
// o workbook, nunca recalcula nada. Nenhuma consulta ao banco acontece aqui.

import ExcelJS from 'exceljs'
import { STATUS_SOLICITACAO_LABELS, TIPO_EMPRESTIMO_LABELS, PERIODO_LABELS, PeriodoSolicitacao, CONDICAO_DEVOLUCAO_LABELS } from '@/types'
import type { obterDadosExcel, SolicitacaoCompleta, BemMovimentado, ItemPapelariaCompleto, ServicoCompleto } from '@/lib/relatorios'
import { formatarAntecedenciaHumana, formatarMesAnoCompleto, recortarHistoricoEmFormacao, normalizarItemPapelaria } from '@/lib/relatorios-formatacao'
import { formatarAntecedencia, BRASIL_UTC_OFFSET_HORAS } from '@/lib/prazo'

type DadosExcel = Awaited<ReturnType<typeof obterDadosExcel>>

// Mesma paleta institucional já aprovada no PDF (src/lib/pdf/relatorio-gerencial.tsx).
const COR = {
  azul: 'FF004B87',
  cinza: 'FF667085',
  verdeFundo: 'FFE6F4EA',
  verdeTexto: 'FF18794E',
  vermelhoFundo: 'FFFBE9E7',
  vermelhoTexto: 'FFB42318',
  neutroFundo: 'FFF1F1F1',
  branco: 'FFFFFFFF',
}

const MENSAGEM_VAZIO = 'Nenhum registro encontrado para os filtros selecionados.'

function origemLabel(origem: string): string {
  return origem === 'ATENDIMENTO_IMEDIATO' ? 'Atendimento imediato' : 'Reserva antecipada'
}

function periodosTexto(periodos: PeriodoSolicitacao[]): string {
  return periodos.map((p) => PERIODO_LABELS[p]).join(', ')
}

/** Mesma regra do PDF (src/lib/pdf/relatorio-gerencial.tsx `prazo()`): imediato nunca é
 * classificado Dentro/Fora; reserva sem classificação histórica vira N/D. */
function classificacaoPrazo(origem: string, dentroDoPrazo: boolean | null): string {
  if (origem === 'ATENDIMENTO_IMEDIATO') return 'Não se aplica'
  if (dentroDoPrazo === true) return 'Dentro'
  if (dentroDoPrazo === false) return 'Fora'
  return 'N/D'
}

/** Desloca um instante UTC para "hora de parede" de Brasília, para que o serial de
 * data/hora do Excel (que não tem fuso) exiba o horário local correto. */
function paraHoraBrasilia(data: Date | null): Date | null {
  if (!data) return null
  return new Date(data.getTime() - BRASIL_UTC_OFFSET_HORAS * 60 * 60 * 1000)
}

interface DefinicaoColuna {
  header: string
  key: string
  width: number
  formato?: 'data' | 'dataHora' | 'inteiro' | 'percentual' | 'decimal1'
  wrap?: boolean
}

function fillSuave(argb: string): ExcelJS.Fill {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } }
}

function criarAba(workbook: ExcelJS.Workbook, nome: string, colunas: DefinicaoColuna[]): ExcelJS.Worksheet {
  const sheet = workbook.addWorksheet(nome, { views: [{ state: 'frozen', ySplit: 1 }] })
  sheet.columns = colunas.map((c) => ({ header: c.header, key: c.key, width: c.width }))
  const headerRow = sheet.getRow(1)
  headerRow.height = 24
  headerRow.eachCell((cell) => {
    cell.fill = fillSuave(COR.azul)
    cell.font = { color: { argb: COR.branco }, bold: true, size: 10 }
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true }
  })
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: colunas.length } }
  return sheet
}

function preencherLinhas(sheet: ExcelJS.Worksheet, colunas: DefinicaoColuna[], linhas: Record<string, unknown>[]) {
  if (linhas.length === 0) {
    const row = sheet.addRow({ [colunas[0].key]: MENSAGEM_VAZIO })
    sheet.mergeCells(row.number, 1, row.number, colunas.length)
    row.getCell(1).alignment = { horizontal: 'center' }
    row.getCell(1).font = { italic: true, color: { argb: COR.cinza } }
    return
  }
  for (const linha of linhas) {
    const row = sheet.addRow(linha)
    for (const coluna of colunas) {
      const cell = row.getCell(coluna.key)
      if (coluna.formato === 'data') cell.numFmt = 'dd/mm/yyyy'
      else if (coluna.formato === 'dataHora') cell.numFmt = 'dd/mm/yyyy hh:mm'
      else if (coluna.formato === 'inteiro') cell.numFmt = '0'
      else if (coluna.formato === 'percentual') cell.numFmt = '0.0%'
      else if (coluna.formato === 'decimal1') cell.numFmt = '0.0'
      if (coluna.wrap) cell.alignment = { wrapText: true, vertical: 'top' }
    }
  }
}

/** Colore a coluna de classificação de prazo: Dentro=verde suave, Fora=vermelho
 * suave, N/D e Não se aplica=neutro — igual à convenção já usada no dashboard/PDF. */
function colorirClassificacao(sheet: ExcelJS.Worksheet, chaveColuna: string) {
  const coluna = sheet.getColumn(chaveColuna)
  const indice = coluna.number
  for (let i = 2; i <= sheet.rowCount; i++) {
    const cell = sheet.getRow(i).getCell(indice)
    const valor = String(cell.value ?? '')
    if (valor === 'Dentro') {
      cell.fill = fillSuave(COR.verdeFundo)
      cell.font = { color: { argb: COR.verdeTexto } }
    } else if (valor === 'Fora') {
      cell.fill = fillSuave(COR.vermelhoFundo)
      cell.font = { color: { argb: COR.vermelhoTexto } }
    } else if (valor === 'N/D' || valor === 'Não se aplica') {
      cell.fill = fillSuave(COR.neutroFundo)
      cell.font = { color: { argb: COR.cinza } }
    }
  }
}

// =============================================================================
// ABA 1 — RESUMO
// =============================================================================

const STATUS_ENCERRADOS = ['FINALIZADA', 'CANCELADA', 'REJEITADA_GESTOR', 'REJEITADA_PATRIMONIO', 'NAO_RETIRADA']

function construirAbaResumo(
  workbook: ExcelJS.Workbook,
  dados: DadosExcel['dados'],
  periodo: string,
  filtros: string[],
  geradoEm: string
) {
  const sheet = workbook.addWorksheet('Resumo', { views: [{ state: 'frozen', ySplit: 6 }] })
  sheet.columns = [{ width: 36 }, { width: 22 }]

  sheet.mergeCells('A1:B1')
  const titulo = sheet.getCell('A1')
  titulo.value = 'RELATÓRIO GERENCIAL — GESTÃO DE PATRIMÔNIO'
  titulo.font = { bold: true, size: 14, color: { argb: COR.branco } }
  titulo.fill = fillSuave(COR.azul)
  titulo.alignment = { vertical: 'middle', horizontal: 'left' }
  sheet.getRow(1).height = 26

  sheet.mergeCells('A2:B2')
  const sub = sheet.getCell('A2')
  sub.value = 'Fluxo Patrimonial'
  sub.font = { bold: true, size: 10, color: { argb: COR.azul } }

  sheet.getCell('A3').value = 'Período selecionado'
  sheet.getCell('B3').value = periodo
  sheet.getCell('A4').value = 'Gerado em'
  sheet.getCell('B4').value = geradoEm
  sheet.getCell('A5').value = 'Filtros aplicados'
  sheet.getCell('B5').value = filtros.length ? filtros.join(' • ') : 'Nenhum (todos os registros)'
  sheet.getCell('B5').alignment = { wrapText: true }
  for (const ref of ['A3', 'A4', 'A5']) {
    sheet.getCell(ref).font = { bold: true, color: { argb: COR.cinza } }
  }

  sheet.addRow([])

  const cabecalhoKpi = sheet.addRow(['Indicador', 'Valor'])
  cabecalhoKpi.eachCell((cell) => {
    cell.fill = fillSuave(COR.azul)
    cell.font = { bold: true, color: { argb: COR.branco } }
  })

  const { resumo, operacao, bens, papelaria, servicos, antecedenciaMedia, statusDist } = dados
  const semClassificacao = Math.max(0, resumo.reservasAntecipadas - resumo.dentroPrazo - resumo.foraPrazo)
  const emAndamento = statusDist
    .filter((s) => !STATUS_ENCERRADOS.includes(s.status))
    .reduce((acc, s) => acc + s.quantidade, 0)
  const taxaRetiradaDenom = operacao.retiradas + operacao.naoRetiradas
  const taxaRetirada = taxaRetiradaDenom > 0 ? operacao.retiradas / taxaRetiradaDenom : null

  const kpis: { label: string; valor: number | string; percentual?: boolean }[] = [
    { label: 'Total de atendimentos', valor: resumo.total },
    { label: 'Reservas antecipadas', valor: resumo.reservasAntecipadas },
    { label: 'Atendimentos imediatos', valor: resumo.atendimentosImediatos },
    { label: '% reservas na demanda', valor: resumo.total > 0 ? resumo.reservasAntecipadas / resumo.total : 0, percentual: true },
    { label: '% imediatos na demanda', valor: resumo.total > 0 ? resumo.atendimentosImediatos / resumo.total : 0, percentual: true },
    { label: 'Internas', valor: resumo.internas },
    { label: 'Externas', valor: resumo.externas },
    { label: 'Dentro do prazo', valor: resumo.dentroPrazo },
    { label: 'Fora do prazo', valor: resumo.foraPrazo },
    { label: 'Sem classificação', valor: semClassificacao },
    { label: 'Finalizadas', valor: operacao.finalizadas },
    { label: 'Em andamento', valor: emAndamento },
    { label: 'Canceladas', valor: operacao.canceladas },
    { label: 'Não retiradas', valor: operacao.naoRetiradas },
    { label: 'Retirada vencida sem registro', valor: operacao.retiradasVencidasSemRegistro },
    { label: 'Prontas para retirada', valor: operacao.prontasRetirada },
    { label: 'Retiradas', valor: operacao.retiradas },
    { label: 'Em utilização', valor: operacao.emUtilizacao },
    { label: 'Bens movimentados', valor: bens.totalBensMovimentados },
    { label: 'Solicitações com papelaria', valor: papelaria.solicitacoesComPapelaria },
    { label: 'Quantidade total de itens de papelaria', valor: papelaria.quantidadeTotalItens },
    { label: 'Serviços/movimentações', valor: servicos.totalServicosRealizados },
    { label: 'Antecedência média interna', valor: formatarAntecedenciaHumana(antecedenciaMedia.internasMinutos) },
    { label: 'Antecedência média externa', valor: formatarAntecedenciaHumana(antecedenciaMedia.externasMinutos) },
    { label: 'Taxa de retirada', valor: taxaRetirada !== null ? taxaRetirada : 'N/D', percentual: taxaRetirada !== null },
  ]

  for (const kpi of kpis) {
    const row = sheet.addRow([kpi.label, kpi.valor])
    row.getCell(1).font = { color: { argb: COR.cinza } }
    row.getCell(2).font = { bold: true }
    if (kpi.percentual) row.getCell(2).numFmt = '0.0%'
    else if (typeof kpi.valor === 'number') row.getCell(2).numFmt = '0'
  }

  return sheet
}

// =============================================================================
// ABA 2 — SOLICITAÇÕES
// =============================================================================

function construirAbaSolicitacoes(workbook: ExcelJS.Workbook, solicitacoes: SolicitacaoCompleta[]) {
  const colunas: DefinicaoColuna[] = [
    { header: 'Nº', key: 'numero', width: 8, formato: 'inteiro' },
    { header: 'Criada em', key: 'criadaEm', width: 16, formato: 'dataHora' },
    { header: 'Data da utilização', key: 'data', width: 14, formato: 'data' },
    { header: 'Solicitante', key: 'solicitante', width: 24 },
    { header: 'E-mail', key: 'email', width: 26 },
    { header: 'Tipo', key: 'tipo', width: 10 },
    { header: 'Origem', key: 'origem', width: 18 },
    { header: 'Ambiente', key: 'ambiente', width: 18 },
    { header: 'Local', key: 'local', width: 18 },
    { header: 'Cidade', key: 'cidade', width: 16 },
    { header: 'Finalidade', key: 'finalidade', width: 30, wrap: true },
    { header: 'Período(s)', key: 'periodos', width: 16 },
    { header: 'Status', key: 'status', width: 24 },
    { header: 'Prazo mínimo aplicado', key: 'prazoMinimo', width: 16 },
    { header: 'Antecedência', key: 'antecedencia', width: 20 },
    { header: 'Antecedência (horas)', key: 'antecedenciaHoras', width: 16, formato: 'decimal1' },
    { header: 'Classificação do prazo', key: 'classificacao', width: 16 },
    { header: 'Qtd. bens', key: 'qtdBens', width: 10, formato: 'inteiro' },
    { header: 'Qtd. papelaria', key: 'qtdPapelaria', width: 12, formato: 'inteiro' },
    { header: 'Qtd. serviços', key: 'qtdServicos', width: 12, formato: 'inteiro' },
    { header: 'Retirada em', key: 'retiradaEmCol', width: 16, formato: 'dataHora' },
    { header: 'Devolução em', key: 'devolucaoEmCol', width: 16, formato: 'dataHora' },
    { header: 'Não retirada em', key: 'naoRetiradaEmCol', width: 16, formato: 'dataHora' },
    { header: 'Condição da devolução', key: 'condicaoDevolucao', width: 20 },
    { header: 'Observação da devolução', key: 'obsDevolucao', width: 30, wrap: true },
    { header: 'Observações', key: 'observacoes', width: 34, wrap: true },
  ]

  const sheet = criarAba(workbook, 'Solicitações', colunas)
  const linhas = solicitacoes.map((s) => ({
    numero: s.numero,
    criadaEm: paraHoraBrasilia(s.createdAt),
    data: s.data,
    solicitante: s.solicitante.nome,
    email: s.solicitante.email,
    tipo: TIPO_EMPRESTIMO_LABELS[s.tipoEmprestimo],
    origem: origemLabel(s.origem),
    ambiente: s.ambiente ?? '',
    local: s.local ?? '',
    cidade: s.cidade ?? '',
    finalidade: s.finalidade ?? s.atividadeExterna ?? '',
    periodos: periodosTexto(s.periodos),
    status: STATUS_SOLICITACAO_LABELS[s.status],
    prazoMinimo: s.prazoHoras !== null ? `${s.prazoHoras}h` : '',
    antecedencia:
      s.antecedenciaMinutos !== null
        ? formatarAntecedencia(s.antecedenciaMinutos)
        : s.origem === 'ATENDIMENTO_IMEDIATO'
          ? 'Não se aplica'
          : 'N/D',
    antecedenciaHoras: s.antecedenciaMinutos !== null ? Math.round((s.antecedenciaMinutos / 60) * 10) / 10 : null,
    classificacao: classificacaoPrazo(s.origem, s.dentroDoPrazo),
    qtdBens: s._count.itensPatrimonio,
    qtdPapelaria: s._count.itensPapelaria,
    qtdServicos: s._count.itensServico,
    retiradaEmCol: paraHoraBrasilia(s.retiradaEm),
    devolucaoEmCol: paraHoraBrasilia(s.devolucaoEm),
    naoRetiradaEmCol: paraHoraBrasilia(s.naoRetiradaEm),
    // registro novo usa o enum estruturado; registro antigo preserva o
    // texto legado literal — nunca misturados (ver migration 9A-C).
    condicaoDevolucao: s.devolucaoCondicao
      ? CONDICAO_DEVOLUCAO_LABELS[s.devolucaoCondicao]
      : (s.devolucaoCondicaoTextoLegado ?? ''),
    obsDevolucao: s.devolucaoObs ?? '',
    observacoes: s.observacoes ?? '',
  }))
  preencherLinhas(sheet, colunas, linhas)
  colorirClassificacao(sheet, 'classificacao')
  return sheet
}

// =============================================================================
// ABA 3 — BENS MOVIMENTADOS
// =============================================================================

function construirAbaBens(workbook: ExcelJS.Workbook, bens: BemMovimentado[]) {
  const colunas: DefinicaoColuna[] = [
    { header: 'Nº solicitação', key: 'numero', width: 12, formato: 'inteiro' },
    { header: 'Data', key: 'data', width: 14, formato: 'data' },
    { header: 'Solicitante', key: 'solicitante', width: 24 },
    { header: 'Tipo', key: 'tipo', width: 10 },
    { header: 'Origem', key: 'origem', width: 18 },
    { header: 'Período', key: 'periodo', width: 16 },
    { header: 'Patrimônio', key: 'patrimonio', width: 14 },
    { header: 'Categoria', key: 'categoria', width: 20 },
    { header: 'Marca', key: 'marca', width: 16 },
    { header: 'Modelo', key: 'modelo', width: 20 },
    { header: 'Status', key: 'status', width: 24 },
    { header: 'Retirada', key: 'retirada', width: 16, formato: 'dataHora' },
    { header: 'Devolução', key: 'devolucao', width: 16, formato: 'dataHora' },
  ]
  const sheet = criarAba(workbook, 'Bens Movimentados', colunas)
  const linhas = bens.map((b) => ({
    numero: b.solicitacao.numero,
    data: b.solicitacao.data,
    solicitante: b.solicitacao.solicitante.nome,
    tipo: TIPO_EMPRESTIMO_LABELS[b.solicitacao.tipoEmprestimo],
    origem: origemLabel(b.solicitacao.origem),
    periodo: periodosTexto(b.solicitacao.periodos),
    patrimonio: b.patrimonio.numero,
    categoria: b.patrimonio.categoria.nome,
    marca: b.patrimonio.marca,
    modelo: b.patrimonio.modelo,
    status: STATUS_SOLICITACAO_LABELS[b.solicitacao.status],
    retirada: paraHoraBrasilia(b.solicitacao.retiradaEm),
    devolucao: paraHoraBrasilia(b.solicitacao.devolucaoEm),
  }))
  preencherLinhas(sheet, colunas, linhas)
  return sheet
}

// =============================================================================
// ABA 4 — PAPELARIA
// =============================================================================

function construirAbaPapelaria(workbook: ExcelJS.Workbook, itens: ItemPapelariaCompleto[]) {
  const colunas: DefinicaoColuna[] = [
    { header: 'Nº solicitação', key: 'numero', width: 12, formato: 'inteiro' },
    { header: 'Data', key: 'data', width: 14, formato: 'data' },
    { header: 'Solicitante', key: 'solicitante', width: 24 },
    { header: 'Tipo', key: 'tipo', width: 10 },
    { header: 'Origem', key: 'origem', width: 18 },
    { header: 'Período', key: 'periodo', width: 16 },
    { header: 'Descrição original', key: 'descricaoOriginal', width: 30, wrap: true },
    { header: 'Descrição normalizada', key: 'descricaoNormalizada', width: 24 },
    { header: 'Quantidade', key: 'quantidade', width: 12, formato: 'inteiro' },
    { header: 'Status', key: 'status', width: 24 },
  ]
  const sheet = criarAba(workbook, 'Papelaria', colunas)
  const linhas = itens.map((item) => ({
    numero: item.solicitacao.numero,
    data: item.solicitacao.data,
    solicitante: item.solicitacao.solicitante.nome,
    tipo: TIPO_EMPRESTIMO_LABELS[item.solicitacao.tipoEmprestimo],
    origem: origemLabel(item.solicitacao.origem),
    periodo: periodosTexto(item.solicitacao.periodos),
    descricaoOriginal: item.descricao,
    descricaoNormalizada: normalizarItemPapelaria(item.descricao).descricaoExibicao,
    quantidade: item.quantidade,
    status: STATUS_SOLICITACAO_LABELS[item.solicitacao.status],
  }))
  preencherLinhas(sheet, colunas, linhas)
  return sheet
}

// =============================================================================
// ABA 5 — SERVIÇOS
// =============================================================================

function construirAbaServicos(workbook: ExcelJS.Workbook, servicos: ServicoCompleto[]) {
  const colunas: DefinicaoColuna[] = [
    { header: 'Nº solicitação', key: 'numero', width: 12, formato: 'inteiro' },
    { header: 'Data', key: 'data', width: 14, formato: 'data' },
    { header: 'Solicitante', key: 'solicitante', width: 24 },
    { header: 'Tipo', key: 'tipo', width: 10 },
    { header: 'Origem', key: 'origem', width: 18 },
    { header: 'Período', key: 'periodo', width: 16 },
    { header: 'Serviço/Movimentação', key: 'servico', width: 26 },
    { header: 'Quantidade', key: 'quantidade', width: 12, formato: 'inteiro' },
    { header: 'Ambiente', key: 'ambiente', width: 18 },
    { header: 'Observação', key: 'observacao', width: 30, wrap: true },
    { header: 'Status', key: 'status', width: 24 },
  ]
  const sheet = criarAba(workbook, 'Serviços', colunas)
  const linhas = servicos.map((item) => ({
    numero: item.solicitacao.numero,
    data: item.solicitacao.data,
    solicitante: item.solicitacao.solicitante.nome,
    tipo: TIPO_EMPRESTIMO_LABELS[item.solicitacao.tipoEmprestimo],
    origem: origemLabel(item.solicitacao.origem),
    periodo: periodosTexto(item.solicitacao.periodos),
    servico: item.tipoServico.nome,
    quantidade: item.quantidade ?? null,
    ambiente: item.ambiente ?? '',
    observacao: item.observacao ?? '',
    status: STATUS_SOLICITACAO_LABELS[item.solicitacao.status],
  }))
  preencherLinhas(sheet, colunas, linhas)
  return sheet
}

// =============================================================================
// ABA 6 — PRAZOS
// =============================================================================

function construirAbaPrazos(workbook: ExcelJS.Workbook, solicitacoes: SolicitacaoCompleta[]) {
  const colunas: DefinicaoColuna[] = [
    { header: 'Nº', key: 'numero', width: 8, formato: 'inteiro' },
    { header: 'Tipo', key: 'tipo', width: 10 },
    { header: 'Solicitante', key: 'solicitante', width: 24 },
    { header: 'Criada em', key: 'criadaEm', width: 16, formato: 'dataHora' },
    { header: 'Data/hora de referência', key: 'referencia', width: 18, formato: 'dataHora' },
    { header: 'Período', key: 'periodo', width: 16 },
    { header: 'Prazo mínimo aplicado', key: 'prazoMinimo', width: 16 },
    { header: 'Antecedência', key: 'antecedencia', width: 20 },
    { header: 'Antecedência (horas)', key: 'antecedenciaHoras', width: 16, formato: 'decimal1' },
    { header: 'Classificação', key: 'classificacao', width: 16 },
  ]
  const sheet = criarAba(workbook, 'Prazos', colunas)
  const linhas = solicitacoes.map((s) => ({
    numero: s.numero,
    tipo: TIPO_EMPRESTIMO_LABELS[s.tipoEmprestimo],
    solicitante: s.solicitante.nome,
    criadaEm: paraHoraBrasilia(s.createdAt),
    referencia: paraHoraBrasilia(s.prazoReferenciaEm),
    periodo: periodosTexto(s.periodos),
    prazoMinimo: s.prazoHoras !== null ? `${s.prazoHoras}h` : '',
    antecedencia:
      s.antecedenciaMinutos !== null
        ? formatarAntecedencia(s.antecedenciaMinutos)
        : s.origem === 'ATENDIMENTO_IMEDIATO'
          ? 'Não se aplica'
          : 'N/D',
    antecedenciaHoras: s.antecedenciaMinutos !== null ? Math.round((s.antecedenciaMinutos / 60) * 10) / 10 : null,
    classificacao: classificacaoPrazo(s.origem, s.dentroDoPrazo),
  }))
  preencherLinhas(sheet, colunas, linhas)
  colorirClassificacao(sheet, 'classificacao')
  return sheet
}

// =============================================================================
// ABA 7 — INDICADORES MENSAIS
// =============================================================================

function construirAbaIndicadoresMensais(
  workbook: ExcelJS.Workbook,
  evolucaoMensal: DadosExcel['dados']['evolucaoMensal'],
  complementares: DadosExcel['indicadoresComplementares']
) {
  const colunas: DefinicaoColuna[] = [
    { header: 'Mês', key: 'mes', width: 12 },
    { header: 'Total', key: 'total', width: 10, formato: 'inteiro' },
    { header: 'Reservas antecipadas', key: 'reservas', width: 16, formato: 'inteiro' },
    { header: 'Atendimentos imediatos', key: 'imediatos', width: 18, formato: 'inteiro' },
    { header: 'Internas', key: 'internas', width: 10, formato: 'inteiro' },
    { header: 'Externas', key: 'externas', width: 10, formato: 'inteiro' },
    { header: 'Dentro', key: 'dentro', width: 10, formato: 'inteiro' },
    { header: 'Fora', key: 'fora', width: 10, formato: 'inteiro' },
    { header: 'Sem classificação', key: 'semClassificacao', width: 14, formato: 'inteiro' },
    { header: '% dentro', key: 'percDentro', width: 10, formato: 'percentual' },
    { header: '% fora', key: 'percFora', width: 10, formato: 'percentual' },
    { header: 'Finalizadas', key: 'finalizadas', width: 12, formato: 'inteiro' },
    { header: 'Canceladas', key: 'canceladas', width: 12, formato: 'inteiro' },
    { header: 'Não retiradas', key: 'naoRetiradas', width: 14, formato: 'inteiro' },
    { header: 'Retirada vencida s/ registro', key: 'retiradasVencidasSemRegistro', width: 18, formato: 'inteiro' },
    { header: 'Bens movimentados', key: 'bensMovimentados', width: 16, formato: 'inteiro' },
    { header: 'Solicitações com papelaria', key: 'papelaria', width: 18, formato: 'inteiro' },
    { header: 'Serviços realizados', key: 'servicos', width: 16, formato: 'inteiro' },
  ]
  const sheet = criarAba(workbook, 'Indicadores Mensais', colunas)

  const historico = recortarHistoricoEmFormacao(evolucaoMensal)
  const complementaresPorMes = new Map(complementares.map((c) => [c.mes, c]))

  const linhas = historico.meses.map((mes) => {
    const comp = complementaresPorMes.get(mes.mes)
    const basePrazo = mes.dentroPrazo + mes.foraPrazo
    const semClassificacao = Math.max(0, mes.reservasAntecipadas - mes.dentroPrazo - mes.foraPrazo)
    return {
      mes: mes.mes,
      total: mes.total,
      reservas: mes.reservasAntecipadas,
      imediatos: mes.atendimentosImediatos,
      internas: mes.internas,
      externas: mes.externas,
      dentro: mes.dentroPrazo,
      fora: mes.foraPrazo,
      semClassificacao,
      percDentro: basePrazo > 0 ? mes.dentroPrazo / basePrazo : null,
      percFora: basePrazo > 0 ? mes.foraPrazo / basePrazo : null,
      finalizadas: comp?.finalizadas ?? 0,
      canceladas: comp?.canceladas ?? 0,
      naoRetiradas: comp?.naoRetiradas ?? 0,
      retiradasVencidasSemRegistro: comp?.retiradasVencidasSemRegistro ?? 0,
      bensMovimentados: comp?.bensMovimentados ?? 0,
      papelaria: comp?.solicitacoesComPapelaria ?? 0,
      servicos: comp?.servicosRealizados ?? 0,
    }
  })

  preencherLinhas(sheet, colunas, linhas)

  if (historico.inicioHistorico) {
    const notaRow = sheet.addRow([`Histórico em formação — dados disponíveis a partir de ${formatarMesAnoCompleto(historico.inicioHistorico)}.`])
    sheet.mergeCells(notaRow.number, 1, notaRow.number, colunas.length)
    notaRow.getCell(1).font = { italic: true, color: { argb: COR.cinza }, size: 9 }
  }

  return sheet
}

// =============================================================================
// ORQUESTRAÇÃO
// =============================================================================

export async function gerarRelatorioExcel(params: {
  dadosExcel: DadosExcel
  periodo: string
  filtros: string[]
  geradoEm: string
}) {
  const { dadosExcel, periodo, filtros, geradoEm } = params
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Fluxo Patrimonial — Sistema de Patrimônio'
  workbook.created = new Date()

  construirAbaResumo(workbook, dadosExcel.dados, periodo, filtros, geradoEm)
  construirAbaSolicitacoes(workbook, dadosExcel.solicitacoes)
  construirAbaBens(workbook, dadosExcel.bensMovimentados)
  construirAbaPapelaria(workbook, dadosExcel.papelaria)
  construirAbaServicos(workbook, dadosExcel.servicos)
  construirAbaPrazos(workbook, dadosExcel.solicitacoes)
  construirAbaIndicadoresMensais(workbook, dadosExcel.dados.evolucaoMensal, dadosExcel.indicadoresComplementares)

  return workbook.xlsx.writeBuffer()
}
