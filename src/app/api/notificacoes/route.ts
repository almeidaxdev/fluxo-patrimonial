// src/app/api/notificacoes/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getSession } from '@/lib/auth'

export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ message: 'Não autorizado.' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const apenasNaoLidas = searchParams.get('naoLidas') === 'true'

  const [notificacoes, naoLidas] = await Promise.all([
    prisma.notificacao.findMany({
      where: { usuarioId: session.id, ...(apenasNaoLidas ? { lida: false } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 30,
    }),
    prisma.notificacao.count({ where: { usuarioId: session.id, lida: false } }),
  ])

  return NextResponse.json({ notificacoes, naoLidas }, { status: 200 })
}
