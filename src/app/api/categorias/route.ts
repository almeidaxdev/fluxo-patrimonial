// src/app/api/categorias/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getSession } from '@/lib/auth'
import { getValidatedMutationSession } from '@/lib/session-validation'
import { isAdmin } from '@/lib/permissions'
import { categoriaSchema } from '@/lib/validations'
import { parseJsonBody } from '@/lib/http'

// Qualquer usuário autenticado pode LISTAR categorias (necessário para o
// formulário de solicitação). Somente administrador pode criar/editar.
//
// O parâmetro opcional `comContagem=true` inclui a contagem de bens
// vinculados (_count.patrimonios), usada apenas pela tela administrativa de
// Categorias (modal de remoção). Por padrão essa contagem NÃO é incluída,
// para manter a consulta simples e idêntica à usada pelo wizard de Nova
// Solicitação (que não precisa desse dado).
export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ message: 'Não autorizado.' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const comContagem = searchParams.get('comContagem') === 'true'

  try {
    const categorias = await prisma.categoriaPatrimonio.findMany({
      orderBy: [{ ordem: 'asc' }, { nome: 'asc' }],
      ...(comContagem ? { include: { _count: { select: { patrimonios: true } } } } : {}),
    })

    return NextResponse.json({ categorias }, { status: 200 })
  } catch (e) {
    console.error(e)
    return NextResponse.json({ message: 'Não foi possível carregar as categorias.' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const validacao = await getValidatedMutationSession()
  if (!validacao.valido) return validacao.resposta
  if (!isAdmin(validacao.user)) return NextResponse.json({ message: 'Sem permissão.' }, { status: 403 })

  try {
    const corpo = await parseJsonBody(req)
    if (!corpo.ok) return corpo.resposta
    const parsed = categoriaSchema.safeParse(corpo.data)
    if (!parsed.success) {
      return NextResponse.json({ message: parsed.error.errors[0]?.message ?? 'Dados inválidos.' }, { status: 400 })
    }

    const existe = await prisma.categoriaPatrimonio.findUnique({ where: { nome: parsed.data.nome } })
    if (existe) return NextResponse.json({ message: 'Já existe uma categoria com esse nome.' }, { status: 409 })

    const categoria = await prisma.categoriaPatrimonio.create({
      data: {
        nome: parsed.data.nome,
        descricao: parsed.data.descricao,
        icone: parsed.data.icone,
        ordem: parsed.data.ordem ?? 0,
        ativo: parsed.data.ativo ?? true,
      },
    })

    return NextResponse.json({ categoria }, { status: 201 })
  } catch (e) {
    console.error(e)
    return NextResponse.json({ message: 'Erro interno no servidor.' }, { status: 500 })
  }
}
