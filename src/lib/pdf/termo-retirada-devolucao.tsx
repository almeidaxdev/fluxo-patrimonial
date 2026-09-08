/** @jsxRuntime classic */
/** @jsx nodeReact.createElement */
/** @jsxFrag nodeReact.Fragment */
import type React from 'react'
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer'
import { TIPO_EMPRESTIMO_LABELS } from '@/types'
import type { Prisma } from '@prisma/client'
import { formatDataCivil, formatPeriodos } from '@/utils'

// Usa a instalação React 18 do projeto, não o JSX runtime de Server Components
// vendorizado pelo Next.js 15 — mesmo motivo/alias de src/lib/pdf/relatorio-gerencial.tsx.
const nodeReact = require('react-pdf-react') as typeof React

// Fonte única do que este PDF precisa: a rota (src/app/api/solicitacoes/[id]/
// termo/route.tsx) importa SELECT_TERMO para a query — nunca duplica esta
// lista — então o tipo abaixo nunca diverge do que é de fato buscado no banco.
export const SELECT_TERMO = {
  numero: true,
  tipoEmprestimo: true,
  data: true,
  periodos: true,
  ambiente: true,
  finalidade: true,
  observacoes: true,
  atividadeExterna: true,
  local: true,
  cidade: true,
  solicitanteId: true,
  criadoPorId: true,
  solicitante: { select: { nome: true } },
  criadoPor: { select: { nome: true } },
  gestor: { select: { nome: true } },
  itensPatrimonio: { select: { patrimonio: { select: { numero: true, categoria: { select: { nome: true } } } } } },
  itensPapelaria: { select: { descricao: true, quantidade: true } },
  itensServico: {
    select: {
      tipoServico: { select: { nome: true } },
      quantidade: true,
      ambiente: true,
      observacao: true,
    },
  },
} as const

export type SolicitacaoTermo = Prisma.SolicitacaoGetPayload<{ select: typeof SELECT_TERMO }>

// Compactação para caber em 1 página (rodada de refinamento): RETIRADA e
// DEVOLUÇÃO passaram de duas caixas empilhadas para DUAS COLUNAS lado a
// lado — mesmo conteúdo, mesma ordem de campos, só a disposição muda. É o
// maior ganho de espaço vertical do documento. Nenhum tamanho de fonte foi
// reduzido nesta rodada — só espaçamento (margin/padding).
const C = { blue: '#0F6B63', dark: '#17324d', gray: '#667085', line: '#c7d2dd', bg: '#f6f8fa' }
const s = StyleSheet.create({
  page: { paddingTop: 28, paddingBottom: 36, paddingHorizontal: 42, fontFamily: 'Helvetica', fontSize: 10, color: C.dark },
  headerKicker: { fontSize: 8.5, color: C.gray, fontFamily: 'Helvetica-Bold', letterSpacing: 0.6 },
  headerUnit: { fontSize: 8.5, color: C.gray, marginTop: 1 },
  title: { fontSize: 15, fontFamily: 'Helvetica-Bold', color: C.blue, marginTop: 10, marginBottom: 2 },
  subtitle: { fontSize: 9, color: C.gray, marginBottom: 9 },
  rule: { borderBottomWidth: 1, borderBottomColor: C.line, marginBottom: 10 },
  section: { fontSize: 10, fontFamily: 'Helvetica-Bold', color: C.blue, marginTop: 9, marginBottom: 5, textTransform: 'uppercase' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -6 },
  field: { width: '50%', paddingHorizontal: 6, marginBottom: 7 },
  fieldFull: { width: '100%', paddingHorizontal: 6, marginBottom: 7 },
  fieldLabel: { fontSize: 8, color: C.gray, fontFamily: 'Helvetica-Bold', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 2 },
  fieldValue: { fontSize: 10.5, color: C.dark },
  resumoBox: { backgroundColor: C.bg, borderRadius: 4, padding: 9 },
  resumoGroupTitle: { fontSize: 8.5, fontFamily: 'Helvetica-Bold', color: C.gray, textTransform: 'uppercase', marginTop: 5, marginBottom: 3 },
  resumoBemGrupo: { marginBottom: 4 },
  resumoItem: { fontSize: 10.5, color: C.dark, marginBottom: 1 },
  resumoPatrimonios: { fontSize: 10, color: C.blue, fontFamily: 'Helvetica-Bold' },
  resumoVazio: { fontSize: 9.5, color: C.gray },
  termoBox: { borderWidth: 1, borderColor: C.line, borderRadius: 4, padding: 9, backgroundColor: '#fbfcfd' },
  termoTexto: { fontSize: 9.5, lineHeight: 1.4, color: C.dark },
  colunasAssinatura: { flexDirection: 'row' },
  colunaAssinatura: { width: '50%' },
  colunaAssinaturaEsquerda: { paddingRight: 7 },
  colunaAssinaturaDireita: { paddingLeft: 7 },
  assinaturaBox: { borderWidth: 1, borderColor: C.line, borderRadius: 4, padding: 12, marginTop: 5 },
  linhaDupla: { flexDirection: 'row', marginBottom: 13 },
  campoLinha: { width: '50%', paddingRight: 10 },
  campoLinhaFull: { width: '100%', marginBottom: 14 },
  linhaLabel: { fontSize: 8.5, color: C.gray, marginBottom: 11 },
  // Linhas de assinatura manual (Assinatura do solicitante / Responsável
  // Patrimônio) recebem um espaço em branco maior entre o rótulo e o traço —
  // é aqui que a caneta precisa de espaço real. linhaTraco.marginTop
  // permanece o mesmo valor negativo; ao aumentar só o marginBottom do
  // rótulo, sobra um vão positivo (marginBottom - |marginTop|) para assinar.
  linhaLabelAssinatura: { fontSize: 8.5, color: C.gray, marginBottom: 34 },
  linhaTraco: { borderBottomWidth: 1, borderBottomColor: C.dark, marginTop: -11 },
  checkboxRow: { flexDirection: 'row', marginBottom: 9 },
  checkboxItem: { flexDirection: 'row', alignItems: 'center', marginRight: 16 },
  checkbox: { width: 10, height: 10, borderWidth: 1, borderColor: C.dark, marginRight: 5 },
  footer: { position: 'absolute', bottom: 18, left: 42, right: 42, borderTopWidth: 1, borderTopColor: C.line, paddingTop: 6, flexDirection: 'row', justifyContent: 'space-between', color: C.gray, fontSize: 7 },
})

function Campo({ label, value, full }: { label: string; value: string; full?: boolean }) {
  return (
    <View style={full ? s.fieldFull : s.field}>
      <Text style={s.fieldLabel}>{label}</Text>
      <Text style={s.fieldValue}>{value}</Text>
    </View>
  )
}

function LinhaAssinatura({ label, full, assinatura }: { label: string; full?: boolean; assinatura?: boolean }) {
  return (
    <View style={full ? s.campoLinhaFull : s.campoLinha}>
      <Text style={assinatura ? s.linhaLabelAssinatura : s.linhaLabel}>{label}</Text>
      <View style={s.linhaTraco} />
    </View>
  )
}

// Resumo agregado: bens patrimoniais contados POR CATEGORIA, na ordem em que
// a categoria aparece pela primeira vez na solicitação, mas agora também
// listando os números de patrimônio reais de cada item vinculado à própria
// solicitação (vindos do SELECT_TERMO acima, nunca do frontend) — o
// documento é assinado fisicamente e precisa identificar exatamente quais
// equipamentos foram entregues. Papelaria e serviços já chegam como itens
// curtos e não precisam de agregação adicional.
function agregarBens(itens: SolicitacaoTermo['itensPatrimonio']): Array<{ nome: string; quantidade: number; numeros: string[] }> {
  const ordem: string[] = []
  const contagem = new Map<string, number>()
  const numeros = new Map<string, string[]>()
  for (const item of itens) {
    const nome = item.patrimonio.categoria.nome
    if (!contagem.has(nome)) { ordem.push(nome); contagem.set(nome, 0); numeros.set(nome, []) }
    contagem.set(nome, contagem.get(nome)! + 1)
    numeros.get(nome)!.push(item.patrimonio.numero)
  }
  return ordem.map((nome) => ({
    nome,
    quantidade: contagem.get(nome)!,
    numeros: numeros.get(nome)!.slice().sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true })),
  }))
}

export function TermoRetiradaDevolucaoPdf({ solicitacao }: { solicitacao: SolicitacaoTermo }) {
  const externo = solicitacao.tipoEmprestimo === 'externo'
  const bens = agregarBens(solicitacao.itensPatrimonio)
  const geradoEm = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })

  return (
    <Document title={`Termo de Retirada e Devolução - Solicitação ${solicitacao.numero}`} author="Fluxo Patrimonial" subject="Termo de Retirada e Devolução">
      <Page size="A4" style={s.page}>
        <View>
          <Text style={s.headerKicker}>SISTEMA DE GESTÃO PATRIMONIAL</Text>
          <Text style={s.headerUnit}>Fluxo Patrimonial</Text>
        </View>
        <Text style={s.title}>TERMO DE RETIRADA E DEVOLUÇÃO</Text>
        <Text style={s.subtitle}>Solicitação nº {solicitacao.numero} — gerado em {geradoEm}</Text>
        <View style={s.rule} />

        <Text style={s.section}>Dados da solicitação</Text>
        <View style={s.grid}>
          <Campo label="Solicitação nº" value={String(solicitacao.numero)} />
          <Campo label="Tipo de empréstimo" value={TIPO_EMPRESTIMO_LABELS[solicitacao.tipoEmprestimo]} />
          <Campo label="Solicitante" value={solicitacao.solicitante.nome} />
          {solicitacao.criadoPorId !== solicitacao.solicitanteId && (
            <Campo label="Criado por" value={solicitacao.criadoPor.nome} />
          )}
          <Campo label="Data de utilização" value={formatDataCivil(solicitacao.data)} />
          <Campo label="Período(s)" value={formatPeriodos(solicitacao.periodos)} />
          {solicitacao.ambiente && <Campo label="Ambiente / sala" value={solicitacao.ambiente} />}
          {externo && solicitacao.atividadeExterna && <Campo label="Atividade" value={solicitacao.atividadeExterna} />}
          {externo && solicitacao.local && <Campo label="Local" value={solicitacao.local} />}
          {externo && solicitacao.cidade && <Campo label="Cidade" value={solicitacao.cidade} />}
          {externo && solicitacao.gestor && <Campo label="Gestor responsável" value={solicitacao.gestor.nome} />}
          {externo && solicitacao.finalidade && <Campo label="Finalidade" value={solicitacao.finalidade} full />}
          {solicitacao.observacoes && <Campo label="Observações" value={solicitacao.observacoes} full />}
        </View>

        <Text style={s.section}>Resumo da solicitação</Text>
        <View style={s.resumoBox}>
          <Text style={s.resumoGroupTitle}>Bens patrimoniais</Text>
          {bens.length > 0
            ? bens.map((b) => (
                <View key={b.nome} style={s.resumoBemGrupo}>
                  <Text style={s.resumoItem}>{b.nome} — {b.quantidade} {b.quantidade === 1 ? 'unidade' : 'unidades'}</Text>
                  <Text style={s.resumoPatrimonios}>{b.numeros.length === 1 ? 'Patrimônio' : 'Patrimônios'}: {b.numeros.join(' · ')}</Text>
                </View>
              ))
            : <Text style={s.resumoVazio}>Nenhum bem patrimonial nesta solicitação.</Text>}

          {solicitacao.itensPapelaria.length > 0 && (
            <>
              <Text style={s.resumoGroupTitle}>Papelaria</Text>
              {solicitacao.itensPapelaria.map((p, i) => <Text key={i} style={s.resumoItem}>{p.quantidade}x {p.descricao}</Text>)}
            </>
          )}

          {solicitacao.itensServico.length > 0 && (
            <>
              <Text style={s.resumoGroupTitle}>Serviços / Movimentações</Text>
              {solicitacao.itensServico.map((sv, i) => (
                <Text key={i} style={s.resumoItem}>
                  {sv.tipoServico.nome}{sv.quantidade ? ` — ${sv.quantidade}` : ''}{sv.ambiente ? ` — ${sv.ambiente}` : ''}{sv.observacao ? ` (${sv.observacao})` : ''}
                </Text>
              ))}
            </>
          )}
        </View>

        <Text style={s.section}>Termo de responsabilidade</Text>
        <View style={s.termoBox}>
          <Text style={s.termoTexto}>
            Declaro estar ciente da responsabilidade pela guarda e conservação dos bens retirados durante o período
            informado nesta solicitação, comprometendo-me a devolvê-los nas condições registradas no momento da
            retirada, ressalvado o desgaste decorrente do uso regular.
          </Text>
        </View>

        {/* RETIRADA e DEVOLUÇÃO lado a lado (item central desta rodada de
            compactação): mesmos campos de antes — só a disposição em duas
            colunas em vez de duas caixas empilhadas, que é o que faz o
            documento caber numa página no cenário normal. `wrap={false}`
            em cada coluna evita que uma caixa seja cortada ao meio se,
            excepcionalmente, não houver espaço e o documento precisar
            estender para a página 2 — nesse caso a coluna inteira migra. */}
        <View style={s.colunasAssinatura}>
          <View style={[s.colunaAssinatura, s.colunaAssinaturaEsquerda]} wrap={false}>
            <Text style={s.section}>Retirada</Text>
            <View style={s.assinaturaBox}>
              <View style={s.linhaDupla}>
                <LinhaAssinatura label="Data" />
                <LinhaAssinatura label="Horário" />
              </View>
              <LinhaAssinatura label="Assinatura do solicitante" full assinatura />
              <LinhaAssinatura label="Responsável Patrimônio" full assinatura />
            </View>
          </View>

          <View style={[s.colunaAssinatura, s.colunaAssinaturaDireita]} wrap={false}>
            <Text style={s.section}>Devolução</Text>
            <View style={s.assinaturaBox}>
              <View style={s.linhaDupla}>
                <LinhaAssinatura label="Data" />
                <LinhaAssinatura label="Horário" />
              </View>
              <Text style={[s.fieldLabel, { marginBottom: 5 }]}>Condição</Text>
              <View style={s.checkboxRow}>
                <View style={s.checkboxItem}><View style={s.checkbox} /><Text style={s.fieldValue}>Sem avarias</Text></View>
                <View style={s.checkboxItem}><View style={s.checkbox} /><Text style={s.fieldValue}>Com avarias</Text></View>
              </View>
              <LinhaAssinatura label="Observações" full />
              <LinhaAssinatura label="Assinatura do solicitante" full assinatura />
              <LinhaAssinatura label="Responsável Patrimônio" full assinatura />
            </View>
          </View>
        </View>

        <View style={s.footer} fixed>
          <Text>Documento gerado para preenchimento manual — não substitui a assinatura eletrônica do fluxo externo.</Text>
          <Text render={({ pageNumber, totalPages }) => `Página ${pageNumber} de ${totalPages}`} />
        </View>
      </Page>
    </Document>
  )
}
