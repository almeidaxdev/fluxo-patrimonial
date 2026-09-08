// src/lib/query-params.ts
//
// Etapa security/input-hardening-b3 — helpers puros (sem NextResponse, sem
// Prisma) para os 2 padrões de query param repetidos em várias rotas GET
// deste projeto: paginação (`page`/`limit`) e validade de data
// (`YYYY-MM-DD` / `Date.parse`). Centralizados aqui para nunca repetir a
// mesma lógica de clamp/validação em cada rota — cada chamador continua
// decidindo por si mesmo o que fazer com o resultado (clamp silencioso
// para paginação, 400 explícito para data inválida), preservando o
// comportamento já existente de cada endpoint.

/** Resultado de paginação já com `skip` calculado — pronto para `prisma.*.findMany({ skip, take: limit })`. */
export interface Paginacao {
  page: number
  limit: number
  skip: number
}

/**
 * Lê `page`/`limit` de `searchParams` e devolve valores sempre seguros para
 * uso direto no Prisma — nunca NaN, nunca zero/negativo, nunca acima do
 * teto do chamador. Um valor ausente ou inválido (não numérico, fracionário,
 * zero, negativo) cai silenciosamente no default — mesmo comportamento que
 * `parseInt(...) || default` já tinha para o caso "ausente", só que agora
 * também cobre "presente porém inválido" (antes viraria NaN e chegava cru
 * ao `skip`/`take` do Prisma).
 */
export function parsePaginacao(
  searchParams: URLSearchParams,
  opts: { limitPadrao: number; limiteMaximo: number; pagePadrao?: number }
): Paginacao {
  const pagePadrao = opts.pagePadrao ?? 1

  const pageRaw = Number(searchParams.get('page'))
  const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : pagePadrao

  const limitRaw = Number(searchParams.get('limit'))
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, opts.limiteMaximo) : opts.limitPadrao

  return { page, limit, skip: (page - 1) * limit }
}

/** `true` quando `valor` é uma data real (`Date.parse` válido) — usado após já confirmar que o parâmetro não é `null`/vazio. */
export function dataValida(valor: string): boolean {
  return !isNaN(new Date(valor).getTime())
}

/**
 * Validação estrita de calendário civil para datas no formato `YYYY-MM-DD`
 * (o formato que `<input type="date">` sempre envia). `dataValida()` sozinho
 * NÃO basta aqui: `new Date('2026-02-30')` não é `Invalid Date` — o
 * JavaScript "rola" silenciosamente para 2026-03-02. Esta função reconstrói
 * a data a partir dos componentes (`Date.UTC`) e confirma que ano/mês/dia
 * batem exatamente com o que foi informado — um dia civil inexistente
 * (30 de fevereiro, 31 de abril) é rejeitado em vez de corrigido.
 */
export function dataCivilValida(valor: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(valor)
  if (!m) return false
  const ano = Number(m[1])
  const mes = Number(m[2])
  const dia = Number(m[3])
  const d = new Date(Date.UTC(ano, mes - 1, dia))
  return d.getUTCFullYear() === ano && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia
}
