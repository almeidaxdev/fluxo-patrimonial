// src/app/api/notificacoes/marcar-todas-lidas/route.ts
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getValidatedMutationSession } from '@/lib/session-validation'

export async function POST() {
  const validacao = await getValidatedMutationSession()
  if (!validacao.valido) return validacao.resposta

  await prisma.notificacao.updateMany({ where: { usuarioId: validacao.user.id, lida: false }, data: { lida: true } })
  return NextResponse.json({ message: 'Notificações marcadas como lidas.' }, { status: 200 })
}
