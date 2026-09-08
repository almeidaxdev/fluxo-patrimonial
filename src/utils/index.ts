// src/utils/index.ts
import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { format, parseISO } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { PeriodoSolicitacao } from '@/types'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatDate(date: string | Date): string {
  const d = typeof date === 'string' ? parseISO(date) : date
  return format(d, 'dd/MM/yyyy', { locale: ptBR })
}

export function formatDateTime(date: string | Date): string {
  const d = typeof date === 'string' ? parseISO(date) : date
  return format(d, "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })
}

export function formatDateFull(date: string | Date): string {
  const d = typeof date === 'string' ? parseISO(date) : date
  return format(d, "EEEE, d 'de' MMMM 'de' yyyy", { locale: ptBR })
}

/**
 * Formata uma DATA CIVIL (ex.: Solicitacao.data, Prisma `DateTime @db.Date`
 * → PostgreSQL `DATE`, sem componente de hora nem timezone) como "dd/MM/yyyy"
 * — SEMPRE o mesmo resultado, independentemente do timezone local do
 * processo (servidor) ou do navegador que executa este código.
 *
 * Por que não usar formatDate() para isto: formatDate() usa
 * date-fns#format(), que lê o `Date` por getters LOCAIS (getDate/getMonth/
 * getFullYear). Um `@db.Date` sempre chega como meia-noite UTC (ex.:
 * "2026-08-24T00:00:00.000Z") — em qualquer timezone com offset negativo
 * (ex.: America/Sao_Paulo, UTC-3) os getters locais leem "23/08 21:00",
 * exibindo o dia ANTERIOR ao realmente armazenado. Ver análise da Etapa
 * D.3.FOLLOW-UP (data civil/timezone).
 *
 * Mesma técnica já usada em src/lib/prazo.ts#calcularReferenciaUtilizacao
 * (fonte original do padrão): para string, os componentes ano/mês/dia são
 * lidos por split() da própria string (nunca `new Date(string)`); para
 * `Date`, são lidos via getters UTC (getUTCFullYear/getUTCMonth/getUTCDate)
 * — nunca locais. As duas formas aceitas de string:
 * - "YYYY-MM-DD" (ex.: valor cru de um <input type="date">);
 * - ISO completo "YYYY-MM-DDT00:00:00.000Z" (ex.: serialização JSON de um
 *   `Date` vindo da API) — só a parte antes do "T" é usada; o restante
 *   (hora/timezone) é ignorado de propósito, porque não faz parte da data
 *   civil.
 *
 * NÃO usar America/Sao_Paulo (ou qualquer timezone) aqui: um `@db.Date` não
 * representa um instante, só ano/mês/dia — aplicar qualquer timezone seria
 * reintroduzir exatamente o bug que esta função existe para evitar. Horário
 * de Brasília continua correto para TIMESTAMPs reais (createdAt, enviadoEm,
 * confirmadaEm etc.) — esses continuam usando formatDate()/formatDateTime(),
 * intocados por esta função.
 *
 * Deliberadamente NÃO substitui formatDate() nesta etapa — nenhum call-site
 * existente foi alterado; ambas as funções coexistem até uma rodada futura
 * decidir, call-site a call-site, qual campo é DATE civil (usa esta função)
 * e qual é TIMESTAMP real (continua em formatDate()/formatDateTime()).
 *
 * Entrada inválida: lança Error (nunca retorna "NaN/NaN/NaN" nem uma data
 * silenciosamente errada) — mesma postura de "falhar alto" de
 * date-fns#format() com uma Invalid Date (que lança RangeError), só que com
 * uma mensagem mais específica ao caso desta função.
 */
export function formatDataCivil(data: string | Date): string {
  let ano: number
  let mes: number // 1-12
  let dia: number

  if (typeof data === 'string') {
    const soData = data.split('T')[0] // "YYYY-MM-DD", de string pura ou de um ISO completo
    const partes = soData.split('-').map(Number)
    ;[ano, mes, dia] = partes
  } else {
    ano = data.getUTCFullYear()
    mes = data.getUTCMonth() + 1
    dia = data.getUTCDate()
  }

  if (!Number.isInteger(ano) || !Number.isInteger(mes) || !Number.isInteger(dia) || mes < 1 || mes > 12 || dia < 1 || dia > 31) {
    throw new Error(`formatDataCivil: valor de data inválido (${JSON.stringify(data instanceof Date ? data.toISOString() : data)}).`)
  }

  const pad2 = (n: number) => String(n).padStart(2, '0')
  return `${pad2(dia)}/${pad2(mes)}/${ano}`
}

export function todayISO(): string {
  return new Date().toISOString().split('T')[0]
}

// ---------------------------------------------------------------------------
// Períodos (Manhã / Tarde / Noite) — substituem hora início/fim
// ---------------------------------------------------------------------------

export const PERIODOS_ORDENADOS: PeriodoSolicitacao[] = ['MANHA', 'TARDE', 'NOITE']

/** Um bem está indisponível se existir solicitação bloqueante com interseção de períodos na mesma data. */
export function periodosConflitam(a: PeriodoSolicitacao[], b: PeriodoSolicitacao[]): boolean {
  return a.some((p) => b.includes(p))
}

export function formatPeriodos(periodos: PeriodoSolicitacao[]): string {
  const labels: Record<PeriodoSolicitacao, string> = { MANHA: 'Manhã', TARDE: 'Tarde', NOITE: 'Noite' }
  return PERIODOS_ORDENADOS.filter((p) => periodos.includes(p)).map((p) => labels[p]).join(', ')
}

export function isValidUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}
