// src/lib/email/payloads/assinatura-pendente.ts
//
// Etapa email-assinatura-pendente — fonte única e histórica do conteúdo de
// ASSINATURA_PENDENTE, seguindo o mesmo padrão de RESERVA_CONFIRMADA e
// SOLICITACAO_AGUARDANDO_GESTOR: o dispatcher, ao recuperar um evento
// abandonado, nunca deve reconstruir o e-mail lendo o estado ATUAL da
// Solicitacao — o conteúdo é congelado em EmailEvento.payload no momento
// da criação do evento (dentro da mesma transação que persiste o envio do
// link de assinatura).
//
// Deliberadamente NÃO inclui Assinatura.link — o CTA aponta para
// /solicitacoes/{id} (ver templates/assinatura-pendente.ts), nunca para a
// URL externa de assinatura diretamente, então não há necessidade (nem
// seria seguro) congelar esse link no snapshot histórico.
//
// Este arquivo contém só funções puras (sem Prisma, sem I/O) — mesmo trio
// de RESERVA_CONFIRMADA/SOLICITACAO_AGUARDANDO_GESTOR: construir/parse/render.

import type { PeriodoSolicitacao, TipoDominio } from '@/types'
import { renderAssinaturaPendenteEmail } from '../templates/assinatura-pendente'
import type {
  ItemPatrimonioResumo,
  ItemPapelariaResumo,
  ItemServicoResumo,
} from '../templates/assinatura-pendente'
import type { RenderedEmail } from '../processar-evento'

export interface AssinaturaPendentePayloadV1 {
  versao: 1

  // Geração lógica do envio (Etapa fix/signature-resend — idempotência por
  // geração, não por tentativa técnica). Ver comentário completo em
  // idempotencyKeyParaEvento (processar-evento.ts). Resumo: incrementa
  // SOMENTE quando um reenvio explícito reabre um evento que já estava
  // ENVIADO (confirmado entregue) — nunca incrementa por um retry técnico
  // de FALHA/OBSOLETO (resultado ambíguo/nunca confirmado pelo provedor),
  // e nunca é tocado pelo claim (PENDENTE→PROCESSANDO), que é sobre
  // `tentativas`, um conceito DIFERENTE (ver assinatura/route.ts).
  // Opcional no tipo só para aceitar payloads históricos anteriores a esta
  // etapa no parser (ver parseAssinaturaPendentePayload) — todo payload
  // NOVO sempre grava um valor explícito (nunca omite o campo).
  geracao: number

  numero: number
  nomeSolicitante: string

  /** ISO 8601 — nunca um `Date` dentro do JSON. */
  dataIso: string
  periodos: string[]

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
}

export class AssinaturaPendentePayloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AssinaturaPendentePayloadError'
  }
}

/** Dados que o chamador (rota /assinatura, dentro da transação) já tem em mãos para montar o snapshot. */
export interface ConstruirPayloadAssinaturaPendenteInput {
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
  notebooksComDominio: boolean | null
  tipoDominio: TipoDominio | null
}

/**
 * Congela `input` num AssinaturaPendentePayloadV1. Função pura — sem
 * Prisma, sem I/O. Cada array do resultado é NOVO (via `.map()`, nunca a
 * referência original).
 *
 * `geracao` é um parâmetro SEPARADO de `input` (não faz parte dos dados da
 * Solicitação) — decidido pelo chamador (assinatura/route.ts, dentro do
 * Gate 2) com base no estado ANTERIOR do EmailEvento, nunca calculado
 * aqui.
 */
export function construirPayloadAssinaturaPendente(input: ConstruirPayloadAssinaturaPendenteInput, geracao: number): AssinaturaPendentePayloadV1 {
  return {
    versao: 1,
    geracao,
    numero: input.numero,
    nomeSolicitante: input.nomeSolicitante,
    dataIso: input.data.toISOString(),
    periodos: input.periodos.map((periodo) => String(periodo)),
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
  }
}

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
  throw new AssinaturaPendentePayloadError(`Snapshot histórico de ASSINATURA_PENDENTE inválido: campo "${campo}" ausente ou malformado.`)
}

/**
 * Valida um `unknown` (o que `EmailEvento.payload` devolve em runtime) e
 * só retorna um AssinaturaPendentePayloadV1 de verdade se TODOS os campos
 * baterem com o formato esperado. Nunca um `as ...` sem validação, nunca
 * fallback silencioso para dados vivos.
 */
export function parseAssinaturaPendentePayload(value: unknown): AssinaturaPendentePayloadV1 {
  if (!isObjeto(value)) {
    throw new AssinaturaPendentePayloadError('Snapshot histórico de ASSINATURA_PENDENTE ausente ou em formato inesperado.')
  }

  if (value.versao !== 1) {
    throw new AssinaturaPendentePayloadError('Snapshot histórico de ASSINATURA_PENDENTE com versão não suportada.')
  }

  // Compatibilidade histórica (Etapa fix/signature-resend): `geracao` não
  // existia antes desta etapa — payloads antigos nunca tiveram o campo.
  // Ausente → 1 (a geração inicial correta para um evento que, por
  // definição, nunca foi reaberto por um reenvio explícito antes de existir
  // o próprio conceito de geração). Presente, mas malformado (não é um
  // inteiro >= 1) → erro, igual a qualquer outro campo — nunca um fallback
  // silencioso para dado corrompido.
  const geracao = value.geracao === undefined ? 1 : value.geracao
  if (typeof geracao !== 'number' || !Number.isInteger(geracao) || geracao < 1) erroPayload('geracao')

  if (typeof value.numero !== 'number' || !Number.isFinite(value.numero)) erroPayload('numero')
  if (!isString(value.nomeSolicitante) || value.nomeSolicitante.length === 0) erroPayload('nomeSolicitante')
  if (!isIsoDateValida(value.dataIso)) erroPayload('dataIso')
  if (!Array.isArray(value.periodos) || !value.periodos.every((p) => typeof p === 'string' && PERIODOS_VALIDOS.includes(p))) erroPayload('periodos')
  if (!isStringOuNull(value.finalidade)) erroPayload('finalidade')
  if (!isStringOuNull(value.atividadeExterna)) erroPayload('atividadeExterna')
  if (!isStringOuNull(value.local)) erroPayload('local')
  if (!isStringOuNull(value.cidade)) erroPayload('cidade')
  if (!isStringOuNull(value.observacoes)) erroPayload('observacoes')

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
    geracao,
    numero: value.numero,
    nomeSolicitante: value.nomeSolicitante,
    dataIso: value.dataIso as string,
    periodos: value.periodos as string[],
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
  }
}

/**
 * Renderiza ASSINATURA_PENDENTE a partir de um payload JÁ VALIDADO —
 * `link` continua vindo de fora, calculado no momento do envio (sempre
 * `/solicitacoes/{id}`, nunca Assinatura.link — ver comentário no topo do
 * arquivo).
 */
export function renderAssinaturaPendenteFromPayload(
  payload: AssinaturaPendentePayloadV1,
  link: string,
  bannerDestinatarioOriginal: string | null = null
): RenderedEmail {
  return renderAssinaturaPendenteEmail({
    numero: payload.numero,
    nomeSolicitante: payload.nomeSolicitante,
    data: new Date(payload.dataIso),
    periodos: payload.periodos as PeriodoSolicitacao[],
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
    link,
    bannerDestinatarioOriginal,
  })
}
