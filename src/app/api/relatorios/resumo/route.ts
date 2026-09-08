import { NextRequest, NextResponse } from 'next/server'
import { autorizarRelatorios } from '@/lib/relatorios-auth'
import { obterDadosRelatorio, FiltroRelatorioInvalidoError } from '@/lib/relatorios'

export async function GET(req: NextRequest) {
  const auth = await autorizarRelatorios()
  if (!auth.autorizado) return auth.resposta

  try {
    const { searchParams } = new URL(req.url)
    return NextResponse.json(await obterDadosRelatorio(searchParams), { status: 200 })
  } catch (e) {
    if (e instanceof FiltroRelatorioInvalidoError) {
      return NextResponse.json({ message: e.message }, { status: 400 })
    }
    console.error(e)
    return NextResponse.json({ message: 'Não foi possível gerar o relatório.' }, { status: 500 })
  }
}
