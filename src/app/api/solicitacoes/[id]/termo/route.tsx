// src/app/api/solicitacoes/[id]/termo/route.tsx
//
// Termo de Retirada e Devolução (última funcionalidade V1) — PDF imprimível
// de UMA solicitação específica, para assinatura física na retirada e na
// devolução. Geração pura: não altera status, não cria histórico, não
// confirma retirada/devolução e não interfere no fluxo de assinatura
// eletrônica do empréstimo externo (finalidades diferentes, documentadas no
// próprio rodapé do PDF).
//
// Autorização: reaproveita EXATAMENTE autorizarRelatorios() (src/lib/
// relatorios-auth.ts) — já é a guarda usada para exports Patrimônio/Admin
// (isPatrimonioOuAdmin + reconsulta de `ativo`/`permissao` no banco a cada
// chamada, não confia só na claim do JWT). Evita duplicar a mesma checagem
// de autorização em dois lugares.
//
// Dados: a rota recebe SOMENTE o id da solicitação via path param — todo o
// conteúdo do termo vem de uma consulta própria ao banco (nunca do body/query
// do cliente), com `select` explícito (nunca a Solicitacao inteira) contendo
// apenas os campos que o PDF usa.
import React from 'react'
import { NextRequest, NextResponse } from 'next/server'
import { renderToBuffer } from '@react-pdf/renderer'
import { prisma } from '@/lib/prisma'
import { autorizarRelatorios } from '@/lib/relatorios-auth'
import { TermoRetiradaDevolucaoPdf, SELECT_TERMO } from '@/lib/pdf/termo-retirada-devolucao'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Mesmo alias server-only de src/app/api/relatorios/pdf/route.tsx.
const nodeReact = require('react-pdf-react') as typeof React

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await autorizarRelatorios()
  if (!auth.autorizado) return auth.resposta

  const { id } = await params

  try {
    const solicitacao = await prisma.solicitacao.findUnique({ where: { id }, select: SELECT_TERMO })
    if (!solicitacao) return NextResponse.json({ message: 'Solicitação não encontrada.' }, { status: 404 })

    const documento = nodeReact.createElement(TermoRetiradaDevolucaoPdf, { solicitacao })
    const buffer = await renderToBuffer(documento as React.ReactElement<any>)

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        // inline (não attachment): o objetivo é imprimir a partir do próprio
        // visualizador do navegador — ver botão "Imprimir Termo" na tela de
        // detalhe, que abre esta resposta em nova aba.
        'Content-Disposition': `inline; filename="termo-solicitacao-${solicitacao.numero}.pdf"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    console.error('Erro ao gerar termo de retirada e devolução:', error)
    return NextResponse.json({ message: 'Não foi possível gerar o termo.' }, { status: 500 })
  }
}
