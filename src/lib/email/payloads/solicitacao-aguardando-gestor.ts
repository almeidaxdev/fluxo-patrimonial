// src/lib/email/payloads/solicitacao-aguardando-gestor.ts
//
// Etapa email-gestor-pendente — fonte única e histórica do conteúdo de
// SOLICITACAO_AGUARDANDO_GESTOR, seguindo EXATAMENTE o padrão já
// estabelecido por RESERVA_CONFIRMADA (ver
// src/lib/email/payloads/reserva-confirmada.ts): o dispatcher, ao
// recuperar um evento abandonado, nunca deve reconstruir o e-mail lendo o
// estado ATUAL da Solicitacao/User — o conteúdo é congelado em
// EmailEvento.payload no momento da criação do evento (dentro da mesma
// transação que persiste a solicitação).
//
// Este arquivo contém só funções puras (sem Prisma, sem I/O):
// - construirPayloadSolicitacaoAguardandoGestor(): dados já lidos pelo
//   chamador (dentro da transação de criação) → snapshot congelado
//   (SolicitacaoAguardandoGestorPayloadV1);
// - parseSolicitacaoAguardandoGestorPayload(): valida um `unknown` (o que
//   EmailEvento.payload devolve em runtime) e só retorna um payload de
//   verdade se cada campo bater com o formato esperado — nunca um cast
//   cego;
// - renderSolicitacaoAguardandoGestorFromPayload(): payload JÁ VALIDADO +
//   link (calculado no momento do envio, nunca guardado no snapshot) →
//   RenderedEmail, delegando inteiramente para o template existente.
//
// Diferente de RESERVA_CONFIRMADA, este evento TEM uma regra de validade
// (aindaValido — ver src/lib/email/validade-evento.ts): o payload resolve
// "o que renderizar", nunca "se ainda deve ser enviado" — essa segunda
// pergunta é decidida por uma releitura ENXUTA do status atual da
// Solicitacao, sempre depois do claim (PENDENTE → PROCESSANDO), nunca a
// partir deste payload.

import type { PeriodoSolicitacao, TipoDominio } from '@/types'
import { renderSolicitacaoAguardandoGestorEmail } from '../templates/solicitacao-aguardando-gestor'
import type {
  ItemPatrimonioResumo,
  ItemPapelariaResumo,
  ItemServicoResumo,
} from '../templates/solicitacao-aguardando-gestor'
import type { RenderedEmail } from '../processar-evento'

export interface SolicitacaoAguardandoGestorPayloadV1 {
  versao: 1

  numero: number
  nomeGestor: string
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

export class SolicitacaoAguardandoGestorPayloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SolicitacaoAguardandoGestorPayloadError'
  }
}

/** Dados que o chamador (rota de criação, dentro da transação) já tem em mãos para montar o snapshot. */
export interface ConstruirPayloadSolicitacaoAguardandoGestorInput {
  numero: number
  nomeGestor: string
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
 * Congela `input` num SolicitacaoAguardandoGestorPayloadV1. Função pura —
 * sem Prisma, sem I/O. Cada array do resultado é NOVO (via `.map()`, nunca
 * a referência original).
 */
export function construirPayloadSolicitacaoAguardandoGestor(
  input: ConstruirPayloadSolicitacaoAguardandoGestorInput
): SolicitacaoAguardandoGestorPayloadV1 {
  return {
    versao: 1,
    numero: input.numero,
    nomeGestor: input.nomeGestor,
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
  throw new SolicitacaoAguardandoGestorPayloadError(`Snapshot histórico de SOLICITACAO_AGUARDANDO_GESTOR inválido: campo "${campo}" ausente ou malformado.`)
}

/**
 * Valida um `unknown` (o que `EmailEvento.payload` devolve em runtime) e
 * só retorna um SolicitacaoAguardandoGestorPayloadV1 de verdade se TODOS
 * os campos baterem com o formato esperado. Nunca um `as ...` sem
 * validação, nunca fallback silencioso para dados vivos.
 */
export function parseSolicitacaoAguardandoGestorPayload(value: unknown): SolicitacaoAguardandoGestorPayloadV1 {
  if (!isObjeto(value)) {
    throw new SolicitacaoAguardandoGestorPayloadError('Snapshot histórico de SOLICITACAO_AGUARDANDO_GESTOR ausente ou em formato inesperado.')
  }

  if (value.versao !== 1) {
    throw new SolicitacaoAguardandoGestorPayloadError('Snapshot histórico de SOLICITACAO_AGUARDANDO_GESTOR com versão não suportada.')
  }

  if (typeof value.numero !== 'number' || !Number.isFinite(value.numero)) erroPayload('numero')
  if (!isString(value.nomeGestor) || value.nomeGestor.length === 0) erroPayload('nomeGestor')
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
    numero: value.numero,
    nomeGestor: value.nomeGestor,
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
 * Renderiza SOLICITACAO_AGUARDANDO_GESTOR a partir de um payload JÁ
 * VALIDADO — `link` continua vindo de fora, calculado no momento do envio
 * (nunca congelado no snapshot). Delega inteiramente ao template
 * existente; nenhum HTML/assunto duplicado aqui.
 */
export function renderSolicitacaoAguardandoGestorFromPayload(
  payload: SolicitacaoAguardandoGestorPayloadV1,
  link: string,
  bannerDestinatarioOriginal: string | null = null
): RenderedEmail {
  return renderSolicitacaoAguardandoGestorEmail({
    numero: payload.numero,
    nomeGestor: payload.nomeGestor,
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
