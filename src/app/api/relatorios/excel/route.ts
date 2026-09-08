// src/app/api/relatorios/excel/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { autorizarRelatorios } from '@/lib/relatorios-auth'
import { obterDadosExcel, periodoLabel, filtrosAplicados, FiltroRelatorioInvalidoError } from '@/lib/relatorios'
import { gerarRelatorioExcel } from '@/lib/excel/relatorio-gerencial-excel'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Nome de arquivo seguro (sem caracteres especiais) a partir do filtro de período. */
function nomeArquivo(searchParams: URLSearchParams): string {
  const mes = searchParams.get('mes')
  if (mes) return `Relatorio_Patrimonio_${mes}.xlsx`

  const dataInicio = searchParams.get('dataInicio')
  const dataFim = searchParams.get('dataFim')
  if (dataInicio && dataFim) return `Relatorio_Patrimonio_${dataInicio}_a_${dataFim}.xlsx`
  if (dataInicio) return `Relatorio_Patrimonio_a_partir_de_${dataInicio}.xlsx`
  if (dataFim) return `Relatorio_Patrimonio_ate_${dataFim}.xlsx`

  return `Relatorio_Patrimonio_${new Date().toISOString().slice(0, 10)}.xlsx`
}

export async function GET(req: NextRequest) {
  const auth = await autorizarRelatorios()
  if (!auth.autorizado) return auth.resposta

  try {
    const { searchParams } = new URL(req.url)
    const [dadosExcel, filtros] = await Promise.all([
      obterDadosExcel(searchParams),
      filtrosAplicados(searchParams),
    ])
    const periodo = periodoLabel(searchParams)
    const geradoEm = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })

    const buffer = await gerarRelatorioExcel({ dadosExcel, periodo, filtros, geradoEm })

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${nomeArquivo(searchParams)}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    if (error instanceof FiltroRelatorioInvalidoError) {
      return NextResponse.json({ message: error.message }, { status: 400 })
    }
    console.error('Erro ao gerar Excel gerencial:', error)
    return NextResponse.json({ message: 'Não foi possível gerar o Excel.' }, { status: 500 })
  }
}
