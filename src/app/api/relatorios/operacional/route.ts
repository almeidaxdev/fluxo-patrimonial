// src/app/api/relatorios/operacional/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { autorizarRelatorios } from '@/lib/relatorios-auth'
import { construirFiltros, FiltroRelatorioInvalidoError } from '@/lib/relatorios'
import { buscaSchema } from '@/lib/validations'
import { parsePaginacao } from '@/lib/query-params'

// Tabela detalhada/paginada usada pela Visão Operacional. Usa `_count` para
// as quantidades de itens em vez de trazer os arrays completos — evita
// carregar dados desnecessários por linha (nada de N+1: uma única query
// paginada com os counts já embutidos pelo Prisma).
export async function GET(req: NextRequest) {
  const auth = await autorizarRelatorios()
  if (!auth.autorizado) return auth.resposta

  try {
    const { searchParams } = new URL(req.url)
    const { where } = construirFiltros(searchParams)

    // Busca por número, solicitante ou patrimônio (Etapa 6 — refinamento).
    // Executada no backend, dentro da mesma query paginada — nunca carrega
    // todos os registros para filtrar no navegador.
    const buscaBruta = searchParams.get('busca')
    const parsedBusca = buscaBruta !== null ? buscaSchema.safeParse(buscaBruta) : null
    if (parsedBusca && !parsedBusca.success) {
      return NextResponse.json({ message: parsedBusca.error.errors[0]?.message ?? 'Busca inválida.' }, { status: 400 })
    }
    const busca = parsedBusca?.success ? parsedBusca.data : undefined
    if (busca) {
      const buscaNumero = /^\d+$/.test(busca) ? parseInt(busca, 10) : null
      where.OR = [
        ...(buscaNumero !== null ? [{ numero: buscaNumero }] : []),
        { solicitante: { nome: { contains: busca, mode: 'insensitive' as const } } },
        {
          itensPatrimonio: {
            some: {
              patrimonio: {
                OR: [
                  { numero: { contains: busca, mode: 'insensitive' as const } },
                  { marca: { contains: busca, mode: 'insensitive' as const } },
                  { modelo: { contains: busca, mode: 'insensitive' as const } },
                ],
              },
            },
          },
        },
      ]
    }

    // Etapa security/input-hardening-b3: mesmo helper compartilhado usado
    // pelas demais rotas paginadas (src/lib/query-params.ts) — antes desta
    // etapa este era o único endpoint com clamp manual (`Math.max`/
    // `Math.min`); default (25) e teto (100) preservados EXATAMENTE.
    const { page, limit, skip } = parsePaginacao(searchParams, { limitPadrao: 25, limiteMaximo: 100 })

    const [solicitacoes, total] = await Promise.all([
      prisma.solicitacao.findMany({
        where,
        select: {
          id: true,
          numero: true,
          tipoEmprestimo: true,
          origem: true,
          status: true,
          data: true,
          periodos: true,
          ambiente: true,
          local: true,
          cidade: true,
          createdAt: true,
          prazoHoras: true,
          antecedenciaMinutos: true,
          dentroDoPrazo: true,
          retiradaEm: true,
          devolucaoEm: true,
          solicitante: { select: { id: true, nome: true, email: true } },
          _count: { select: { itensPatrimonio: true, itensPapelaria: true, itensServico: true } },
        },
        orderBy: { data: 'desc' },
        skip,
        take: limit,
      }),
      prisma.solicitacao.count({ where }),
    ])

    return NextResponse.json({ solicitacoes, total, page, limit }, { status: 200 })
  } catch (e) {
    if (e instanceof FiltroRelatorioInvalidoError) {
      return NextResponse.json({ message: e.message }, { status: 400 })
    }
    console.error(e)
    return NextResponse.json({ message: 'Não foi possível carregar a tabela operacional.' }, { status: 500 })
  }
}
