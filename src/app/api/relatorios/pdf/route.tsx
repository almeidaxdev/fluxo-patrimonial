import React from 'react'
import { NextRequest, NextResponse } from 'next/server'
import { renderToBuffer } from '@react-pdf/renderer'
import { autorizarRelatorios } from '@/lib/relatorios-auth'
import { obterDadosRelatorio, obterDetalhamentoRelatorio, periodoLabel, filtrosAplicados, FiltroRelatorioInvalidoError } from '@/lib/relatorios'
import { RelatorioGerencialPdf } from '@/lib/pdf/relatorio-gerencial'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Alias server-only configurado em next.config.js para evitar o React Server
// Runtime vendorizado pelo App Router ao criar a árvore do react-pdf.
const nodeReact = require('react-pdf-react') as typeof React

export async function GET(req: NextRequest) {
  const auth = await autorizarRelatorios()
  if (!auth.autorizado) return auth.resposta

  try {
    const { searchParams } = new URL(req.url)
    const [dados, detalhes, filtros] = await Promise.all([
      obterDadosRelatorio(searchParams),
      obterDetalhamentoRelatorio(searchParams, 15),
      filtrosAplicados(searchParams),
    ])
    const periodo = periodoLabel(searchParams)
    const geradoEm = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
    const documento = nodeReact.createElement(RelatorioGerencialPdf, { dados, detalhes, periodo, filtros, geradoEm })
    const buffer = await renderToBuffer(documento as React.ReactElement<any>)
    const sufixo = searchParams.get('mes') ?? new Date().toISOString().slice(0, 10)
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="relatorio-gerencial-${sufixo}.pdf"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    if (error instanceof FiltroRelatorioInvalidoError) {
      return NextResponse.json({ message: error.message }, { status: 400 })
    }
    console.error('Erro ao gerar PDF gerencial:', error)
    return NextResponse.json({ message: 'Não foi possível gerar o PDF.' }, { status: 500 })
  }
}
