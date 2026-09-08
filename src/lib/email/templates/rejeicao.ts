// src/lib/email/templates/rejeicao.ts
// Etapa email-rejeicoes — template ÚNICO para REJEICAO_GESTOR e
// REJEICAO_PATRIMONIO, seguindo o mesmo princípio de
// templates/reserva-confirmada.ts (um conteúdo, `papel` decide a frase de
// abertura/assunto) — os dois eventos compartilham exatamente a mesma
// estrutura de dados, só muda QUEM rejeitou.
//
// Único destinatário: o solicitante (nunca gestor, Patrimônio ou
// administradores — ver rotas /rejeitar-gestor e /rejeitar-patrimonio).
import { formatDataCivil, formatPeriodos } from '@/utils'
import type { PeriodoSolicitacao, TipoEmprestimo, TipoDominio } from '@/types'
import { TIPO_DOMINIO_LABELS } from '@/types'
import { escapeHtml } from '../html'
import { renderEmailLayout, renderEmailLayoutText } from './layout'
import { renderButton, renderSummaryTable, renderItemList, type SummaryRowInput, type ListItemInput } from './components'
import type { RenderedEmail } from '../processar-evento'

export type PapelRejeicao = 'gestor' | 'patrimonio'

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

export interface RejeicaoTemplateInput {
  papel: PapelRejeicao
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
  /** Sempre presente — rejeitarSchema exige min(3) no momento da rejeição. */
  motivo: string
  link: string
  /** Repassado direto de BuildEmailContext — ver processar-evento.ts. */
  bannerDestinatarioOriginal: string | null
}

function montarAssunto(input: RejeicaoTemplateInput): string {
  return input.papel === 'gestor'
    ? `[Fluxo Patrimonial] Solicitação rejeitada pelo gestor — #${input.numero}`
    : `[Fluxo Patrimonial] Solicitação rejeitada pelo Patrimônio — #${input.numero}`
}

function montarFraseAbertura(input: RejeicaoTemplateInput): string {
  return input.papel === 'gestor'
    ? 'Sua solicitação externa foi analisada pelo gestor responsável e não foi aprovada.'
    : 'Sua solicitação foi analisada pelo Patrimônio e não foi aprovada.'
}

function montarLinhasResumo(input: RejeicaoTemplateInput): SummaryRowInput[] {
  const linhas: SummaryRowInput[] = [
    { label: 'Solicitação', value: `#${input.numero}` },
    // input.data é a DATA CIVIL da reserva (Solicitacao.data, @db.Date) —
    // formatDataCivil(), nunca formatDate() (ver Etapa D.3.FOLLOW-UP).
    { label: 'Data', value: formatDataCivil(input.data) },
    { label: 'Período', value: formatPeriodos(input.periodos) },
  ]

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

export function renderRejeicaoEmail(input: RejeicaoTemplateInput): RenderedEmail {
  const subject = montarAssunto(input)
  const fraseAbertura = montarFraseAbertura(input)
  const linhasResumo = montarLinhasResumo(input)

  const bodyHtml = `
<p style="margin: 0 0 4px 0; font-size: 15px;">Olá, <strong>${escapeHtml(input.nomeSolicitante)}</strong>.</p>
<p style="margin: 0 0 4px 0;">${escapeHtml(fraseAbertura)}</p>
${renderSummaryTable(linhasResumo)}
<p style="margin: 16px 0 0 0;"><strong>Motivo da rejeição:</strong> ${escapeHtml(input.motivo)}</p>
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
    `Olá, ${input.nomeSolicitante}.`,
    '',
    fraseAbertura,
    '',
    linhasResumo.map((linha) => `${linha.label}: ${linha.value}`).join('\n'),
    `\nMotivo da rejeição: ${input.motivo}`,
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
