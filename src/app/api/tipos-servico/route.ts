// src/app/api/tipos-servico/route.ts
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getSession } from '@/lib/auth'

// Qualquer usuário autenticado pode LISTAR tipos de serviço (necessário para
// o formulário de solicitação) — mesmo padrão de GET /api/categorias.
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ message: 'Não autorizado.' }, { status: 401 })

  try {
    const tiposServico = await prisma.tipoServico.findMany({
      orderBy: [{ ordem: 'asc' }, { nome: 'asc' }],
    })

    return NextResponse.json({ tiposServico }, { status: 200 })
  } catch (e) {
    console.error(e)
    return NextResponse.json({ message: 'Não foi possível carregar os tipos de serviço.' }, { status: 500 })
  }
}
