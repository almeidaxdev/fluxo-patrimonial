// src/lib/email/payloads/cancelamento.ts
//
// Etapa email-cancelamento — fonte única e histórica do conteúdo de
// CANCELAMENTO. Um payload por DESTINATÁRIO (mesmo padrão de
// ReservaConfirmadaPayloadV1) — `papel` já congelado em cada snapshot, já
// que o solicitante e a equipe Patrimônio podem receber conteúdos
// ligeiramente diferentes (ver templates/cancelamento.ts).
//
// Validade/obsolescência: DELIBERADAMENTE ausente de STATUS_ESPERADO_POR_TIPO
// (validade-evento.ts) — CANCELADA é status TERMINAL de verdade:
// `TRANSICOES_PERMITIDAS['CANCELADA']` (src/lib/status.ts) é um array
// VAZIO — nenhuma transição sai desse status, nunca. Mesmo raciocínio já
// aplicado a REJEICAO_GESTOR/REJEICAO_PATRIMONIO (ver payloads/rejeicao.ts).
//
// Motivo (achado da investigação desta etapa): a rota /cancelar NÃO recebe
// nem persiste motivo hoje (nenhum campo `motivoCancelamento` existe no
// schema, o handler nem lê o corpo da requisição) — `motivo` aqui é
// portanto SEMPRE `null` neste momento, nunca um valor inventado. O
// template (ver templates/cancelamento.ts) omite a linha "Motivo do
// cancelamento" quando `null`, exatamente como pedido: não transformar um
// campo hoje opcional/ausente em obrigatório.
//
// Este arquivo contém só funções puras (sem Prisma, sem I/O) — mesmo trio
// de RESERVA_CONFIRMADA/SOLICITACAO_AGUARDANDO_GESTOR/ASSINATURA_PENDENTE/REJEICAO_*.

import type { PeriodoSolicitacao, TipoEmprestimo, TipoDominio } from '@/types'
import { renderCancelamentoEmail } from '../templates/cancelamento'
import type {
  PapelDestinatario,
  ItemPatrimonioResumo,
  ItemPapelariaResumo,
  ItemServicoResumo,
} from '../templates/cancelamento'
import type { RenderedEmail } from '../processar-evento'

export interface CancelamentoPayloadV1 {
  versao: 1
  papel: PapelDestinatario

  numero: number
  nomeSolicitante: string
  tipoEmprestimo: TipoEmprestimo

  /** ISO 8601 — nunca um `Date` dentro do JSON. */
  dataIso: string
  periodos: string[]

  ambiente: string | null
  finalidade: string | null
  atividadeExterna: string | null
  local: string | null
  cidade: string | null
  observacoes: string | null

  itensPatrimonio: Array<{ numero: string; marca: string; modelo: string; categoria?: string }>
  itensPapelaria: Array<{ descricao: string; quantidade: number }>
  itensServico: Array<{ tipoServicoNome: string; quantidade: number | null; ambiente: string | null }>

  notebooksComDominio: boolean | null
  tipoDominio: TipoDominio | null

  /** Nome de quem executou o cancelamento (session.nome) — sempre disponível. */
  canceladoPorNome: string
  /**
   * Snapshot do motivo NO MOMENTO do cancelamento. Sempre `null` hoje — a
   * rota /cancelar não recebe/persiste motivo (ver comentário no topo do
   * arquivo). Campo mantido nullable de propósito, para o dia em que a
   * rota passar a coletar motivo sem exigir uma nova versão de payload.
   */
  motivo: string | null
}

export class CancelamentoPayloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CancelamentoPayloadError'
  }
}

/** Dados que o chamador (rota /cancelar, dentro da transação) já tem em mãos. */
export interface ConstruirPayloadCancelamentoInput {
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
  canceladoPorNome: string
  motivo: string | null
}

/**
 * Congela `input` (mais o `papel` já resolvido pelo chamador — 'solicitante'
 * ou 'patrimonio', um payload por destinatário) num CancelamentoPayloadV1.
 * Função pura — sem Prisma, sem I/O.
 */
export function construirPayloadCancelamento(input: ConstruirPayloadCancelamentoInput, papel: PapelDestinatario): CancelamentoPayloadV1 {
  return {
    versao: 1,
    papel,
    numero: input.numero,
    nomeSolicitante: input.nomeSolicitante,
    tipoEmprestimo: input.tipoEmprestimo,
    dataIso: input.data.toISOString(),
    periodos: input.periodos.map((periodo) => String(periodo)),
    ambiente: input.ambiente,
    finalidade: input.finalidade,
    atividadeExterna: input.atividadeExterna,
    local: input.local,
    cidade: input.cidade,
    observacoes: input.observacoes,
    itensPatrimonio: input.itensPatrimonio.map((item) => ({
      numero: item.numero,
      marca: item.marca,
      modelo: item.modelo,
      categoria: item.categoria,
    })),
    itensPapelaria: input.itensPapelaria.map((item) => ({ descricao: item.descricao, quantidade: item.quantidade })),
    itensServico: input.itensServico.map((item) => ({
      tipoServicoNome: item.tipoServicoNome,
      quantidade: item.quantidade,
      ambiente: item.ambiente,
    })),
    notebooksComDominio: input.notebooksComDominio,
    tipoDominio: input.tipoDominio,
    canceladoPorNome: input.canceladoPorNome,
    motivo: input.motivo,
  }
}

const PAPEIS_VALIDOS: readonly string[] = ['solicitante', 'patrimonio']
const TIPOS_EMPRESTIMO_VALIDOS: readonly string[] = ['interno', 'externo']
const PERIODOS_VALIDOS: readonly string[] = ['MANHA', 'TARDE', 'NOITE']
const TIPOS_DOMINIO_VALIDOS: readonly string[] = ['EDUCACIONAL', 'ADMINISTRATIVO']

function isObjeto(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isStringOuNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isIsoDateValida(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value))
}

function erroPayload(campo: string): never {
  throw new CancelamentoPayloadError(`Snapshot histórico de cancelamento inválido: campo "${campo}" ausente ou malformado.`)
}

/**
 * Valida um `unknown` (o que `EmailEvento.payload` devolve em runtime) e só
 * retorna um CancelamentoPayloadV1 de verdade se TODOS os campos baterem
 * com o formato esperado. Nunca um `as ...` sem validação, nunca fallback
 * silencioso para dados vivos.
 */
export function parseCancelamentoPayload(value: unknown): CancelamentoPayloadV1 {
  if (!isObjeto(value)) {
    throw new CancelamentoPayloadError('Snapshot histórico de cancelamento ausente ou em formato inesperado.')
  }

  if (value.versao !== 1) {
    throw new CancelamentoPayloadError('Snapshot histórico de cancelamento com versão não suportada.')
  }

  if (typeof value.papel !== 'string' || !PAPEIS_VALIDOS.includes(value.papel)) erroPayload('papel')
  if (typeof value.numero !== 'number' || !Number.isFinite(value.numero)) erroPayload('numero')
  if (!isString(value.nomeSolicitante) || value.nomeSolicitante.length === 0) erroPayload('nomeSolicitante')
  if (typeof value.tipoEmprestimo !== 'string' || !TIPOS_EMPRESTIMO_VALIDOS.includes(value.tipoEmprestimo)) erroPayload('tipoEmprestimo')
  if (!isIsoDateValida(value.dataIso)) erroPayload('dataIso')
  if (!Array.isArray(value.periodos) || !value.periodos.every((p) => typeof p === 'string' && PERIODOS_VALIDOS.includes(p))) erroPayload('periodos')
  if (!isStringOuNull(value.ambiente)) erroPayload('ambiente')
  if (!isStringOuNull(value.finalidade)) erroPayload('finalidade')
  if (!isStringOuNull(value.atividadeExterna)) erroPayload('atividadeExterna')
  if (!isStringOuNull(value.local)) erroPayload('local')
  if (!isStringOuNull(value.cidade)) erroPayload('cidade')
  if (!isStringOuNull(value.observacoes)) erroPayload('observacoes')
  if (!isString(value.canceladoPorNome) || value.canceladoPorNome.length === 0) erroPayload('canceladoPorNome')
  if (!isStringOuNull(value.motivo)) erroPayload('motivo')

  if (!Array.isArray(value.itensPatrimonio)) erroPayload('itensPatrimonio')
  const itensPatrimonio = (value.itensPatrimonio as unknown[]).map((item) => {
    if (!isObjeto(item) || !isString(item.numero) || !isString(item.marca) || !isString(item.modelo)) erroPayload('itensPatrimonio[]')
    if (item.categoria !== undefined && !isString(item.categoria)) erroPayload('itensPatrimonio[].categoria')
    return { numero: item.numero as string, marca: item.marca as string, modelo: item.modelo as string, categoria: item.categoria as string | undefined }
  })

  if (!Array.isArray(value.itensPapelaria)) erroPayload('itensPapelaria')
  const itensPapelaria = (value.itensPapelaria as unknown[]).map((item) => {
    if (!isObjeto(item) || !isString(item.descricao) || typeof item.quantidade !== 'number') erroPayload('itensPapelaria[]')
    return { descricao: item.descricao as string, quantidade: item.quantidade as number }
  })

  if (!Array.isArray(value.itensServico)) erroPayload('itensServico')
  const itensServico = (value.itensServico as unknown[]).map((item) => {
    if (
      !isObjeto(item) ||
      !isString(item.tipoServicoNome) ||
      (item.quantidade !== null && typeof item.quantidade !== 'number') ||
      (item.ambiente !== null && typeof item.ambiente !== 'string')
    ) {
      erroPayload('itensServico[]')
    }
    return {
      tipoServicoNome: item.tipoServicoNome as string,
      quantidade: item.quantidade as number | null,
      ambiente: item.ambiente as string | null,
    }
  })

  const notebooksComDominio = value.notebooksComDominio === undefined ? null : value.notebooksComDominio
  if (notebooksComDominio !== null && typeof notebooksComDominio !== 'boolean') erroPayload('notebooksComDominio')

  const tipoDominio = value.tipoDominio === undefined ? null : value.tipoDominio
  if (tipoDominio !== null && (typeof tipoDominio !== 'string' || !TIPOS_DOMINIO_VALIDOS.includes(tipoDominio))) erroPayload('tipoDominio')

  return {
    versao: 1,
    papel: value.papel as PapelDestinatario,
    numero: value.numero,
    nomeSolicitante: value.nomeSolicitante,
    tipoEmprestimo: value.tipoEmprestimo as TipoEmprestimo,
    dataIso: value.dataIso as string,
    periodos: value.periodos as string[],
    ambiente: value.ambiente as string | null,
    finalidade: value.finalidade as string | null,
    atividadeExterna: value.atividadeExterna as string | null,
    local: value.local as string | null,
    cidade: value.cidade as string | null,
    observacoes: value.observacoes as string | null,
    itensPatrimonio,
    itensPapelaria,
    itensServico,
    notebooksComDominio: notebooksComDominio as boolean | null,
    tipoDominio: tipoDominio as TipoDominio | null,
    canceladoPorNome: value.canceladoPorNome,
    motivo: value.motivo as string | null,
  }
}

/**
 * Renderiza CANCELAMENTO a partir de um payload JÁ VALIDADO — `link`
 * continua vindo de fora, calculado no momento do envio. O `papel` já
 * congelado no payload decide a frase de abertura/resumo dentro do
 * template — nenhuma lógica de qual-destinatário-é-este duplicada aqui.
 */
export function renderCancelamentoFromPayload(
  payload: CancelamentoPayloadV1,
  link: string,
  bannerDestinatarioOriginal: string | null = null
): RenderedEmail {
  return renderCancelamentoEmail({
    papel: payload.papel,
    numero: payload.numero,
    nomeSolicitante: payload.nomeSolicitante,
    tipoEmprestimo: payload.tipoEmprestimo,
    data: new Date(payload.dataIso),
    periodos: payload.periodos as PeriodoSolicitacao[],
    ambiente: payload.ambiente,
    finalidade: payload.finalidade,
    atividadeExterna: payload.atividadeExterna,
    local: payload.local,
    cidade: payload.cidade,
    observacoes: payload.observacoes,
    itensPatrimonio: payload.itensPatrimonio,
    itensPapelaria: payload.itensPapelaria,
    itensServico: payload.itensServico,
    notebooksComDominio: payload.notebooksComDominio,
    tipoDominio: payload.tipoDominio,
    canceladoPorNome: payload.canceladoPorNome,
    motivo: payload.motivo,
    link,
    bannerDestinatarioOriginal,
  })
}
