// src/lib/prazo.ts
//
// Regra central de antecedência/prazo das solicitações (Fase 3).
//
// Fonte única de verdade — nenhuma outra parte do sistema deve reimplementar
// horários de período ou prazos mínimos. Este módulo é isomórfico (sem
// dependências de servidor), podendo ser importado tanto pelas rotas de API
// quanto por componentes 'use client' (wizard e tela de detalhe), garantindo
// que o aviso mostrado ao usuário e o valor persistido no banco usem
// exatamente a mesma lógica.
//
// IMPORTANTE — fuso horário: a unidade opera em horário de Brasília
// (America/Sao_Paulo). O Brasil não adota mais horário de verão desde 2019,
// então o offset em relação ao UTC é fixo em -3h o ano inteiro. Por isso o
// cálculo abaixo usa um offset fixo em vez de uma biblioteca de fuso horário
// (evita dependência nova só para isso). Caso o Brasil volte a adotar horário
// de verão no futuro, este é o único lugar que precisará ser ajustado.

import { PeriodoSolicitacao, TipoEmprestimo } from '@/types'

export const BRASIL_UTC_OFFSET_HORAS = 3

export const PRAZO_HORAS_POR_TIPO: Record<TipoEmprestimo, number> = {
  interno: 48,
  externo: 72,
}

// Horários oficiais de início de cada período (horário de Brasília).
export const PERIODO_HORA_INICIO: Record<PeriodoSolicitacao, { hora: number; minuto: number }> = {
  MANHA: { hora: 8, minuto: 0 },
  TARDE: { hora: 13, minuto: 30 },
  NOITE: { hora: 19, minuto: 0 },
}

// NOVO (Fase 3 — Etapa 4, ajuste): horários oficiais de FIM de cada
// período, usados apenas para sugerir automaticamente o período do
// Atendimento Imediato com base no horário atual — não afeta o cálculo de
// prazo/antecedência das reservas normais, que usa somente o horário de
// início (ver calcularReferenciaUtilizacao).
export const PERIODO_HORA_FIM: Record<PeriodoSolicitacao, { hora: number; minuto: number }> = {
  MANHA: { hora: 12, minuto: 0 },
  TARDE: { hora: 17, minuto: 30 },
  NOITE: { hora: 22, minuto: 30 },
}

const ORDEM_PERIODOS_SUGESTAO: PeriodoSolicitacao[] = ['MANHA', 'TARDE', 'NOITE']

/**
 * Sugere o período mais provável do Atendimento Imediato com base no
 * horário atual (Brasília). É apenas uma SUGESTÃO inicial pré-selecionada
 * no formulário — o usuário Patrimônio/Admin sempre pode alterar antes de
 * registrar (importante para lançamentos feitos depois do atendimento real
 * ter ocorrido).
 *
 * Regra: se o horário atual está dentro da janela oficial de um período,
 * sugere esse período. Fora de todas as janelas (ex.: 12:15, hora do
 * almoço), sugere o período cujo horário de INÍCIO está mais próximo do
 * horário atual — favorecendo o período que está prestes a começar.
 */
export function sugerirPeriodoAtual(agora: Date = new Date()): PeriodoSolicitacao {
  const minutosAgoraBrasilia = ((agora.getUTCHours() - BRASIL_UTC_OFFSET_HORAS + 24) % 24) * 60 + agora.getUTCMinutes()

  for (const periodo of ORDEM_PERIODOS_SUGESTAO) {
    const inicio = PERIODO_HORA_INICIO[periodo]
    const fim = PERIODO_HORA_FIM[periodo]
    const minutosInicio = inicio.hora * 60 + inicio.minuto
    const minutosFim = fim.hora * 60 + fim.minuto
    if (minutosAgoraBrasilia >= minutosInicio && minutosAgoraBrasilia <= minutosFim) {
      return periodo
    }
  }

  // Fora de qualquer janela: sugere o período cujo início está mais próximo
  // (favorece o próximo período a começar; em caso de empate/madrugada,
  // cai naturalmente na Manhã por ser a primeira da lista).
  let maisProximo: PeriodoSolicitacao = 'MANHA'
  let menorDistancia = Infinity
  for (const periodo of ORDEM_PERIODOS_SUGESTAO) {
    const inicio = PERIODO_HORA_INICIO[periodo]
    const minutosInicio = inicio.hora * 60 + inicio.minuto
    const distancia = Math.abs(minutosAgoraBrasilia - minutosInicio)
    if (distancia < menorDistancia) {
      menorDistancia = distancia
      maisProximo = periodo
    }
  }
  return maisProximo
}

const ORDEM_PERIODOS: PeriodoSolicitacao[] = ['MANHA', 'TARDE', 'NOITE']

/** Retorna o período mais cedo dentre os selecionados (MANHA < TARDE < NOITE). */
export function periodoMaisCedo(periodos: PeriodoSolicitacao[]): PeriodoSolicitacao | null {
  for (const p of ORDEM_PERIODOS) {
    if (periodos.includes(p)) return p
  }
  return null
}

/**
 * Combina a data da solicitação (armazenada como DATE, sem hora) com o
 * horário de início do período mais cedo selecionado, retornando o instante
 * exato (UTC) usado como referência para o cálculo de antecedência.
 *
 * `data` pode vir como Date (ex.: retornado pelo Prisma para um campo
 * @db.Date, sempre à meia-noite UTC) ou string 'YYYY-MM-DD' (ex.: vindo de
 * um <input type="date"> no wizard). Em ambos os casos, extraímos os
 * componentes de ano/mês/dia em UTC para não sofrer reinterpretação pelo
 * fuso horário local do navegador/servidor.
 */
export function calcularReferenciaUtilizacao(
  data: Date | string,
  periodos: PeriodoSolicitacao[]
): Date | null {
  const periodo = periodoMaisCedo(periodos)
  if (!periodo) return null

  let ano: number, mes: number, dia: number
  if (typeof data === 'string') {
    const [y, m, d] = data.split('T')[0].split('-').map(Number)
    ano = y
    mes = m - 1
    dia = d
  } else {
    ano = data.getUTCFullYear()
    mes = data.getUTCMonth()
    dia = data.getUTCDate()
  }

  const { hora, minuto } = PERIODO_HORA_INICIO[periodo]
  // hora local (Brasília) + offset fixo = hora UTC equivalente
  return new Date(Date.UTC(ano, mes, dia, hora + BRASIL_UTC_OFFSET_HORAS, minuto))
}

export interface PrazoCalculado {
  prazoHoras: number
  antecedenciaMinutos: number
  dentroDoPrazo: boolean
  prazoReferenciaEm: Date
}

/**
 * Calcula a situação de prazo de uma solicitação no momento da criação.
 * Deve ser chamado uma única vez, na criação, e o resultado persistido —
 * nunca recalculado depois (ver campos prazo_horas/antecedencia_minutos/
 * dentro_do_prazo/prazo_referencia_em em Solicitacao).
 */
export function calcularPrazo(
  tipoEmprestimo: TipoEmprestimo,
  data: Date | string,
  periodos: PeriodoSolicitacao[],
  criadoEm: Date = new Date()
): PrazoCalculado | null {
  const referencia = calcularReferenciaUtilizacao(data, periodos)
  if (!referencia) return null

  const prazoHoras = PRAZO_HORAS_POR_TIPO[tipoEmprestimo]
  const antecedenciaMinutos = Math.round((referencia.getTime() - criadoEm.getTime()) / 60000)
  const dentroDoPrazo = antecedenciaMinutos >= prazoHoras * 60

  return { prazoHoras, antecedenciaMinutos, dentroDoPrazo, prazoReferenciaEm: referencia }
}

/** Formata minutos de antecedência como "3 dias e 5 horas", "45 minutos" etc. */
export function formatarAntecedencia(minutos: number): string {
  const m = Math.max(0, minutos)
  const dias = Math.floor(m / (60 * 24))
  const horasRestantes = Math.floor((m % (60 * 24)) / 60)
  const minutosRestantes = m % 60

  const partes: string[] = []
  if (dias > 0) partes.push(`${dias} ${dias === 1 ? 'dia' : 'dias'}`)
  if (horasRestantes > 0) partes.push(`${horasRestantes} ${horasRestantes === 1 ? 'hora' : 'horas'}`)
  if (partes.length === 0) partes.push(`${minutosRestantes} ${minutosRestantes === 1 ? 'minuto' : 'minutos'}`)

  return partes.join(' e ')
}
