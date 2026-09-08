// src/lib/email/payloads/solicitacao-aguardando-patrimonio.ts
//
// Etapa email-aguardando-patrimonio — fonte única e histórica do conteúdo
// de SOLICITACAO_AGUARDANDO_PATRIMONIO, seguindo EXATAMENTE o padrão já
// estabelecido por SOLICITACAO_AGUARDANDO_GESTOR (ver
// payloads/solicitacao-aguardando-gestor.ts): o dispatcher, ao recuperar
// um evento abandonado, nunca deve reconstruir o e-mail lendo o estado
// ATUAL da Solicitacao/User — o conteúdo é congelado em
// EmailEvento.payload no momento da criação do evento (dentro da mesma
// transação que persiste a aprovação do gestor).
//
// UM ÚNICO payload é reaproveitado para todos os EmailEvento desta
// solicitação (um por membro ativo da equipe Patrimônio) — não há `papel`
// que diferencie o conteúdo entre destinatários (mesmo raciocínio de
// SOLICITACAO_AGUARDANDO_GESTOR, que também não tem `papel`).
//
// Validade (Etapa 15 do pedido): TEM regra de obsolescência —
// AGUARDANDO_PATRIMONIO NÃO é terminal (`TRANSICOES_PERMITIDAS['AGUARDANDO_PATRIMONIO']`
// permite CONFIRMADA/REJEITADA_PATRIMONIO/CANCELADA — src/lib/status.ts) —
// ver STATUS_ESPERADO_POR_TIPO em validade-evento.ts.
//
// Este arquivo contém só funções puras (sem Prisma, sem I/O) — mesmo trio
// de RESERVA_CONFIRMADA/SOLICITACAO_AGUARDANDO_GESTOR/ASSINATURA_PENDENTE/REJEICAO_*/CANCELAMENTO.
//
// Etapa email-patrimonio-solicitacao-interna: este mesmo evento passou a
// ser criado também no POST /api/solicitacoes, quando uma solicitação
// INTERNA já nasce em AGUARDANDO_PATRIMONIO (sem gestor aprovador
// envolvido) — mesmo raciocínio de `tipoEmprestimo`/`ambiente` já usado por
// ReservaConfirmadaPayloadV1 (ver payloads/reserva-confirmada.ts) para um
// payload compartilhado entre os dois fluxos. `nomeGestorAprovador` e
// `ambiente` são mutuamente exclusivos: externo sempre tem o primeiro e
// nunca o segundo; interno é o oposto. `tipoEmprestimo` ausente no payload
// (registro histórico anterior a esta etapa) é tratado como 'externo' pelo
// parser abaixo — todo EmailEvento SOLICITACAO_AGUARDANDO_PATRIMONIO
// criado antes desta etapa só podia vir do fluxo externo.

import type { PeriodoSolicitacao, TipoDominio, TipoEmprestimo } from '@/types'
import { renderSolicitacaoAguardandoPatrimonioEmail } from '../templates/solicitacao-aguardando-patrimonio'
import type {
  ItemPatrimonioResumo,
  ItemPapelariaResumo,
  ItemServicoResumo,
} from '../templates/solicitacao-aguardando-patrimonio'
import type { RenderedEmail } from '../processar-evento'

export interface SolicitacaoAguardandoPatrimonioPayloadV1 {
  versao: 1

  numero: number
  nomeSolicitante: string
  /** `null` para solicitação interna (não passou por aprovação de gestor). */
  nomeGestorAprovador: string | null
  /** Etapa email-patrimonio-solicitacao-interna. Ausente em payloads antigos → tratado como 'externo' pelo parser. */
  tipoEmprestimo: TipoEmprestimo

  /** ISO 8601 — nunca um `Date` dentro do JSON. */
  dataIso: string
  periodos: string[]

  /** Etapa email-patrimonio-solicitacao-interna — só preenchido para tipoEmprestimo='interno'. Ausente em payloads antigos → `null`. */
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
}

export class SolicitacaoAguardandoPatrimonioPayloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SolicitacaoAguardandoPatrimonioPayloadError'
  }
}

/** Dados que o chamador (rota /aprovar-gestor, dentro da transação) já tem em mãos para montar o snapshot. */
export interface ConstruirPayloadSolicitacaoAguardandoPatrimonioInput {
  numero: number
  nomeSolicitante: string
  nomeGestorAprovador: string | null
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
}

/**
 * Congela `input` num SolicitacaoAguardandoPatrimonioPayloadV1. Função
 * pura — sem Prisma, sem I/O. Cada array do resultado é NOVO (via
 * `.map()`, nunca a referência original).
 */
export function construirPayloadSolicitacaoAguardandoPatrimonio(
  input: ConstruirPayloadSolicitacaoAguardandoPatrimonioInput
): SolicitacaoAguardandoPatrimonioPayloadV1 {
  return {
    versao: 1,
    numero: input.numero,
    nomeSolicitante: input.nomeSolicitante,
    nomeGestorAprovador: input.nomeGestorAprovador,
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
  }
}

const PERIODOS_VALIDOS: readonly string[] = ['MANHA', 'TARDE', 'NOITE']
const TIPOS_DOMINIO_VALIDOS: readonly string[] = ['EDUCACIONAL', 'ADMINISTRATIVO']
const TIPOS_EMPRESTIMO_VALIDOS: readonly string[] = ['interno', 'externo']

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
  throw new SolicitacaoAguardandoPatrimonioPayloadError(`Snapshot histórico de SOLICITACAO_AGUARDANDO_PATRIMONIO inválido: campo "${campo}" ausente ou malformado.`)
}

/**
 * Valida um `unknown` (o que `EmailEvento.payload` devolve em runtime) e
 * só retorna um SolicitacaoAguardandoPatrimonioPayloadV1 de verdade se
 * TODOS os campos baterem com o formato esperado. Nunca um `as ...` sem
 * validação, nunca fallback silencioso para dados vivos.
 */
export function parseSolicitacaoAguardandoPatrimonioPayload(value: unknown): SolicitacaoAguardandoPatrimonioPayloadV1 {
  if (!isObjeto(value)) {
    throw new SolicitacaoAguardandoPatrimonioPayloadError('Snapshot histórico de SOLICITACAO_AGUARDANDO_PATRIMONIO ausente ou em formato inesperado.')
  }

  if (value.versao !== 1) {
    throw new SolicitacaoAguardandoPatrimonioPayloadError('Snapshot histórico de SOLICITACAO_AGUARDANDO_PATRIMONIO com versão não suportada.')
  }

  if (typeof value.numero !== 'number' || !Number.isFinite(value.numero)) erroPayload('numero')
  if (!isString(value.nomeSolicitante) || value.nomeSolicitante.length === 0) erroPayload('nomeSolicitante')
  // `null` para solicitação interna (Etapa email-patrimonio-solicitacao-interna)
  // — string vazia continua inválida em ambos os casos.
  if (value.nomeGestorAprovador !== null && (!isString(value.nomeGestorAprovador) || value.nomeGestorAprovador.length === 0)) {
    erroPayload('nomeGestorAprovador')
  }
  // Ausente = payload histórico anterior a esta etapa → só podia ser externo.
  const tipoEmprestimo = value.tipoEmprestimo === undefined ? 'externo' : value.tipoEmprestimo
  if (typeof tipoEmprestimo !== 'string' || !TIPOS_EMPRESTIMO_VALIDOS.includes(tipoEmprestimo)) erroPayload('tipoEmprestimo')
  if (!isIsoDateValida(value.dataIso)) erroPayload('dataIso')
  if (!Array.isArray(value.periodos) || !value.periodos.every((p) => typeof p === 'string' && PERIODOS_VALIDOS.includes(p))) erroPayload('periodos')
  // Ausente = payload histórico anterior a esta etapa (sempre externo, nunca teve ambiente).
  const ambiente = value.ambiente === undefined ? null : value.ambiente
  if (!isStringOuNull(ambiente)) erroPayload('ambiente')
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
    nomeSolicitante: value.nomeSolicitante,
    nomeGestorAprovador: value.nomeGestorAprovador as string | null,
    tipoEmprestimo: tipoEmprestimo as TipoEmprestimo,
    dataIso: value.dataIso as string,
    periodos: value.periodos as string[],
    ambiente: ambiente as string | null,
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
 * Renderiza SOLICITACAO_AGUARDANDO_PATRIMONIO a partir de um payload JÁ
 * VALIDADO — `link` continua vindo de fora, calculado no momento do envio
 * (nunca congelado no snapshot). Delega inteiramente ao template
 * existente; nenhum HTML/assunto duplicado aqui.
 */
export function renderSolicitacaoAguardandoPatrimonioFromPayload(
  payload: SolicitacaoAguardandoPatrimonioPayloadV1,
  link: string,
  bannerDestinatarioOriginal: string | null = null
): RenderedEmail {
  return renderSolicitacaoAguardandoPatrimonioEmail({
    numero: payload.numero,
    nomeSolicitante: payload.nomeSolicitante,
    nomeGestorAprovador: payload.nomeGestorAprovador,
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
    link,
    bannerDestinatarioOriginal,
  })
}
