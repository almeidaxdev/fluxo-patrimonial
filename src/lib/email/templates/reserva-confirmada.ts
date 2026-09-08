// src/lib/email/templates/reserva-confirmada.ts
// Etapa D.3.2 — template do evento RESERVA_CONFIRMADA. Monta apenas
// subject/html/text; destinatário físico, provedor e persistência do
// EmailEvento são responsabilidade de src/lib/email/processar-evento.ts.
// Este arquivo NÃO está ligado a nenhuma rota nem ao dispatcher ainda —
// ver src/lib/email/validade-evento.ts (TIPOS_EMAIL_SUPORTADOS) e as
// rotas /confirmar-patrimonio e /assinatura/confirmar, inalteradas nesta
// rodada.
//
// Dois públicos, um único builder (evita duplicar o template inteiro — ver
// PapelDestinatario abaixo): SOLICITANTE recebe uma versão endereçada a si;
// PATRIMONIO recebe uma versão identificando o solicitante logo no
// assunto, com o MESMO conteúdo operacional (nenhum campo extra ou a menos
// entre os dois — ver ReservaConfirmadaTemplateInput, que já não inclui
// nenhum dado de auditoria interna como IDs ou usuário que executou a
// transição, então "completo o bastante para reencaminhar ao DIG" e "sem
// detalhes de auditoria ao solicitante" são satisfeitos ao mesmo tempo).
//
// Semântica temporal (mesmo princípio de PRONTA_RETIRADA/NAO_RETIRADA):
// este e-mail é um REGISTRO de que a confirmação ocorreu, não uma garantia
// do estado atual — "foi confirmada", nunca "está confirmada". Continua
// verdadeiro mesmo que a solicitação seja cancelada ou avance de status
// depois do envio.
import { formatDataCivil, formatDateTime, formatPeriodos } from '@/utils'
import type { PeriodoSolicitacao, TipoEmprestimo, TipoDominio } from '@/types'
import { TIPO_DOMINIO_LABELS } from '@/types'
import { escapeHtml } from '../html'
import { renderEmailLayout, renderEmailLayoutText } from './layout'
import { renderButton, renderSummaryTable, renderItemList, type SummaryRowInput, type ListItemInput } from './components'
import type { RenderedEmail } from '../processar-evento'

export type PapelDestinatario = 'solicitante' | 'patrimonio'

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

export interface ReservaConfirmadaTemplateInput {
  papel: PapelDestinatario
  tipoEmprestimo: TipoEmprestimo
  numero: number
  nomeSolicitante: string
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
  /** Etapa domain-flow — null quando não há notebook na solicitação. */
  notebooksComDominio: boolean | null
  /** Só relevante quando notebooksComDominio = true. */
  tipoDominio: TipoDominio | null
  /** Só relevante para tipoEmprestimo === 'externo'; ignorado para interno. */
  assinaturaConfirmadaEm: Date | null
  link: string
  /** Repassado direto de BuildEmailContext — ver processar-evento.ts. */
  bannerDestinatarioOriginal: string | null
}

function montarAssunto(input: ReservaConfirmadaTemplateInput): string {
  if (input.papel === 'patrimonio') {
    return `[Fluxo Patrimonial] Reserva confirmada — #${input.numero} — ${input.nomeSolicitante}`
  }
  return `[Fluxo Patrimonial] Sua reserva foi confirmada — #${input.numero}`
}

/**
 * Frase de abertura (evento ocorrido, nunca estado atual — ver comentário
 * no topo do arquivo). Retorna texto RAW (não escapado) — o chamador
 * decide se escapa (HTML) ou usa direto (texto puro).
 */
function montarFraseAbertura(input: ReservaConfirmadaTemplateInput): string {
  const externo = input.tipoEmprestimo === 'externo'
  if (input.papel === 'patrimonio') {
    return externo
      ? `A reserva externa de ${input.nomeSolicitante} foi confirmada após a conclusão da etapa de assinatura.`
      : `A reserva de ${input.nomeSolicitante} foi confirmada.`
  }
  return externo
    ? 'Sua reserva foi confirmada após a conclusão da etapa de assinatura.'
    : 'Sua reserva foi confirmada pelo Patrimônio.'
}

function montarLinhasResumo(input: ReservaConfirmadaTemplateInput): SummaryRowInput[] {
  const linhas: SummaryRowInput[] = [
    { label: 'Solicitação', value: `#${input.numero}` },
    { label: 'Solicitante', value: input.nomeSolicitante },
    { label: 'Tipo', value: input.tipoEmprestimo === 'externo' ? 'Externa' : 'Interna' },
    // input.data é a DATA CIVIL da reserva (Solicitacao.data, @db.Date) —
    // formatDataCivil(), não formatDate() (ver Etapa D.3.FOLLOW-UP:
    // formatDate() usa getters locais de Date, sensíveis ao timezone do
    // processo/navegador). input.assinaturaConfirmadaEm logo abaixo
    // CONTINUA em formatDateTime(): é um instante real (Assinatura.
    // confirmadaEm), correto exibir em horário local/Brasília.
    { label: 'Data', value: formatDataCivil(input.data) },
    { label: 'Período', value: formatPeriodos(input.periodos) },
  ]

  if (input.ambiente) linhas.push({ label: 'Ambiente', value: input.ambiente })
  if (input.finalidade) linhas.push({ label: 'Finalidade', value: input.finalidade })
  if (input.atividadeExterna) linhas.push({ label: 'Atividade', value: input.atividadeExterna })
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
  if (input.tipoEmprestimo === 'externo' && input.assinaturaConfirmadaEm) {
    linhas.push({ label: 'Assinatura confirmada em', value: formatDateTime(input.assinaturaConfirmadaEm) })
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

// --- Texto puro -------------------------------------------------------

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

export function renderReservaConfirmadaEmail(input: ReservaConfirmadaTemplateInput): RenderedEmail {
  const subject = montarAssunto(input)
  const fraseAbertura = montarFraseAbertura(input)
  const linhasResumo = montarLinhasResumo(input)
  const nomeSaudacao = input.papel === 'patrimonio' ? 'Equipe Patrimônio' : input.nomeSolicitante
  const saudacao = `Olá, ${nomeSaudacao}.`

  const bodyHtml = `
<p style="margin: 0 0 4px 0; font-size: 15px;">Olá, <strong>${escapeHtml(nomeSaudacao)}</strong>.</p>
<p style="margin: 0 0 4px 0;">${escapeHtml(fraseAbertura)}</p>
${renderSummaryTable(linhasResumo)}
${input.observacoes ? `<p style="margin: 16px 0 0 0;"><strong>Observações:</strong> ${escapeHtml(input.observacoes)}</p>` : ''}
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
    saudacao,
    '',
    fraseAbertura,
    '',
    linhasResumo.map((linha) => `${linha.label}: ${linha.value}`).join('\n'),
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
