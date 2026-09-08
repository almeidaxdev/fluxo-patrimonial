// src/app/api/gestores/route.ts
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getSession } from '@/lib/auth'

// Somente usuários ativos com permissão de gestor aparecem aqui (Módulo 11).
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ message: 'Não autorizado.' }, { status: 401 })

  const gestores = await prisma.user.findMany({
    where: { ativo: true, podeSerGestor: true },
    select: { id: true, nome: true, email: true },
    orderBy: { nome: 'asc' },
  })

  return NextResponse.json({ gestores }, { status: 200 })
}
