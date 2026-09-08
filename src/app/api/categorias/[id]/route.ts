// src/app/api/categorias/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getValidatedMutationSession } from '@/lib/session-validation'
import { isAdmin } from '@/lib/permissions'
import { categoriaSchema } from '@/lib/validations'
import { parseJsonBody } from '@/lib/http'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const validacao = await getValidatedMutationSession()
  if (!validacao.valido) return validacao.resposta
  if (!isAdmin(validacao.user)) return NextResponse.json({ message: 'Sem permissão.' }, { status: 403 })

  const { id } = await params

  try {
    const corpo = await parseJsonBody(req)
    if (!corpo.ok) return corpo.resposta
    const parsed = categoriaSchema.partial().safeParse(corpo.data)
    if (!parsed.success) {
      return NextResponse.json({ message: parsed.error.errors[0]?.message ?? 'Dados inválidos.' }, { status: 400 })
    }

    const atual = await prisma.categoriaPatrimonio.findUnique({ where: { id } })
    if (!atual) return NextResponse.json({ message: 'Categoria não encontrada.' }, { status: 404 })

    if (parsed.data.nome && parsed.data.nome !== atual.nome) {
      const existe = await prisma.categoriaPatrimonio.findUnique({ where: { nome: parsed.data.nome } })
      if (existe) return NextResponse.json({ message: 'Já existe uma categoria cadastrada com este nome.' }, { status: 409 })
    }

    const categoria = await prisma.categoriaPatrimonio.update({
      where: { id },
      data: parsed.data,
    })

    return NextResponse.json({ categoria }, { status: 200 })
  } catch (e) {
    console.error(e)
    return NextResponse.json({ message: 'Não foi possível atualizar a categoria.' }, { status: 500 })
  }
}

// Remoção segura: categoria sem nenhum bem vinculado é excluída
// permanentemente; categoria com bens é apenas desativada (não aparece mais
// em novos cadastros/solicitações, mas continua íntegra em registros antigos).
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const validacao = await getValidatedMutationSession()
  if (!validacao.valido) return validacao.resposta
  if (!isAdmin(validacao.user)) return NextResponse.json({ message: 'Sem permissão.' }, { status: 403 })

  const { id } = await params

  try {
    const categoria = await prisma.categoriaPatrimonio.findUnique({ where: { id } })
    if (!categoria) return NextResponse.json({ message: 'Categoria não encontrada.' }, { status: 404 })

    const vinculos = await prisma.patrimonio.count({ where: { categoriaId: id } })

    if (vinculos > 0) {
      await prisma.categoriaPatrimonio.update({ where: { id }, data: { ativo: false } })
      return NextResponse.json(
        { message: 'Esta categoria possui bens patrimoniais vinculados e não pode ser excluída. Ela foi desativada e não aparecerá em novos cadastros ou solicitações.', inativada: true },
        { status: 200 }
      )
    }

    await prisma.categoriaPatrimonio.delete({ where: { id } })
    return NextResponse.json({ message: 'Categoria removida.', inativada: false }, { status: 200 })
  } catch (e) {
    console.error(e)
    return NextResponse.json({ message: 'Não foi possível remover a categoria.' }, { status: 500 })
  }
}
