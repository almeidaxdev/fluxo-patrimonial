// src/lib/email/templates/solicitacao-aguardando-patrimonio.ts
// Etapa email-aguardando-patrimonio — template do evento
// SOLICITACAO_AGUARDANDO_PATRIMONIO. Monta apenas subject/html/text;
// destinatário físico, provedor e persistência do EmailEvento são
// responsabilidade de src/lib/email/processar-evento.ts.
//
// Destinatários: toda a equipe Patrimônio ativa (permissao='patrimonio')
// — nunca o solicitante, nunca o gestor, nunca administradores sem essa
// permissão (ver POST /api/solicitacoes/[id]/aprovar-gestor, onde este
// evento é criado). Conteúdo IDÊNTICO para todos os destinatários — não há
// `papel` que diferencie um Patrimônio do outro, então um único payload
// serve para todos os EmailEvento desta solicitação (mesmo princípio de
// SOLICITACAO_AGUARDANDO_GESTOR, que também não tem `papel`).
//
// Etapa email-patrimonio-solicitacao-interna: este mesmo template agora
// atende os DOIS fluxos — `tipoEmprestimo` discrimina a frase de abertura e
// a linha "Gestor responsável" (só existe em externo, após aprovação do
// gestor); `ambiente` só é preenchido em interno. Mesmo raciocínio de
// ReservaConfirmadaTemplateInput (ver templates/reserva-confirmada.ts), que
// já resolve esse mesmo par de campos mutuamente exclusivos para outro
// evento usado pelos dois fluxos.
//
// Semântica temporal: notificação de que HÁ uma solicitação aguardando
// análise, não uma garantia de que ela CONTINUA aguardando no instante em
// que o e-mail é lido (aindaValido, ver validade-evento.ts, cobre a
// obsolescência antes do ENVIO). O CTA leva para dentro do sistema, onde o
// estado real e as ações de confirmar/rejeitar sempre refletem a situação
// atual — nenhum token de aprovação viaja no e-mail.
import { formatDataCivil, formatPeriodos } from '@/utils'
import type { PeriodoSolicitacao, TipoDominio, TipoEmprestimo } from '@/types'
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

export interface SolicitacaoAguardandoPatrimonioTemplateInput {
  numero: number
  nomeSolicitante: string
  /** Gestor que aprovou (session.nome em /aprovar-gestor). `null` para solicitação interna — não existe gestor envolvido. */
  nomeGestorAprovador: string | null
  tipoEmprestimo: TipoEmprestimo
  data: Date
  periodos: PeriodoSolicitacao[]
  /** Só preenchido para tipoEmprestimo='interno'. */
  ambiente: string | null
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

/**
 * Frase de abertura (Etapa email-patrimonio-solicitacao-interna). Retorna
 * texto RAW (não escapado) — o chamador decide se escapa (HTML) ou usa
 * direto (texto puro). Mesmo padrão de montarFraseAbertura() em
 * templates/reserva-confirmada.ts.
 */
function montarFraseAbertura(input: SolicitacaoAguardandoPatrimonioTemplateInput): string {
  return input.tipoEmprestimo === 'interno'
    ? 'Uma nova solicitação está aguardando análise do Patrimônio.'
    : 'Uma solicitação externa foi aprovada pelo gestor responsável e agora aguarda análise do Patrimônio.'
}

function montarLinhasResumo(input: SolicitacaoAguardandoPatrimonioTemplateInput): SummaryRowInput[] {
  const linhas: SummaryRowInput[] = [
    { label: 'Solicitação', value: `#${input.numero}` },
    { label: 'Solicitante', value: input.nomeSolicitante },
  ]

  // 'Gestor responsável' só existe no fluxo externo (após aprovação do
  // gestor) — nomeGestorAprovador é `null` para interna, então esta linha
  // nunca aparece nesse caso.
  if (input.nomeGestorAprovador) linhas.push({ label: 'Gestor responsável', value: input.nomeGestorAprovador })

  // input.data é a DATA CIVIL da reserva (Solicitacao.data, @db.Date) —
  // formatDataCivil(), nunca formatDate() (ver Etapa D.3.FOLLOW-UP).
  linhas.push({ label: 'Data', value: formatDataCivil(input.data) })
  linhas.push({ label: 'Período', value: formatPeriodos(input.periodos) })

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

export function renderSolicitacaoAguardandoPatrimonioEmail(input: SolicitacaoAguardandoPatrimonioTemplateInput): RenderedEmail {
  const subject = `[Fluxo Patrimonial] Solicitação aguardando análise — #${input.numero}`
  const linhasResumo = montarLinhasResumo(input)
  const fraseAbertura = montarFraseAbertura(input)

  const bodyHtml = `
<p style="margin: 0 0 4px 0; font-size: 15px;">Olá, <strong>Equipe Patrimônio</strong>.</p>
<p style="margin: 0 0 4px 0;">${escapeHtml(fraseAbertura)}</p>
${renderSummaryTable(linhasResumo)}
${input.observacoes ? `<p style="margin: 16px 0 0 0;"><strong>Observações:</strong> ${escapeHtml(input.observacoes)}</p>` : ''}
${renderItemList('Itens patrimoniais', montarItensPatrimonio(input.itensPatrimonio))}
${renderItemList('Papelaria', montarItensPapelaria(input.itensPapelaria))}
${renderItemList('Serviços', montarItensServico(input.itensServico))}
${renderButton({ href: input.link, label: 'ANALISAR SOLICITAÇÃO' })}
`.trim()

  const html = renderEmailLayout({
    title: subject,
    bodyHtml,
    testOriginalRecipient: input.bannerDestinatarioOriginal,
  })

  const blocosTexto = [
    'Olá, Equipe Patrimônio.',
    '',
    fraseAbertura,
    '',
    linhasResumo.map((linha) => `${linha.label}: ${linha.value}`).join('\n'),
    input.observacoes ? `\nObservações: ${input.observacoes}` : '',
    blocoTextoLista('Itens patrimoniais', montarTextoItensPatrimonio(input.itensPatrimonio)),
    blocoTextoLista('Papelaria', montarTextoItensPapelaria(input.itensPapelaria)),
    blocoTextoLista('Serviços', montarTextoItensServico(input.itensServico)),
    `Analisar solicitação: ${input.link}`,
  ].filter((bloco) => bloco !== '')

  const textBody = blocosTexto.join('\n\n')
  const text = renderEmailLayoutText(textBody, input.bannerDestinatarioOriginal)

  return { subject, html, text }
}
