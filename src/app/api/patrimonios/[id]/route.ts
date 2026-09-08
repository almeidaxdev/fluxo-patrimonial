// src/app/api/patrimonios/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getValidatedMutationSession } from '@/lib/session-validation'
import { isPatrimonioOuAdmin } from '@/lib/permissions'
import { patrimonioSchema } from '@/lib/validations'
import { parseJsonBody } from '@/lib/http'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const validacao = await getValidatedMutationSession()
  if (!validacao.valido) return validacao.resposta
  if (!isPatrimonioOuAdmin(validacao.user)) return NextResponse.json({ message: 'Sem permissão.' }, { status: 403 })

  const { id } = await params

  try {
    const corpo = await parseJsonBody(req)
    if (!corpo.ok) return corpo.resposta
    const parsed = patrimonioSchema.partial().safeParse(corpo.data)
    if (!parsed.success) {
      return NextResponse.json({ message: parsed.error.errors[0]?.message ?? 'Dados inválidos.' }, { status: 400 })
    }

    const atual = await prisma.patrimonio.findUnique({ where: { id } })
    if (!atual) return NextResponse.json({ message: 'Bem patrimonial não encontrado.' }, { status: 404 })

    if (parsed.data.numero && parsed.data.numero !== atual.numero) {
      const existe = await prisma.patrimonio.findUnique({ where: { numero: parsed.data.numero } })
      if (existe) return NextResponse.json({ message: 'Já existe um bem cadastrado com este número de patrimônio.' }, { status: 409 })
    }

    if (parsed.data.categoriaId) {
      const categoria = await prisma.categoriaPatrimonio.findUnique({ where: { id: parsed.data.categoriaId } })
      if (!categoria) return NextResponse.json({ message: 'Categoria inválida.' }, { status: 400 })
    }

    const patrimonio = await prisma.patrimonio.update({
      where: { id },
      data: parsed.data,
      include: { categoria: true },
    })

    return NextResponse.json({ patrimonio }, { status: 200 })
  } catch (e) {
    console.error(e)
    return NextResponse.json({ message: 'Não foi possível atualizar o patrimônio.' }, { status: 500 })
  }
}

// Remoção segura: bem sem nenhum vínculo em solicitações é excluído
// permanentemente; bem com histórico é apenas desativado, preservando a
// rastreabilidade das solicitações antigas.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const validacao = await getValidatedMutationSession()
  if (!validacao.valido) return validacao.resposta
  if (!isPatrimonioOuAdmin(validacao.user)) return NextResponse.json({ message: 'Sem permissão.' }, { status: 403 })

  const { id } = await params

  try {
    const patrimonio = await prisma.patrimonio.findUnique({ where: { id } })
    if (!patrimonio) return NextResponse.json({ message: 'Bem patrimonial não encontrado.' }, { status: 404 })

    const vinculos = await prisma.itemPatrimonioSolicitacao.count({ where: { patrimonioId: id } })

    if (vinculos > 0) {
      await prisma.patrimonio.update({ where: { id }, data: { ativo: false } })
      return NextResponse.json(
        { message: 'Este bem possui histórico de utilização e não pode ser excluído permanentemente. Ele foi desativado e não aparecerá em novas solicitações.', inativado: true },
        { status: 200 }
      )
    }

    await prisma.patrimonio.delete({ where: { id } })
    return NextResponse.json({ message: 'Bem patrimonial removido.', inativado: false }, { status: 200 })
  } catch (e) {
    console.error(e)
    return NextResponse.json({ message: 'Não foi possível remover o bem patrimonial.' }, { status: 500 })
  }
}
