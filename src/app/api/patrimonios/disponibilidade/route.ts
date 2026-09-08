// src/app/api/patrimonios/disponibilidade/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { getSession } from '@/lib/auth'
import { STATUS_BLOQUEIAM_DISPONIBILIDADE } from '@/lib/status'
import { PeriodoSolicitacao } from '@/types'
import { periodoEnum } from '@/lib/validations'
import { dataValida } from '@/lib/query-params'

// Um bem é considerado indisponível quando já existe solicitação com status
// bloqueante para a MESMA data e ao menos UM período em comum (Etapa 3 do
// plano de evolução — ver documento de arquitetura funcional).
//
// NOVO (Fase 3 — Etapa 4) — modo=imediato: usado pelo Atendimento Imediato,
// que não reserva data/período futuro (o atendimento já está acontecendo).
// Nesse modo, um bem só é considerado indisponível se estiver fisicamente
// em uso agora (status EM_UTILIZACAO, retirado e ainda não devolvido) —
// reservas futuras (PRONTA_RETIRADA, aguardando assinatura etc.) não
// bloqueiam o atendimento imediato, pois o bem ainda está fisicamente no
// Patrimônio até o momento da retirada agendada.
export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ message: 'Não autorizado.' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const categoriaId = searchParams.get('categoriaId')
  const modo = searchParams.get('modo')
  const excluirSolicitacaoId = searchParams.get('excluirSolicitacaoId') || undefined

  if (!categoriaId) {
    return NextResponse.json({ message: 'Categoria é obrigatória.' }, { status: 400 })
  }

  // Etapa security/input-hardening-b2: conjunto fechado de 2 valores
  // (ausente = modo normal, 'imediato' = Atendimento Imediato) — qualquer
  // outro valor é rejeitado explicitamente em vez de cair silenciosamente
  // no ramo normal (que exige data/período, então hoje já falharia de outro
  // jeito, mas sem uma mensagem que aponte a causa real).
  if (modo !== null && modo !== 'imediato') {
    return NextResponse.json({ message: 'Modo inválido.' }, { status: 400 })
  }

  // Etapa perf/system-optimization: a busca de conflitos (quem já está
  // ocupado/em uso) e a busca do catálogo de bens ativos da categoria são
  // independentes entre si — nenhuma depende do resultado da outra, então
  // rodam em paralelo em vez de sequencialmente. O filtro final
  // (`disponiveis = patrimonios.filter(...)`) só precisa dos dois resultados
  // já resolvidos, não importa a ordem em que chegaram.
  let promessaConflitos: Promise<{ itensPatrimonio: { patrimonioId: string }[] }[]>

  if (modo === 'imediato') {
    promessaConflitos = prisma.solicitacao.findMany({
      where: {
        status: 'EM_UTILIZACAO',
        ...(excluirSolicitacaoId ? { id: { not: excluirSolicitacaoId } } : {}),
      },
      select: { itensPatrimonio: { select: { patrimonioId: true } } },
    })
  } else {
    const data = searchParams.get('data')
    const periodosRaw = searchParams.getAll('periodo')
    const parsedPeriodos = z.array(periodoEnum).safeParse(periodosRaw)
    if (!parsedPeriodos.success) {
      return NextResponse.json({ message: 'Período inválido.' }, { status: 400 })
    }
    const periodosParam: PeriodoSolicitacao[] = parsedPeriodos.data

    if (!data || periodosParam.length === 0) {
      return NextResponse.json({ message: 'Categoria, data e ao menos um período são obrigatórios.' }, { status: 400 })
    }
    // Etapa security/input-hardening-b3: `new Date(data)` recebia qualquer
    // string não-vazia — um valor não-data virava `Invalid Date`, usado sem
    // checagem no filtro do Prisma logo abaixo.
    if (!dataValida(data)) {
      return NextResponse.json({ message: 'Data inválida.' }, { status: 400 })
    }

    const dataObj = new Date(data)
    dataObj.setUTCHours(0, 0, 0, 0)

    promessaConflitos = prisma.solicitacao.findMany({
      where: {
        data: dataObj,
        status: { in: STATUS_BLOQUEIAM_DISPONIBILIDADE },
        periodos: { hasSome: periodosParam },
        ...(excluirSolicitacaoId ? { id: { not: excluirSolicitacaoId } } : {}),
      },
      select: { itensPatrimonio: { select: { patrimonioId: true } } },
    })
  }

  const [solicitacoesConflitantes, patrimonios] = await Promise.all([
    promessaConflitos,
    prisma.patrimonio.findMany({
      where: { ativo: true, categoriaId },
      include: { categoria: true },
      orderBy: { numero: 'asc' },
    }),
  ])

  const idsIndisponiveis = new Set(
    solicitacoesConflitantes.flatMap((s) => s.itensPatrimonio.map((i) => i.patrimonioId))
  )
  const disponiveis = patrimonios.filter((p: { id: string }) => !idsIndisponiveis.has(p.id))

  return NextResponse.json({ patrimonios: disponiveis }, { status: 200 })
}
