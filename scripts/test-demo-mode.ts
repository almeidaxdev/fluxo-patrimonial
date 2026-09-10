// scripts/test-demo-mode.ts
//
// Teste manual (mesmo padrão de scripts/test-email-config.ts) do guard
// central de DEMO_MODE (src/lib/demo-mode.ts). Cobre:
//   - DEMO_MODE=false (ou ausente): assertDemoActionAllowed() sempre libera
//     (comportamento normal preservado).
//   - DEMO_MODE=true: toda DemoAction é bloqueada com 403 + mensagem fixa.
//   - getDemoAccountEmail(): normalização e padrão.
//
// Modelo "dados mestres somente leitura" (revisão de hardening): o union
// DemoAction foi simplificado para bloqueio POR RECURSO inteiro
// (colaborador/patrimonio/categoria:mutar) — não existe mais uma lista de
// "campos sensíveis" nem um caso especial para a conta demonstrativa (ela é
// só mais um colaborador, e todo colaborador é somente-leitura na demo).
//
// Executar com: npm run test:demo-mode

export {}

let failures = 0

function assert(condition: boolean, label: string, detalhe?: unknown) {
  if (condition) {
    console.log(`OK   - ${label}`)
  } else {
    failures++
    console.error(`FALHA - ${label}${detalhe !== undefined ? ` (${JSON.stringify(detalhe)})` : ''}`)
  }
}

const TODAS_ACOES: Array<
  'colaborador:mutar' | 'patrimonio:mutar' | 'categoria:mutar' | 'auth:alterar-senha-propria' | 'auth:autocadastro'
> = ['colaborador:mutar', 'patrimonio:mutar', 'categoria:mutar', 'auth:alterar-senha-propria', 'auth:autocadastro']

async function main() {
  // --- DEMO_MODE ausente: comportamento normal preservado -----------------
  delete process.env.DEMO_MODE
  {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@/lib/demo-mode')
    assert(mod.isDemoModeAtivo() === false, 'DEMO_MODE ausente → isDemoModeAtivo() === false')
    for (const acao of TODAS_ACOES) {
      const resultado = mod.assertDemoActionAllowed(acao)
      assert(resultado === null, `DEMO_MODE ausente → assertDemoActionAllowed('${acao}') === null`)
    }
  }

  // --- DEMO_MODE="false" explícito: idêntico a ausente --------------------
  process.env.DEMO_MODE = 'false'
  {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@/lib/demo-mode')
    assert(mod.isDemoModeAtivo() === false, 'DEMO_MODE="false" → isDemoModeAtivo() === false')
  }

  // --- Variações que NÃO devem ativar o modo demo (comparação literal) ----
  for (const valorInvalido of ['TRUE', ' true', 'true ', '1', 'yes', '']) {
    process.env.DEMO_MODE = valorInvalido
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@/lib/demo-mode')
    assert(mod.isDemoModeAtivo() === false, `DEMO_MODE=${JSON.stringify(valorInvalido)} → isDemoModeAtivo() === false (comparação literal)`)
  }

  // --- DEMO_MODE="true": toda ação bloqueada com 403 + mensagem fixa ------
  process.env.DEMO_MODE = 'true'
  {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@/lib/demo-mode')
    assert(mod.isDemoModeAtivo() === true, 'DEMO_MODE="true" → isDemoModeAtivo() === true')

    for (const acao of TODAS_ACOES) {
      const resposta = mod.assertDemoActionAllowed(acao)
      assert(resposta !== null, `DEMO_MODE="true" → assertDemoActionAllowed('${acao}') bloqueia (não é null)`)
      assert(resposta.status === 403, `DEMO_MODE="true" → '${acao}' devolve HTTP 403`, resposta.status)
      const corpo = await resposta.json()
      assert(
        corpo.message === 'Ação desabilitada no ambiente de demonstração.',
        `DEMO_MODE="true" → '${acao}' devolve a mensagem fixa exigida`,
        corpo.message
      )
    }
  }

  // --- getDemoAccountEmail() -----------------------------------------------
  delete process.env.DEMO_ACCOUNT_EMAIL
  {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@/lib/demo-mode')
    assert(mod.getDemoAccountEmail() === 'admin@example.com', 'DEMO_ACCOUNT_EMAIL ausente → padrão admin@example.com')
  }

  process.env.DEMO_ACCOUNT_EMAIL = 'painel@example.com'
  {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@/lib/demo-mode')
    assert(mod.getDemoAccountEmail() === 'painel@example.com', 'DEMO_ACCOUNT_EMAIL customizado é respeitado')
  }

  delete process.env.DEMO_MODE
  delete process.env.DEMO_ACCOUNT_EMAIL

  console.log(`\n${failures === 0 ? '✅ Todos os testes passaram.' : `❌ ${failures} teste(s) falharam.`}`)
  if (failures > 0) process.exit(1)
}

main()
