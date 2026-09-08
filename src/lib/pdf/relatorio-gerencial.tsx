/** @jsxRuntime classic */
/** @jsx nodeReact.createElement */
/** @jsxFrag nodeReact.Fragment */
import type React from 'react'
import { Document, Page, Text, View, StyleSheet, Font } from '@react-pdf/renderer'
import { STATUS_SOLICITACAO_LABELS, TIPO_EMPRESTIMO_LABELS } from '@/types'
import type { obterDadosRelatorio, obterDetalhamentoRelatorio } from '@/lib/relatorios'
import { formatarAntecedenciaHumana, formatarMesAnoCompleto, recortarHistoricoEmFormacao } from '@/lib/relatorios-formatacao'

// Usa a instalação React 18 do projeto, não o JSX runtime de Server Components
// vendorizado pelo Next.js 15. O reconciliador do react-pdf exige react.element.
const nodeReact = require('react-pdf-react') as typeof React

Font.registerHyphenationCallback((word) => [word])

type Dados = Awaited<ReturnType<typeof obterDadosRelatorio>>
type Detalhes = Awaited<ReturnType<typeof obterDetalhamentoRelatorio>>

const C = { blue: '#0F6B63', dark: '#17324d', pale: '#e6f0ef', gray: '#667085', line: '#d9e2ea', bg: '#f6f8fa', green: '#18794e', red: '#b42318', white: '#ffffff' }
const s = StyleSheet.create({
  page: { paddingTop: 24, paddingBottom: 48, paddingHorizontal: 38, fontFamily: 'Helvetica', fontSize: 8.5, color: C.dark, backgroundColor: C.white },
  cover: { padding: 54, fontFamily: 'Helvetica', backgroundColor: C.blue, color: C.white },
  coverRule: { width: 54, height: 5, backgroundColor: '#C08A2E', marginTop: 150, marginBottom: 30 },
  coverKicker: { fontSize: 10, letterSpacing: 1.8, marginBottom: 12 },
  coverTitle: { fontSize: 29, fontFamily: 'Helvetica-Bold', lineHeight: 1.15 },
  coverSub: { fontSize: 16, marginTop: 8 },
  coverMeta: { position: 'absolute', left: 54, right: 54, bottom: 58, borderTopWidth: 1, borderTopColor: '#3D8F86', paddingTop: 18, fontSize: 10, lineHeight: 1.6 },
  header: { borderBottomWidth: 1, borderBottomColor: C.line, paddingBottom: 8, marginBottom: 30, flexDirection: 'row', justifyContent: 'space-between', color: C.blue, fontSize: 7.5, fontFamily: 'Helvetica-Bold' },
  footer: { position: 'absolute', bottom: 20, left: 38, right: 38, borderTopWidth: 1, borderTopColor: C.line, paddingTop: 7, flexDirection: 'row', justifyContent: 'space-between', color: C.gray, fontSize: 7 },
  title: { fontSize: 20, fontFamily: 'Helvetica-Bold', color: C.blue, marginBottom: 4 },
  lead: { fontSize: 9, color: C.gray, marginBottom: 18 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -4, marginBottom: 10 },
  card: { width: '25%', padding: 4 },
  cardBody: { backgroundColor: C.bg, borderTopWidth: 3, borderTopColor: C.blue, padding: 10, minHeight: 58 },
  cardValue: { fontSize: 18, fontFamily: 'Helvetica-Bold', color: C.dark },
  cardLabel: { fontSize: 7.5, color: C.gray, marginTop: 4 },
  section: { marginTop: 13, marginBottom: 7, fontSize: 11, fontFamily: 'Helvetica-Bold', color: C.blue },
  paragraph: { fontSize: 9, lineHeight: 1.55, color: C.dark, backgroundColor: C.pale, padding: 12 },
  row: { width: '100%', flexDirection: 'row', flexWrap: 'nowrap', borderBottomWidth: 1, borderBottomColor: C.line, minHeight: 22, alignItems: 'center' },
  th: { backgroundColor: C.blue, color: C.white, fontFamily: 'Helvetica-Bold' },
  cell: { paddingVertical: 5, paddingHorizontal: 5, fontSize: 7.5, flexGrow: 0, flexShrink: 0 },
  barRow: { marginBottom: 7 },
  barLabel: { flexDirection: 'row', justifyContent: 'space-between', fontSize: 8, marginBottom: 3 },
  barTrack: { height: 7, backgroundColor: C.pale },
  bar: { height: 7, backgroundColor: C.blue },
  note: { fontSize: 7.5, color: C.gray, lineHeight: 1.45, marginTop: 9 },
  empty: { padding: 18, backgroundColor: C.bg, color: C.gray, textAlign: 'center', fontSize: 9 },
})

const pct = (n: number, total: number) => total ? `${((n / total) * 100).toFixed(1)}%` : 'N/D'
const n = (value: number | null) => value === null ? 'N/D' : String(value)
const origem = (v: string) => v === 'ATENDIMENTO_IMEDIATO' ? 'Imediato' : 'Reserva'
const prazo = (v: { origem: string; dentroDoPrazo: boolean | null }) => v.origem === 'ATENDIMENTO_IMEDIATO' ? 'Não se aplica' : v.dentroDoPrazo === true ? 'Dentro' : v.dentroDoPrazo === false ? 'Fora' : 'N/D'

function HeaderFooter({ periodo, geradoEm }: { periodo: string; geradoEm: string }) {
  return <>
    <View style={s.header}><Text>RELATÓRIO GERENCIAL - GESTÃO DE PATRIMÔNIO</Text><Text>Fluxo Patrimonial</Text></View>
    <View style={s.footer}><Text>{periodo}  |  Gerado em {geradoEm}</Text><Text render={({ pageNumber, totalPages }) => `Página ${pageNumber} de ${totalPages}`} /></View>
  </>
}

function InternalPage({ title, lead, periodo, geradoEm, children }: { title: string; lead?: string; periodo: string; geradoEm: string; children: React.ReactNode }) {
  return <Page size="A4" wrap={false} style={s.page}><HeaderFooter periodo={periodo} geradoEm={geradoEm} /><Text style={s.title}>{title}</Text>{lead && <Text style={s.lead}>{lead}</Text>}{children}</Page>
}

function Cards({ items }: { items: Array<{ label: string; value: string | number; color?: string }> }) {
  return <View style={s.grid}>{items.map((x) => <View style={s.card} key={x.label}><View style={[s.cardBody, x.color ? { borderTopColor: x.color } : {}]}><Text style={s.cardValue}>{x.value}</Text><Text style={s.cardLabel}>{x.label}</Text></View></View>)}</View>
}

function Table({ headers, rows, widths }: { headers: string[]; rows: Array<Array<string | number>>; widths?: string[] }) {
  if (!rows.length) return <Text style={s.empty}>Nenhum dado encontrado para o período.</Text>
  return <View wrap><View style={[s.row, s.th]}>{headers.map((h, i) => <Text key={h} style={[s.cell, { width: widths?.[i] ?? `${99 / headers.length}%` }]}>{h}</Text>)}</View>{rows.map((row, ri) => <View style={s.row} wrap={false} key={ri}>{row.map((v, i) => <Text key={i} style={[s.cell, { width: widths?.[i] ?? `${99 / headers.length}%` }]}>{String(v)}</Text>)}</View>)}</View>
}

function Bars({ rows }: { rows: Array<{ label: string; value: number }> }) {
  const max = Math.max(1, ...rows.map((x) => x.value))
  return <View>{rows.length ? rows.map((x) => <View style={s.barRow} key={x.label}><View style={s.barLabel}><Text>{x.label}</Text><Text>{x.value}</Text></View><View style={s.barTrack}><View style={[s.bar, { width: `${Math.max(1, x.value / max * 100)}%` }]} /></View></View>) : <Text style={s.empty}>Nenhum dado encontrado para o período.</Text>}</View>
}

export function RelatorioGerencialPdf({ dados, detalhes, periodo, filtros, geradoEm }: { dados: Dados; detalhes: Detalhes; periodo: string; filtros: string[]; geradoEm: string }) {
  const semClassificacao = Math.max(0, dados.resumo.reservasAntecipadas - dados.resumo.dentroPrazo - dados.resumo.foraPrazo)
  const basePrazo = dados.resumo.dentroPrazo + dados.resumo.foraPrazo
  const taxaRetiradaDenom = dados.operacao.retiradas + dados.operacao.naoRetiradas
  const historico = recortarHistoricoEmFormacao(dados.evolucaoMensal)
  const notaHistorico = historico.inicioHistorico
    ? `Histórico em formação - dados disponíveis a partir de ${formatarMesAnoCompleto(historico.inicioHistorico)}.`
    : null
  return <Document title={`Relatório Gerencial - ${periodo}`} author="Fluxo Patrimonial" subject="Gestão de Patrimônio">
    <Page size="A4" style={s.cover}>
      <View style={s.coverRule} /><Text style={s.coverKicker}>FLUXO PATRIMONIAL</Text><Text style={s.coverTitle}>RELATÓRIO{`\n`}GERENCIAL</Text><Text style={s.coverSub}>Gestão de Patrimônio</Text>
      <View style={s.coverMeta}><Text>Período: {periodo}</Text><Text>Gerado em: {geradoEm}</Text>{filtros.length > 0 && <><Text style={{ marginTop: 9, fontFamily: 'Helvetica-Bold' }}>Filtros aplicados</Text><Text>{filtros.join('  •  ')}</Text></>}</View>
    </Page>

    <InternalPage title="Resumo Executivo" lead="Visão consolidada do período selecionado" periodo={periodo} geradoEm={geradoEm}>
      <Cards items={[{ label: 'Total de atendimentos', value: dados.resumo.total }, { label: 'Reservas antecipadas', value: dados.resumo.reservasAntecipadas }, { label: 'Reservas na demanda', value: pct(dados.resumo.reservasAntecipadas, dados.resumo.total) }, { label: 'Atendimentos imediatos', value: dados.resumo.atendimentosImediatos }, { label: 'Imediatos na demanda', value: pct(dados.resumo.atendimentosImediatos, dados.resumo.total) }, { label: 'Dentro do prazo', value: dados.resumo.dentroPrazo, color: C.green }, { label: 'Fora do prazo', value: dados.resumo.foraPrazo, color: C.red }, { label: 'Sem classificação', value: semClassificacao }, { label: 'Finalizadas', value: dados.operacao.finalizadas, color: C.green }]} />
      <Text style={s.section}>Síntese</Text><Text style={s.paragraph}>{dados.resumoExecutivo}</Text>
    </InternalPage>

    <InternalPage title="Solicitações" lead="Composição, evolução mensal e distribuição por status" periodo={periodo} geradoEm={geradoEm}>
      <Cards items={[{ label: 'Internas', value: dados.resumo.internas }, { label: 'Externas', value: dados.resumo.externas }, { label: 'Total', value: dados.resumo.total }]} />
      <Text style={s.section}>Evolução mensal</Text><Table headers={['Mês', 'Total', 'Internas', 'Externas', 'Imediatos']} widths={['24%','19%','19%','19%','19%']} rows={historico.meses.map((x) => [x.mes, x.total, x.internas, x.externas, x.atendimentosImediatos])} />
      {notaHistorico && <Text style={s.note}>{notaHistorico}</Text>}
      <Text style={s.section}>Distribuição por status</Text><Bars rows={dados.statusDist.map((x) => ({ label: STATUS_SOLICITACAO_LABELS[x.status], value: x.quantidade })).sort((a,b) => b.value-a.value)} />
    </InternalPage>

    <InternalPage title="Prazos" lead="Classificação histórica das reservas antecipadas" periodo={periodo} geradoEm={geradoEm}>
      <Cards items={[{ label: 'Dentro', value: dados.resumo.dentroPrazo, color: C.green }, { label: 'Fora', value: dados.resumo.foraPrazo, color: C.red }, { label: 'Sem classificação', value: semClassificacao }, { label: 'Base percentual', value: basePrazo }, { label: 'Reservas totais', value: dados.resumo.reservasAntecipadas }, { label: '% dentro', value: pct(dados.resumo.dentroPrazo, basePrazo), color: C.green }, { label: '% fora', value: pct(dados.resumo.foraPrazo, basePrazo), color: C.red }]} />
      <Text style={s.section}>Antecedência média</Text><Cards items={[{ label: 'Interna', value: formatarAntecedenciaHumana(dados.antecedenciaMedia.internasMinutos) }, { label: 'Externa', value: formatarAntecedenciaHumana(dados.antecedenciaMedia.externasMinutos) }]} />
      <Text style={s.section}>Evolução do percentual fora do prazo</Text><Table headers={['Mês', 'Dentro', 'Fora', 'Base', '% fora']} rows={historico.meses.map((x) => [x.mes, x.dentroPrazo, x.foraPrazo, x.dentroPrazo + x.foraPrazo, pct(x.foraPrazo, x.dentroPrazo + x.foraPrazo)])} />
      {notaHistorico && <Text style={s.note}>{notaHistorico}</Text>}
      <Text style={s.note}>Registros históricos sem classificação não são recalculados e não entram na base percentual. Atendimentos imediatos não possuem regra de antecedência.</Text>
    </InternalPage>

    <InternalPage title="Atendimentos Imediatos" lead="Participação na demanda e composição do atendimento" periodo={periodo} geradoEm={geradoEm}>
      <Cards items={[{ label: 'Total', value: dados.atendimentoImediato.total }, { label: 'Percentual da demanda', value: `${dados.atendimentoImediato.percentualDemanda.toFixed(1)}%` }, { label: 'Com bens', value: dados.atendimentoImediato.comBens }, { label: 'Com papelaria', value: dados.atendimentoImediato.comPapelaria }, { label: 'Com serviço', value: dados.atendimentoImediato.comServico }]} />
      <Text style={s.note}>Um atendimento pode conter bens, papelaria e serviços simultaneamente; portanto, as categorias não são mutuamente exclusivas.</Text>
      <Text style={s.section}>Por turno</Text><Table headers={['Turno', 'Reservas', 'Atendimento imediato', 'Total']} rows={dados.distribuicaoPeriodo.map((x) => [x.periodo === 'MANHA' ? 'Manhã' : x.periodo === 'TARDE' ? 'Tarde' : 'Noite', x.reservas, x.atendimentosImediatos, x.total])} />
    </InternalPage>

    <InternalPage title="Patrimônio" lead="Bens e categorias mais movimentados" periodo={periodo} geradoEm={geradoEm}>
      <Cards items={[{ label: 'Total de bens movimentados', value: dados.bens.totalBensMovimentados }]} /><Text style={s.section}>Categorias mais utilizadas</Text><Bars rows={dados.bens.rankingCategorias.map((x) => ({ label: x.categoriaNome, value: x.utilizacoes }))} />
      <Text style={s.section}>Equipamentos mais movimentados</Text><Table headers={['Patrimônio', 'Marca / Modelo', 'Categoria', 'Utilizações']} widths={['18%','36%','30%','16%']} rows={dados.bens.rankingPatrimonios.map((x) => [x.numero, `${x.marca} / ${x.modelo}`, x.categoriaNome, x.utilizacoes])} />
    </InternalPage>

    <InternalPage title="Papelaria" lead="Consumo agregado sem alteração dos dados armazenados" periodo={periodo} geradoEm={geradoEm}>
      <Cards items={[{ label: 'Solicitações com papelaria', value: dados.papelaria.solicitacoesComPapelaria }, { label: 'Quantidade total de itens', value: dados.papelaria.quantidadeTotalItens }, { label: 'Imediatos com papelaria', value: dados.papelaria.atendimentosImediatosComPapelaria }]} />
      <Text style={s.section}>Itens mais solicitados</Text><Table headers={['Item', 'Quantidade', 'Ocorrências']} widths={['60%','20%','20%']} rows={dados.papelaria.itensMaisSolicitados.map((x) => [x.descricaoNormalizada, x.quantidadeTotal, x.ocorrencias])} />
    </InternalPage>

    <InternalPage title="Serviços / Movimentações" lead="Volume e ranking de serviços realizados" periodo={periodo} geradoEm={geradoEm}>
      <Cards items={[{ label: 'Serviços realizados', value: dados.servicos.totalServicosRealizados }, { label: 'Solicitações com serviço', value: dados.servicos.solicitacoesComServico }]} />
      <Text style={s.section}>Ranking dos serviços</Text><Table headers={['Serviço / movimentação', 'Ocorrências', 'Quantidade']} widths={['64%','18%','18%']} rows={dados.servicos.ranking.map((x) => [x.nome, x.ocorrencias, n(x.quantidadeTotal)])} />
    </InternalPage>

    <InternalPage title="Eficiência Operacional" lead="Indicadores do fluxo de retirada e encerramento" periodo={periodo} geradoEm={geradoEm}>
      <Cards items={[{ label: 'Prontas para retirada', value: dados.operacao.prontasRetirada }, { label: 'Retiradas', value: dados.operacao.retiradas, color: C.green }, { label: 'Não retiradas', value: dados.operacao.naoRetiradas, color: C.red }, { label: 'Retirada vencida s/ registro', value: dados.operacao.retiradasVencidasSemRegistro }, { label: 'Em utilização', value: dados.operacao.emUtilizacao }, { label: 'Finalizadas', value: dados.operacao.finalizadas, color: C.green }, { label: 'Canceladas', value: dados.operacao.canceladas, color: C.red }, { label: 'Taxa de retirada', value: pct(dados.operacao.retiradas, taxaRetiradaDenom) }]} />
      <Text style={s.section}>Fórmula</Text><Text style={s.paragraph}>Retiradas / (Retiradas + Não retiradas registradas)</Text>
      <Text style={s.note}>&quot;Não retiradas&quot; conta solicitações com status registrado manualmente pelo Patrimônio. &quot;Retirada vencida s/ registro&quot; é um alerta operacional à parte (retirada esperada e ainda não registrada) — não entra na fórmula da taxa de retirada. O relatório apenas consulta os dados. Nenhum status é alterado durante a geração.</Text>
    </InternalPage>

    <InternalPage title="Detalhamento - Principais Solicitações" lead="Amostra das solicitações mais recentes no recorte filtrado" periodo={periodo} geradoEm={geradoEm}>
      <Table headers={['Nº', 'Solicitante', 'Data', 'Tipo', 'Origem', 'Status', 'Prazo', 'Bens', 'Pap.', 'Serv.']} widths={['6%','16%','10%','8%','10%','15%','13%','7%','7%','8%']} rows={detalhes.solicitacoes.map((x) => [x.numero, x.solicitante.nome, x.data.toLocaleDateString('pt-BR', { timeZone: 'UTC' }), TIPO_EMPRESTIMO_LABELS[x.tipoEmprestimo], origem(x.origem), STATUS_SOLICITACAO_LABELS[x.status], prazo(x), x._count.itensPatrimonio, x._count.itensPapelaria, x._count.itensServico])} />
      <Text style={s.note}>Exibindo {detalhes.solicitacoes.length} de {detalhes.total} registros. O detalhamento completo está disponível na Visão Operacional e será disponibilizado integralmente na exportação Excel.</Text>
    </InternalPage>
  </Document>
}
