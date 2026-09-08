// src/app/api/colaboradores/busca/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getSession } from '@/lib/auth'
import { buscaSchema } from '@/lib/validations'

// Busca simples usada no fluxo de "Solicitar para outro colaborador".
// Disponível para qualquer usuário autenticado (não expõe dados sensíveis).
export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ message: 'Não autorizado.' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const buscaBruta = searchParams.get('busca') || ''
  const parsedBusca = buscaSchema.safeParse(buscaBruta)
  if (!parsedBusca.success) {
    return NextResponse.json({ message: parsedBusca.error.errors[0]?.message ?? 'Busca inválida.' }, { status: 400 })
  }
  const busca = parsedBusca.data

  if (busca.length < 2) {
    return NextResponse.json({ colaboradores: [] }, { status: 200 })
  }

  const colaboradores = await prisma.user.findMany({
    where: {
      ativo: true,
      OR: [
        { nome: { contains: busca, mode: 'insensitive' } },
        { email: { contains: busca, mode: 'insensitive' } },
      ],
    },
    select: { id: true, nome: true, email: true, gestorPadraoId: true },
    orderBy: { nome: 'asc' },
    take: 10,
  })

  return NextResponse.json({ colaboradores }, { status: 200 })
}
