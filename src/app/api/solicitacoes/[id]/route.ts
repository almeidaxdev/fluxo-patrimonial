// src/app/api/solicitacoes/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getSession } from '@/lib/auth'
import { isPatrimonioOuAdmin } from '@/lib/permissions'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ message: 'Não autorizado.' }, { status: 401 })

  const { id } = await params

  const solicitacao = await prisma.solicitacao.findUnique({
    where: { id },
    include: {
      solicitante: { select: { id: true, nome: true, email: true } },
      criadoPor: { select: { id: true, nome: true, email: true } },
      gestor: { select: { id: true, nome: true, email: true } },
      itensPatrimonio: { include: { patrimonio: { include: { categoria: true } } } },
      itensPapelaria: true,
      itensServico: { include: { tipoServico: { select: { nome: true } } } },
      assinatura: {
        include: {
          enviadoPor: { select: { id: true, nome: true } },
          confirmadaPor: { select: { id: true, nome: true } },
        },
      },
      historico: {
        include: { usuario: { select: { id: true, nome: true } } },
        orderBy: { createdAt: 'asc' },
      },
    },
  })

  if (!solicitacao) return NextResponse.json({ message: 'Solicitação não encontrada.' }, { status: 404 })

  // Autorização: solicitante, gestor responsável, Patrimônio e administrador.
  const podeVer =
    solicitacao.solicitanteId === session.id ||
    solicitacao.criadoPorId === session.id ||
    solicitacao.gestorId === session.id ||
    isPatrimonioOuAdmin(session)

  if (!podeVer) return NextResponse.json({ message: 'Sem permissão para ver esta solicitação.' }, { status: 403 })

  return NextResponse.json({ solicitacao }, { status: 200 })
}
