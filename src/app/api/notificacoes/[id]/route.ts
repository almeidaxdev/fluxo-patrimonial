// src/app/api/notificacoes/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getValidatedMutationSession } from '@/lib/session-validation'

export async function PATCH(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const validacao = await getValidatedMutationSession()
  if (!validacao.valido) return validacao.resposta

  const { id } = await params

  const notificacao = await prisma.notificacao.findUnique({ where: { id } })
  if (!notificacao || notificacao.usuarioId !== validacao.user.id) {
    return NextResponse.json({ message: 'Notificação não encontrada.' }, { status: 404 })
  }

  const atualizada = await prisma.notificacao.update({ where: { id }, data: { lida: true } })
  return NextResponse.json({ notificacao: atualizada }, { status: 200 })
}
