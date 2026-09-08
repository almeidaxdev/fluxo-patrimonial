// src/lib/http.ts
//
// Etapa security/input-hardening-b4 — antes deste helper, `await req.json()`
// era chamado direto em cada rota; um corpo JSON malformado (ex.: cliente
// manual, `Content-Type` errado, corpo truncado) faz `req.json()` LANÇAR uma
// `SyntaxError`, capturada pelo `catch` genérico de cada rota — que sempre
// devolve 500 "Erro interno no servidor.", indistinguível de uma falha real
// do servidor. Um corpo malformado é um erro de ENTRADA do cliente, não uma
// falha interna: merece 400, com uma mensagem que não expõe detalhes do
// parser.
import { NextResponse } from 'next/server'

export type ResultadoJsonBody<T> = { ok: true; data: T } | { ok: false; resposta: NextResponse }

/**
 * Lê e faz parse do corpo JSON de uma requisição. Uso:
 *
 *   const corpo = await parseJsonBody(req)
 *   if (!corpo.ok) return corpo.resposta
 *   const body = corpo.data
 */
export async function parseJsonBody<T = unknown>(req: Request): Promise<ResultadoJsonBody<T>> {
  try {
    return { ok: true, data: (await req.json()) as T }
  } catch {
    return {
      ok: false,
      resposta: NextResponse.json({ message: 'Corpo da requisição inválido.' }, { status: 400 }),
    }
  }
}
