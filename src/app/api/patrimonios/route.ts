// src/app/api/patrimonios/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getValidatedMutationSession } from '@/lib/session-validation'
import { isPatrimonioOuAdmin } from '@/lib/permissions'
import { patrimonioSchema, buscaSchema } from '@/lib/validations'
import { parsePaginacao } from '@/lib/query-params'
import { parseJsonBody } from '@/lib/http'
import { assertDemoActionAllowed } from '@/lib/demo-mode'

// Etapa security/session-revocation: GET "privilegiado" (auditoria seletiva
// de GETs — ver docs/ARQUITETURA.md, seção "Revogação de sessão") — a rota
// inteira já é exclusiva de Patrimônio/Administrador (sem ramo comum, ao
// contrário de GET /api/solicitacoes) e expõe o inventário COMPLETO de bens.
// Revalida no banco (mesmo padrão já usado em GET /api/colaboradores e em
// autorizarRelatorios()) para que um usuário rebaixado/desativado não
// continue listando o inventário por até 24h com o token antigo.
export async function GET(req: NextRequest) {
  const validacao = await getValidatedMutationSession()
  if (!validacao.valido) return validacao.resposta
  if (!isPatrimonioOuAdmin(validacao.user)) return NextResponse.json({ message: 'Sem permissão.' }, { status: 403 })

  const { searchParams } = new URL(req.url)
  const buscaBruta = searchParams.get('busca') || ''
  const parsedBusca = buscaSchema.safeParse(buscaBruta)
  if (!parsedBusca.success) {
    return NextResponse.json({ message: parsedBusca.error.errors[0]?.message ?? 'Busca inválida.' }, { status: 400 })
  }
  const busca = parsedBusca.data
  const categoriaId = searchParams.get('categoriaId')
  const ativo = searchParams.get('ativo')
  // Etapa security/input-hardening-b3: default (15) preservado; teto de 100
  // contra um `limit` arbitrariamente grande.
  const { page, limit, skip } = parsePaginacao(searchParams, { limitPadrao: 15, limiteMaximo: 100 })

  const where: Record<string, unknown> = {}
  if (busca) {
    where.OR = [
      { numero: { contains: busca, mode: 'insensitive' } },
      { marca: { contains: busca, mode: 'insensitive' } },
      { modelo: { contains: busca, mode: 'insensitive' } },
    ]
  }
  if (categoriaId) where.categoriaId = categoriaId
  if (ativo !== null && ativo !== '') where.ativo = ativo === 'true'

  const [patrimonios, total] = await Promise.all([
    prisma.patrimonio.findMany({
      where,
      include: { categoria: true },
      orderBy: { numero: 'asc' },
      skip,
      take: limit,
    }),
    prisma.patrimonio.count({ where }),
  ])

  return NextResponse.json({ patrimonios, total, page, limit }, { status: 200 })
}

export async function POST(req: NextRequest) {
  const validacao = await getValidatedMutationSession()
  if (!validacao.valido) return validacao.resposta
  if (!isPatrimonioOuAdmin(validacao.user)) return NextResponse.json({ message: 'Sem permissão.' }, { status: 403 })

  // Fluxo Patrimonial — Demo: patrimônios são dado mestre somente-leitura
  // na demo — criação bloqueada por inteiro (ver src/lib/demo-mode.ts).
  const bloqueio = assertDemoActionAllowed('patrimonio:mutar')
  if (bloqueio) return bloqueio

  try {
    const corpo = await parseJsonBody(req)
    if (!corpo.ok) return corpo.resposta
    const parsed = patrimonioSchema.safeParse(corpo.data)
    if (!parsed.success) {
      return NextResponse.json({ message: parsed.error.errors[0]?.message ?? 'Dados inválidos.' }, { status: 400 })
    }

    const existe = await prisma.patrimonio.findUnique({ where: { numero: parsed.data.numero } })
    if (existe) return NextResponse.json({ message: 'Número de patrimônio já cadastrado.' }, { status: 409 })

    const categoria = await prisma.categoriaPatrimonio.findUnique({ where: { id: parsed.data.categoriaId } })
    if (!categoria) return NextResponse.json({ message: 'Categoria inválida.' }, { status: 400 })

    const patrimonio = await prisma.patrimonio.create({
      data: {
        numero: parsed.data.numero,
        marca: parsed.data.marca,
        modelo: parsed.data.modelo,
        categoriaId: parsed.data.categoriaId,
        observacoes: parsed.data.observacoes,
        ativo: parsed.data.ativo ?? true,
      },
      include: { categoria: true },
    })

    return NextResponse.json({ patrimonio }, { status: 201 })
  } catch (e) {
    console.error(e)
    return NextResponse.json({ message: 'Erro interno no servidor.' }, { status: 500 })
  }
}
