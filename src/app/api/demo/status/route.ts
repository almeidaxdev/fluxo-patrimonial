// src/app/api/demo/status/route.ts
//
// Endpoint público (sem sessão) que só informa se o ambiente atual é uma
// demonstração — usado pela tela de login para decidir se mostra o botão
// "Acessar demonstração" (ver src/app/(auth)/login/page.tsx). Única fonte
// de verdade sobre DEMO_MODE no client: evita duplicar a leitura da
// variável de ambiente numa NEXT_PUBLIC_* separada, que poderia divergir do
// valor real usado pelo servidor.
//
// Nunca revela nada além do booleano — não é um endpoint de diagnóstico.
// Isento do gate de sessão em src/middleware.ts (PUBLIC_DEMO_API_ROUTES) —
// precisa responder ANTES de existir qualquer cookie/sessão.
import { NextResponse } from 'next/server'
import { isDemoModeAtivo } from '@/lib/demo-mode'

export async function GET() {
  return NextResponse.json({ enabled: isDemoModeAtivo() }, { status: 200 })
}
