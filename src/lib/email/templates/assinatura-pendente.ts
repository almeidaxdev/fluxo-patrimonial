// src/lib/email/templates/assinatura-pendente.ts
// Etapa email-assinatura-pendente — template do evento ASSINATURA_PENDENTE.
// Monta apenas subject/html/text; destinatário físico, provedor e
// persistência do EmailEvento são responsabilidade de
// src/lib/email/processar-evento.ts.
//
// Único destinatário: o solicitante da atividade externa (nunca gestor,
// Patrimônio ou administradores — ver POST .../assinatura). Exclusivo do
// fluxo EXTERNO — reserva interna nunca passa por AGUARDANDO_ASSINATURA.
//
// O CTA leva para dentro do sistema (/solicitacoes/{id}), NUNCA
// diretamente para Assinatura.link (a URL externa de assinatura, colada
// manualmente pelo Patrimônio) — mesmo padrão de todos os outros
// templates deste projeto. Dois motivos: (1) Assinatura.link pode ser
// reenviado/atualizado depois que este e-mail já foi entregue — um link
// congelado no e-mail poderia apontar para uma versão desatualizada,
// enquanto a página sempre mostra o link ATUAL; (2) exige autenticação
// antes de expor a URL externa, consistente com o resto do sistema. Na
// página, o solicitante já encontra o botão "Assinar agora" (para o link
// externo) e "Concluí a assinatura" — ver src/app/(dashboard)/solicitacoes/[id]/page.tsx.
import { formatDataCivil, formatPeriodos } from '@/utils'
import type { PeriodoSolicitacao, TipoDominio } from '@/types'
import { TIPO_DOMINIO_LABELS } from '@/types'
import { escapeHtml } from '../html'
import { renderEmailLayout, renderEmailLayoutText } from './layout'
import { renderButton, renderSummaryTable, renderItemList, type SummaryRowInput, type ListItemInput } from './components'
import type { RenderedEmail } from '../processar-evento'

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

export interface AssinaturaPendenteTemplateInput {
  numero: number
  nomeSolicitante: string
  data: Date
  periodos: PeriodoSolicitacao[]
  finalidade: string | null
  atividadeExterna: string | null
  local: string | null
  cidade: string | null
  observacoes: string | null
  itensPatrimonio: ItemPatrimonioResumo[]
  itensPapelaria: ItemPapelariaResumo[]
  itensServico: ItemServicoResumo[]
  /** `null` quando não há Notebook na solicitação — ver Etapa domain-flow. */
  notebooksComDominio: boolean | null
  tipoDominio: TipoDominio | null
  link: string
  /** Repassado direto de BuildEmailContext — ver processar-evento.ts. */
  bannerDestinatarioOriginal: string | null
}

function montarLinhasResumo(input: AssinaturaPendenteTemplateInput): SummaryRowInput[] {
  const linhas: SummaryRowInput[] = [
    { label: 'Solicitação', value: `#${input.numero}` },
    // input.data é a DATA CIVIL da reserva (Solicitacao.data, @db.Date) —
    // formatDataCivil(), nunca formatDate() (ver Etapa D.3.FOLLOW-UP).
    { label: 'Data', value: formatDataCivil(input.data) },
    { label: 'Período', value: formatPeriodos(input.periodos) },
  ]

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

export function renderAssinaturaPendenteEmail(input: AssinaturaPendenteTemplateInput): RenderedEmail {
  // Mesma convenção de assunto dos demais templates ([Fluxo Patrimonial] +
  // frase + número).
  const subject = `[Fluxo Patrimonial] Assinatura pendente — Reserva #${input.numero}`
  const linhasResumo = montarLinhasResumo(input)
  const aviso = 'A reserva somente seguirá para confirmação após a assinatura.'

  const bodyHtml = `
<p style="margin: 0 0 4px 0; font-size: 15px;">Olá, <strong>${escapeHtml(input.nomeSolicitante)}</strong>.</p>
<p style="margin: 0 0 4px 0;">Sua reserva externa está aguardando sua assinatura para continuar o processo.</p>
<p style="margin: 0 0 16px 0; font-size: 13px; color: #667085;">${escapeHtml(aviso)}</p>
${renderSummaryTable(linhasResumo)}
${input.observacoes ? `<p style="margin: 16px 0 0 0;"><strong>Observações:</strong> ${escapeHtml(input.observacoes)}</p>` : ''}
${renderItemList('Itens patrimoniais', montarItensPatrimonio(input.itensPatrimonio))}
${renderItemList('Papelaria', montarItensPapelaria(input.itensPapelaria))}
${renderItemList('Serviços', montarItensServico(input.itensServico))}
${renderButton({ href: input.link, label: 'REALIZAR ASSINATURA' })}
`.trim()

  const html = renderEmailLayout({
    title: subject,
    bodyHtml,
    testOriginalRecipient: input.bannerDestinatarioOriginal,
  })

  const blocosTexto = [
    `Olá, ${input.nomeSolicitante}.`,
    '',
    'Sua reserva externa está aguardando sua assinatura para continuar o processo.',
    '',
    aviso,
    '',
    linhasResumo.map((linha) => `${linha.label}: ${linha.value}`).join('\n'),
    input.observacoes ? `\nObservações: ${input.observacoes}` : '',
    blocoTextoLista('Itens patrimoniais', montarTextoItensPatrimonio(input.itensPatrimonio)),
    blocoTextoLista('Papelaria', montarTextoItensPapelaria(input.itensPapelaria)),
    blocoTextoLista('Serviços', montarTextoItensServico(input.itensServico)),
    `Realizar assinatura: ${input.link}`,
  ].filter((bloco) => bloco !== '')

  const textBody = blocosTexto.join('\n\n')
  const text = renderEmailLayoutText(textBody, input.bannerDestinatarioOriginal)

  return { subject, html, text }
}
