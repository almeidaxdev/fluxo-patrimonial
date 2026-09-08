// src/lib/email/payloads/rejeicao.ts
//
// Etapa email-rejeicoes — fonte única e histórica do conteúdo de
// REJEICAO_GESTOR e REJEICAO_PATRIMONIO. Os dois tipos compartilham
// EXATAMENTE a mesma estrutura de payload (mesmo princípio de
// templates/rejeicao.ts) — só `papel` muda, e ele é congelado no próprio
// snapshot (mesmo padrão de ReservaConfirmadaPayloadV1.papel).
//
// Validade/obsolescência (item 16 do pedido): DELIBERADAMENTE ausente de
// STATUS_ESPERADO_POR_TIPO (validade-evento.ts) para os dois tipos —
// REJEITADA_GESTOR e REJEITADA_PATRIMONIO são estados TERMINAIS de
// verdade: `TRANSICOES_PERMITIDAS['REJEITADA_GESTOR']` e
// `TRANSICOES_PERMITIDAS['REJEITADA_PATRIMONIO']` (src/lib/status.ts) são
// arrays VAZIOS — nenhuma transição sai desses status, nunca. Diferente de
// PRONTA_RETIRADA/NAO_RETIRADA (que podem ser sucedidos por outra
// transição concorrente antes do envio), uma vez que a rejeição é
// persistida ela é definitiva por construção — não existe cenário em que
// "a condição que motivou o e-mail deixou de ser verdadeira depois". Não
// é uma omissão: é a mesma lógica de RESERVA_CONFIRMADA (registro
// histórico de algo que ocorreu), só que aqui com uma garantia ainda mais
// forte (impossibilidade estrutural, não só uma convenção de que "não
// muda mais o sentido").
//
// Este arquivo contém só funções puras (sem Prisma, sem I/O) — mesmo trio
// de RESERVA_CONFIRMADA/SOLICITACAO_AGUARDANDO_GESTOR/ASSINATURA_PENDENTE.

import type { PeriodoSolicitacao, TipoEmprestimo, TipoDominio } from '@/types'
import { renderRejeicaoEmail } from '../templates/rejeicao'
import type {
  PapelRejeicao,
  ItemPatrimonioResumo,
  ItemPapelariaResumo,
  ItemServicoResumo,
} from '../templates/rejeicao'
import type { RenderedEmail } from '../processar-evento'

export interface RejeicaoPayloadV1 {
  versao: 1
  papel: PapelRejeicao

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

  /** Snapshot do motivo NO MOMENTO da rejeição — nunca relido de Solicitacao.motivoRejeicao* depois. */
  motivo: string
}

export class RejeicaoPayloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RejeicaoPayloadError'
  }
}

/** Dados que o chamador (rota /rejeitar-gestor ou /rejeitar-patrimonio, dentro da transação) já tem em mãos. */
export interface ConstruirPayloadRejeicaoInput {
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
  motivo: string
}

/**
 * Congela `input` (mais o `papel` já resolvido pelo chamador — 'gestor'
 * para /rejeitar-gestor, 'patrimonio' para /rejeitar-patrimonio) num
 * RejeicaoPayloadV1. Função pura — sem Prisma, sem I/O.
 */
export function construirPayloadRejeicao(input: ConstruirPayloadRejeicaoInput, papel: PapelRejeicao): RejeicaoPayloadV1 {
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
    motivo: input.motivo,
  }
}

const PAPEIS_VALIDOS: readonly string[] = ['gestor', 'patrimonio']
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
  throw new RejeicaoPayloadError(`Snapshot histórico de rejeição inválido: campo "${campo}" ausente ou malformado.`)
}

/**
 * Valida um `unknown` (o que `EmailEvento.payload` devolve em runtime) e
 * só retorna um RejeicaoPayloadV1 de verdade se TODOS os campos baterem
 * com o formato esperado. Nunca um `as ...` sem validação, nunca fallback
 * silencioso para dados vivos.
 */
export function parseRejeicaoPayload(value: unknown): RejeicaoPayloadV1 {
  if (!isObjeto(value)) {
    throw new RejeicaoPayloadError('Snapshot histórico de rejeição ausente ou em formato inesperado.')
  }

  if (value.versao !== 1) {
    throw new RejeicaoPayloadError('Snapshot histórico de rejeição com versão não suportada.')
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
  if (!isString(value.motivo) || value.motivo.length === 0) erroPayload('motivo')

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
    papel: value.papel as PapelRejeicao,
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
    motivo: value.motivo,
  }
}

/**
 * Renderiza REJEICAO_GESTOR/REJEICAO_PATRIMONIO a partir de um payload JÁ
 * VALIDADO — `link` continua vindo de fora, calculado no momento do envio.
 * O `papel` já congelado no payload decide o assunto/frase de abertura
 * dentro do template — nenhuma lógica de qual-tipo-é-este duplicada aqui.
 */
export function renderRejeicaoFromPayload(
  payload: RejeicaoPayloadV1,
  link: string,
  bannerDestinatarioOriginal: string | null = null
): RenderedEmail {
  return renderRejeicaoEmail({
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
    motivo: payload.motivo,
    link,
    bannerDestinatarioOriginal,
  })
}
