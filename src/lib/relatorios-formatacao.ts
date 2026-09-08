export interface ItemPapelariaNormalizado {
  chave: string
  descricaoExibicao: string
}

// Apenas equivalências ortográficas confirmadas entram aqui. Isso mantém a
// normalização previsível e evita que uma remoção irrestrita de acentos una
// erros ambíguos como "lapís" ao item "Lápis".
const ALIASES_PAPELARIA: Record<string, { aliases: Set<string>; exibicao: string }> = {
  lapis: { aliases: new Set(['lapis', 'lápis']), exibicao: 'Lápis' },
}

function compactarTexto(valor: string): string {
  return valor.trim().toLocaleLowerCase('pt-BR').replace(/\s+/g, ' ').normalize('NFC')
}

function semAcentos(valor: string): string {
  return valor.normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC')
}

function capitalizar(valor: string): string {
  return valor ? `${valor.charAt(0).toLocaleUpperCase('pt-BR')}${valor.slice(1)}` : valor
}

export function normalizarItemPapelaria(valor: string): ItemPapelariaNormalizado {
  const compacto = compactarTexto(valor)
  const baseSemAcentos = semAcentos(compacto)
  const regra = ALIASES_PAPELARIA[baseSemAcentos]

  if (regra?.aliases.has(compacto)) {
    return { chave: `alias:${baseSemAcentos}`, descricaoExibicao: regra.exibicao }
  }

  return { chave: `texto:${compacto}`, descricaoExibicao: capitalizar(compacto) }
}

export interface MesComTotal {
  mes: string
  total: number
}

export function recortarHistoricoEmFormacao<T extends MesComTotal>(meses: T[]): {
  meses: T[]
  inicioHistorico: string | null
} {
  const primeiroComDados = meses.findIndex((mes) => mes.total > 0)
  if (primeiroComDados <= 0) return { meses, inicioHistorico: null }
  return { meses: meses.slice(primeiroComDados), inicioHistorico: meses[primeiroComDados].mes }
}

export function formatarMesAnoCompleto(mesAno: string): string {
  const [ano, mes] = mesAno.split('-').map(Number)
  return new Date(Date.UTC(ano, mes - 1, 1)).toLocaleDateString('pt-BR', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  })
}

export function formatarAntecedenciaHumana(minutos: number | null): string {
  if (minutos === null) return 'N/D'
  const horasTotais = Math.round(minutos / 60)
  const dias = Math.floor(horasTotais / 24)
  const horas = horasTotais % 24
  const parteDias = `${dias} ${dias === 1 ? 'dia' : 'dias'}`
  const parteHoras = `${horas} ${horas === 1 ? 'hora' : 'horas'}`

  if (dias === 0) return parteHoras
  if (horas === 0) return parteDias
  return `${parteDias} e ${parteHoras}`
}
