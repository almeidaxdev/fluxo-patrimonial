// src/hooks/use-demo-mode.ts
//
// Hook client-side puramente de UX (ver docs/DEMO_MODE.md): informa se o
// ambiente atual é a demonstração pública, para mostrar/ocultar o botão
// "Acessar demonstração" e desabilitar/anotar controles de ações
// bloqueadas ("Indisponível na demonstração"). NUNCA é a proteção real —
// isso é sempre server-side (src/lib/demo-mode.ts, checado em cada rota).
// Mesmo que este hook falhe/retorne desatualizado, nenhuma ação bloqueada
// deixa de ser bloqueada de verdade.
'use client'

import { useEffect, useState } from 'react'

export function useDemoMode(): boolean {
  const [demoModeAtivo, setDemoModeAtivo] = useState(false)

  useEffect(() => {
    let cancelado = false
    fetch('/api/demo/status')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelado && data) setDemoModeAtivo(!!data.demoModeAtivo)
      })
      .catch(() => {
        // Falha de rede: mantém o padrão (false) — nunca esconde/desabilita
        // nada por engano numa instância que na verdade não é demo.
      })
    return () => {
      cancelado = true
    }
  }, [])

  return demoModeAtivo
}
