// src/lib/email/payloads/reserva-confirmada.ts
//
// Etapa D.3.6.3 — fonte única e histórica do conteúdo de RESERVA_CONFIRMADA
// (achado do Codex Review na Etapa D.3: o dispatcher, ao recuperar um
// evento abandonado, reconstruía o e-mail lendo o catálogo de
// Patrimônio/CategoriaPatrimonio ATUAL, não os dados existentes no momento
// da confirmação — um cadastro editado depois faria um e-mail "histórico"
// mentir sobre o que foi realmente confirmado. Ver análise da Etapa
// D.3.6.1).
//
// Este arquivo contém SÓ funções puras (sem Prisma, sem I/O):
// - construirPayloadReservaConfirmada(): solicitação já lida (pelo
//   chamador, dentro da transação de negócio) + papel já resolvido →
//   snapshot congelado (ReservaConfirmadaPayloadV1), copiando cada campo
//   para um objeto/array NOVO — nunca retendo referência ao array/objeto de
//   origem, então uma mutação posterior na fonte nunca alcança o payload já
//   construído;
// - parseReservaConfirmadaPayload(): valida um `unknown` (o que
//   EmailEvento.payload devolve em runtime, vindo de Prisma Json) e só
//   retorna um ReservaConfirmadaPayloadV1 de verdade se cada campo bater
//   com o formato esperado — nunca um cast cego;
// - renderReservaConfirmadaFromPayload(): payload JÁ VALIDADO + link/banner
//   (calculados no momento do envio, nunca guardados no snapshot) →
//   RenderedEmail, delegando inteiramente para o template existente
//   (renderReservaConfirmadaEmail) — nenhum HTML/assunto duplicado aqui.
//
// NENHUM destes três é chamado ainda por rota ou pelo dispatcher nesta
// etapa (isso fica para D.3.6.4/D.3.6.5) — só a API pura é criada e
// testada aqui.

import type { PeriodoSolicitacao, TipoEmprestimo, TipoDominio } from '@/types'
import { renderReservaConfirmadaEmail } from '../templates/reserva-confirmada'
import type { PapelDestinatario, ItemPatrimonioResumo, ItemPapelariaResumo, ItemServicoResumo } from '../templates/reserva-confirmada'
import type { RenderedEmail } from '../processar-evento'

/**
 * Formato persistido em EmailEvento.payload (Json?) para eventos
 * RESERVA_CONFIRMADA. `versao` existe para permitir, no futuro, um formato
 * v2 sem quebrar a leitura de eventos antigos ainda com payload v1 pendente
 * — nenhuma migração automática de formato é feita aqui; um leitor futuro
 * decide por versão, nunca tenta adivinhar/converter em runtime.
 *
 * DELIBERADAMENTE fora daqui: link (APP_URL), banner de EMAIL_TEST_MODE,
 * destinatário físico de teste — tudo isso continua calculado no momento
 * do envio (ver renderReservaConfirmadaFromPayload), nunca congelado no
 * snapshot.
 */
export interface ReservaConfirmadaPayloadV1 {
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

  /**
   * Etapa domain-flow — adicionados DEPOIS da v1 original. Continuam sob
   * `versao: 1` (mudança puramente aditiva, nenhum campo existente mudou de
   * forma/semântica) — payloads persistidos ANTES desta etapa simplesmente
   * não têm essas chaves no JSON; parseReservaConfirmadaPayload() trata a
   * ausência como `null`, nunca como erro de validação.
   */
  notebooksComDominio: boolean | null
  tipoDominio: TipoDominio | null

  /** ISO 8601, ou `null` para reserva interna (sem Assinatura) ou dado legado ausente. */
  assinaturaConfirmadaEmIso: string | null
}

/**
 * Lançado por parseReservaConfirmadaPayload() quando `EmailEvento.payload`
 * está ausente ou não bate com o formato esperado. Mensagem sempre curta e
 * genérica — nunca inclui o conteúdo do payload (que pode conter dados de
 * negócio), só o nome do campo que falhou a validação. Quem chama (ver
 * processarEmailEvento/marcarFalha em processar-evento.ts) já sanitiza e
 * trunca qualquer `Error.message` antes de persistir em EmailEvento.erro —
 * este erro é compatível com esse mecanismo, sem exigir tratamento especial.
 */
export class ReservaConfirmadaPayloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReservaConfirmadaPayloadError'
  }
}

/** Dados que o chamador (rota, dentro da transação) já tem em mãos para montar o snapshot. */
export interface ConstruirPayloadReservaConfirmadaInput {
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
  assinaturaConfirmadaEm: Date | null
}

/**
 * Congela `input` (mais o `papel` já resolvido pelo chamador) num
 * ReservaConfirmadaPayloadV1. Função pura — sem Prisma, sem I/O. Cada
 * array/objeto do resultado é NOVO (via `.map()`, nunca a referência
 * original) — uma mutação posterior no objeto/array passado como `input`
 * nunca alcança o payload já retornado.
 */
export function construirPayloadReservaConfirmada(
  input: ConstruirPayloadReservaConfirmadaInput,
  papel: PapelDestinatario
): ReservaConfirmadaPayloadV1 {
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
    assinaturaConfirmadaEmIso: input.assinaturaConfirmadaEm ? input.assinaturaConfirmadaEm.toISOString() : null,
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

/** `Date.parse` aceita várias strings não-ISO também — suficiente aqui: só precisamos saber se `new Date(...)` vai produzir uma data válida na renderização. */
function isIsoDateValida(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value))
}

function erroPayload(campo: string): never {
  throw new ReservaConfirmadaPayloadError(`Snapshot histórico de RESERVA_CONFIRMADA inválido: campo "${campo}" ausente ou malformado.`)
}

/**
 * Valida um `unknown` (o que `EmailEvento.payload` devolve em runtime —
 * Prisma tipa `Json?` como `Prisma.JsonValue | null`) e só retorna um
 * ReservaConfirmadaPayloadV1 de verdade se TODOS os campos baterem com o
 * formato esperado. Nunca um `as ReservaConfirmadaPayloadV1` sem validação.
 *
 * Lança ReservaConfirmadaPayloadError (nunca retorna um payload parcial ou
 * "melhor esforço") para: payload ausente/null, versão não suportada, ou
 * qualquer campo com tipo/formato inesperado — decisão da Etapa D.3.6.1:
 * nunca cair silenciosamente para leitura de dados ao vivo, isso recriaria
 * exatamente o bug que este mecanismo existe para eliminar.
 */
export function parseReservaConfirmadaPayload(value: unknown): ReservaConfirmadaPayloadV1 {
  if (!isObjeto(value)) {
    throw new ReservaConfirmadaPayloadError('Snapshot histórico de RESERVA_CONFIRMADA ausente ou em formato inesperado.')
  }

  if (value.versao !== 1) {
    throw new ReservaConfirmadaPayloadError('Snapshot histórico de RESERVA_CONFIRMADA com versão não suportada.')
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

  // Etapa domain-flow: campos ausentes (payloads persistidos antes desta
  // etapa) são tratados como `null` — nunca um erro de validação. Só
  // rejeita quando a chave EXISTE com um valor malformado.
  const notebooksComDominio = value.notebooksComDominio === undefined ? null : value.notebooksComDominio
  if (notebooksComDominio !== null && typeof notebooksComDominio !== 'boolean') erroPayload('notebooksComDominio')

  const tipoDominio = value.tipoDominio === undefined ? null : value.tipoDominio
  if (tipoDominio !== null && (typeof tipoDominio !== 'string' || !TIPOS_DOMINIO_VALIDOS.includes(tipoDominio))) erroPayload('tipoDominio')

  if (value.assinaturaConfirmadaEmIso !== null && !isIsoDateValida(value.assinaturaConfirmadaEmIso)) erroPayload('assinaturaConfirmadaEmIso')

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
    assinaturaConfirmadaEmIso: value.assinaturaConfirmadaEmIso as string | null,
  }
}

/**
 * Renderiza RESERVA_CONFIRMADA a partir de um payload JÁ VALIDADO (ver
 * parseReservaConfirmadaPayload) — `link` e `bannerDestinatarioOriginal`
 * continuam vindo de fora, calculados no momento do envio (nunca
 * congelados no snapshot — ver ReservaConfirmadaPayloadV1). Delega
 * inteiramente ao template existente; nenhum HTML/assunto duplicado aqui.
 *
 * Fonte única para inline E dispatcher (Etapa D.3.6.1, item 14): os dois
 * caminhos futuros chamam esta MESMA função com o MESMO payload — nunca há
 * como divergir, porque não existe um segundo caminho de renderização.
 */
export function renderReservaConfirmadaFromPayload(
  payload: ReservaConfirmadaPayloadV1,
  link: string,
  bannerDestinatarioOriginal: string | null = null
): RenderedEmail {
  return renderReservaConfirmadaEmail({
    papel: payload.papel,
    tipoEmprestimo: payload.tipoEmprestimo,
    numero: payload.numero,
    nomeSolicitante: payload.nomeSolicitante,
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
    assinaturaConfirmadaEm: payload.assinaturaConfirmadaEmIso ? new Date(payload.assinaturaConfirmadaEmIso) : null,
    link,
    bannerDestinatarioOriginal,
  })
}
