// src/lib/email/templates/cancelamento.ts
// Etapa email-cancelamento — template ÚNICO para CANCELAMENTO, com dois
// públicos possíveis (mesmo princípio de templates/reserva-confirmada.ts):
// SOLICITANTE (sempre) e, condicionalmente, a equipe PATRIMÔNIO (só quando
// o status ANTERIOR ao cancelamento indica que o Patrimônio já estava
// operacionalmente envolvido — ver payloads/cancelamento.ts e
// STATUS_ANTERIOR_PATRIMONIO_OPERACIONAL na rota /cancelar).
import { formatDataCivil, formatPeriodos } from '@/utils'
import type { PeriodoSolicitacao, TipoEmprestimo, TipoDominio } from '@/types'
import { TIPO_DOMINIO_LABELS } from '@/types'
import { escapeHtml } from '../html'
import { renderEmailLayout, renderEmailLayoutText } from './layout'
import { renderButton, renderSummaryTable, renderItemList, type SummaryRowInput, type ListItemInput } from './components'
import type { RenderedEmail } from '../processar-evento'
import type { PapelDestinatario } from './reserva-confirmada'

export type { PapelDestinatario }

export interface ItemPatrimonioResumo {
  numero: string
  marca: string
  modelo: string
  /** Omitido quando o chamador não tiver a categoria disponível. */
  categoria?: string
}

export interface ItemPapelariaResumo {
  descricao: string
  quantidade: number
}

export interface ItemServicoResumo {
  tipoServicoNome: string
  quantidade: number | null
  ambiente: string | null
}

export interface CancelamentoTemplateInput {
  papel: PapelDestinatario
  numero: number
  nomeSolicitante: string
  tipoEmprestimo: TipoEmprestimo
  data: Date
  periodos: PeriodoSolicitacao[]
  ambiente: string | null
  finalidade: string | null
  atividadeExterna: string | null
  local: string | null
  cidade: string | null
  observacoes: string | null
  itensPatrimonio: ItemPatrimonioResumo[]
  itensPapelaria: ItemPapelariaResumo[]
  itensServico: ItemServicoResumo[]
  notebooksComDominio: boolean | null
  tipoDominio: TipoDominio | null
  /** Snapshot do nome de quem executou o cancelamento — sempre disponível (session.nome). */
  canceladoPorNome: string
  /**
   * Ausente no cancelamento atual (a rota /cancelar não recebe/persiste
   * motivo hoje — ver payloads/cancelamento.ts). `null` renderiza sem a
   * linha "Motivo do cancelamento", nunca um valor inventado.
   */
  motivo: string | null
  link: string
  /** Repassado direto de BuildEmailContext — ver processar-evento.ts. */
  bannerDestinatarioOriginal: string | null
}

function montarAssunto(input: CancelamentoTemplateInput): string {
  return `[Fluxo Patrimonial] Solicitação cancelada — #${input.numero}`
}

function montarFraseAbertura(input: CancelamentoTemplateInput): string {
  return input.papel === 'patrimonio'
    ? `A solicitação #${input.numero} foi cancelada e não deve mais ser preparada/entregue.`
    : 'Sua solicitação foi cancelada.'
}

function montarLinhasResumo(input: CancelamentoTemplateInput): SummaryRowInput[] {
  const linhas: SummaryRowInput[] = [
    { label: 'Solicitação', value: `#${input.numero}` },
  ]

  if (input.papel === 'patrimonio') {
    linhas.push({ label: 'Solicitante', value: input.nomeSolicitante })
  }

  linhas.push(
    { label: 'Cancelado por', value: input.canceladoPorNome },
    // input.data é a DATA CIVIL da reserva (Solicitacao.data, @db.Date) —
    // formatDataCivil(), nunca formatDate() (ver Etapa D.3.FOLLOW-UP).
    { label: 'Data', value: formatDataCivil(input.data) },
    { label: 'Período', value: formatPeriodos(input.periodos) }
  )

  if (input.ambiente) linhas.push({ label: 'Ambiente', value: input.ambiente })
  if (input.atividadeExterna) linhas.push({ label: 'Atividade', value: input.atividadeExterna })
  if (input.finalidade) linhas.push({ label: 'Finalidade', value: input.finalidade })
  if (input.local) linhas.push({ label: 'Local', value: input.local })
  if (input.cidade) linhas.push({ label: 'Cidade', value: input.cidade })
  if (input.notebooksComDominio !== null) {
    linhas.push({
      label: 'Domínio',
      value: input.notebooksComDominio
        ? (input.tipoDominio ? TIPO_DOMINIO_LABELS[input.tipoDominio] : 'Sim (tipo não informado)')
        : 'Não',
    })
  }

  return linhas
}

function montarItensPatrimonio(itens: ItemPatrimonioResumo[]): ListItemInput[] {
  return itens.map((item) => ({
    primary: item.categoria ? `${item.categoria} — ${item.marca} ${item.modelo}` : `${item.marca} ${item.modelo}`,
    secondary: `Patrimônio: ${item.numero}`,
  }))
}

function montarItensPapelaria(itens: ItemPapelariaResumo[]): ListItemInput[] {
  return itens.map((item) => ({ primary: `${item.descricao} (${item.quantidade}x)` }))
}

function montarItensServico(itens: ItemServicoResumo[]): ListItemInput[] {
  return itens.map((item) => ({
    primary: item.quantidade ? `${item.tipoServicoNome} (${item.quantidade}x)` : item.tipoServicoNome,
    secondary: item.ambiente ? `Ambiente: ${item.ambiente}` : undefined,
  }))
}

function blocoTextoLista(titulo: string, linhas: string[]): string {
  if (linhas.length === 0) return ''
  return [`${titulo}:`, ...linhas.map((linha) => `- ${linha}`)].join('\n')
}

function montarTextoItensPatrimonio(itens: ItemPatrimonioResumo[]): string[] {
  return itens.map((item) =>
    item.categoria
      ? `${item.categoria} — ${item.marca} ${item.modelo} (patrimônio ${item.numero})`
      : `${item.marca} ${item.modelo} (patrimônio ${item.numero})`
  )
}

function montarTextoItensPapelaria(itens: ItemPapelariaResumo[]): string[] {
  return itens.map((item) => `${item.descricao} (${item.quantidade}x)`)
}

function montarTextoItensServico(itens: ItemServicoResumo[]): string[] {
  return itens.map((item) => {
    const quantidade = item.quantidade ? ` (${item.quantidade}x)` : ''
    const ambiente = item.ambiente ? ` — Ambiente: ${item.ambiente}` : ''
    return `${item.tipoServicoNome}${quantidade}${ambiente}`
  })
}

export function renderCancelamentoEmail(input: CancelamentoTemplateInput): RenderedEmail {
  const subject = montarAssunto(input)
  const fraseAbertura = montarFraseAbertura(input)
  const linhasResumo = montarLinhasResumo(input)
  const nomeSaudacao = input.papel === 'patrimonio' ? 'Equipe Patrimônio' : input.nomeSolicitante

  const bodyHtml = `
<p style="margin: 0 0 4px 0; font-size: 15px;">Olá, <strong>${escapeHtml(nomeSaudacao)}</strong>.</p>
<p style="margin: 0 0 4px 0;">${escapeHtml(fraseAbertura)}</p>
${renderSummaryTable(linhasResumo)}
${input.motivo ? `<p style="margin: 16px 0 0 0;"><strong>Motivo do cancelamento:</strong> ${escapeHtml(input.motivo)}</p>` : ''}
${input.observacoes ? `<p style="margin: 8px 0 0 0;"><strong>Observações:</strong> ${escapeHtml(input.observacoes)}</p>` : ''}
${renderItemList('Itens patrimoniais', montarItensPatrimonio(input.itensPatrimonio))}
${renderItemList('Papelaria', montarItensPapelaria(input.itensPapelaria))}
${renderItemList('Serviços', montarItensServico(input.itensServico))}
${renderButton({ href: input.link, label: 'VER SOLICITAÇÃO' })}
`.trim()

  const html = renderEmailLayout({
    title: subject,
    bodyHtml,
    testOriginalRecipient: input.bannerDestinatarioOriginal,
  })

  const blocosTexto = [
    `Olá, ${nomeSaudacao}.`,
    '',
    fraseAbertura,
    '',
    linhasResumo.map((linha) => `${linha.label}: ${linha.value}`).join('\n'),
    input.motivo ? `\nMotivo do cancelamento: ${input.motivo}` : '',
    input.observacoes ? `\nObservações: ${input.observacoes}` : '',
    blocoTextoLista('Itens patrimoniais', montarTextoItensPatrimonio(input.itensPatrimonio)),
    blocoTextoLista('Papelaria', montarTextoItensPapelaria(input.itensPapelaria)),
    blocoTextoLista('Serviços', montarTextoItensServico(input.itensServico)),
    `Ver solicitação: ${input.link}`,
  ].filter((bloco) => bloco !== '')

  const textBody = blocosTexto.join('\n\n')
  const text = renderEmailLayoutText(textBody, input.bannerDestinatarioOriginal)

  return { subject, html, text }
}
