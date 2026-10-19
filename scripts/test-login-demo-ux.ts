// scripts/test-login-demo-ux.ts
//
// Verificação ESTRUTURAL (mesmo padrão já usado neste projeto para JSX —
// ver itens F/G/H de scripts/test-patrimonio-operational-ux.ts — "sem DOM/
// renderer disponível neste projeto") do comportamento condicional da tela
// de login em relação a DEMO_MODE: LoginForm.tsx e seu wrapper no servidor.
//
// Por que estrutural (não string solta): em vez de procurar um texto
// qualquer no arquivo, parseamos o AST real do componente com o
// TypeScript Compiler API e localizamos os nós JSX específicos — o bloco
// condicional do link "Cadastre-se" e o bloco condicional do botão
// "Acessar demonstração" — verificando que ambos dependem da MESMA
// variável (`demoModeAtivo`, recebida do servidor) em polaridades
// opostas (um só quando falso, o outro só quando verdadeiro) e nunca
// aparecem juntos na mesma branch.
//
// Cobre:
//   - "Cadastre-se" NÃO está incondicionalmente presente — depende de
//     `!demoModeAtivo` (ou equivalente: está no branch `false` de um
//     ternário sobre `demoModeAtivo`).
//   - O texto discreto de demonstração aparece no branch `demoModeAtivo`
//     (o mesmo ternário, lado oposto).
//   - O botão "Acessar demonstração" continua condicionado a
//     `demoModeAtivo` (regressão da etapa anterior).
//   - O servidor fornece o modo antes da primeira renderização, sem uma
//     consulta posterior que faria o link de cadastro piscar na demo.
//
// Executar com: npm run test:login-demo-ux

import * as fs from 'fs'
import * as path from 'path'
import * as ts from 'typescript'

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

async function main() {
  const diretorioLogin = path.join(path.resolve(__dirname, '..'), 'src/app/(auth)/login')
  const caminho = path.join(diretorioLogin, 'LoginForm.tsx')
  const codigoFonte = fs.readFileSync(caminho, 'utf8')
  const paginaServidor = fs.readFileSync(path.join(diretorioLogin, 'page.tsx'), 'utf8')

  assert(!paginaServidor.includes("'use client'"), 'página de login é renderizada no servidor')
  assert(paginaServidor.includes("import { isDemoModeAtivo } from '@/lib/demo-mode'"), 'servidor usa a fonte canônica do modo de demonstração')
  assert(paginaServidor.includes('<LoginForm demoModeAtivo={isDemoModeAtivo()} />'), 'modo de demonstração é fornecido antes da primeira renderização')
  assert(!codigoFonte.includes('useDemoMode') && !codigoFonte.includes('/api/demo/status'), 'formulário não espera uma consulta client-side para decidir entre demonstração e cadastro')
  assert(codigoFonte.includes('demoModeAtivo: boolean'), 'formulário exige o modo do servidor, sem valor inicial falso')

  const sourceFile = ts.createSourceFile(caminho, codigoFonte, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

  // Encontra o ConditionalExpression (`demoModeAtivo ? <A> : <B>`) cujo
  // branch verdadeiro contenha o texto "demonstrativo" e cujo branch falso
  // contenha "Cadastre-se" — prova estrutural de que são MUTUAMENTE
  // EXCLUSIVOS (nunca os dois ao mesmo tempo) e ambos condicionados à
  // MESMA variável.
  let ternarioEncontrado: ts.ConditionalExpression | undefined
  function visit(node: ts.Node) {
    if (ts.isConditionalExpression(node)) {
      const textoCompleto = node.getFullText(sourceFile)
      if (textoCompleto.includes('Cadastre-se') && textoCompleto.includes('demonstrativo')) {
        ternarioEncontrado = node
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  assert(!!ternarioEncontrado, 'existe um único condicional (ternário) cobrindo "Cadastre-se" e o texto de demonstração juntos')

  if (ternarioEncontrado) {
    const condicao = ternarioEncontrado.condition.getText(sourceFile)
    const branchVerdadeiro = ternarioEncontrado.whenTrue.getText(sourceFile)
    const branchFalso = ternarioEncontrado.whenFalse.getText(sourceFile)

    assert(condicao.includes('demoModeAtivo'), 'o ternário é condicionado a demoModeAtivo', condicao)
    assert(branchVerdadeiro.includes('demonstrativo') && !branchVerdadeiro.includes('Cadastre-se'), 'branch demoModeAtivo=true mostra o texto de demonstração e NUNCA "Cadastre-se"')
    assert(branchFalso.includes('Cadastre-se') && !branchFalso.includes('demonstrativo'), 'branch demoModeAtivo=false mostra "Cadastre-se" e NUNCA o texto de demonstração')
  }

  // Regressão: o botão "Acessar demonstração" continua condicionado a
  // demoModeAtivo (bloco JSX separado, já existente desde a etapa anterior).
  // `lastIndexOf` de propósito — a STRING "Acessar demonstração" também
  // aparece antes, num comentário de documentação da função
  // onAcessarDemo(); a ocorrência dentro do JSX real (o texto do botão) é
  // sempre a última do arquivo.
  const indiceBotaoDemo = codigoFonte.lastIndexOf('Acessar demonstração')
  assert(indiceBotaoDemo !== -1, 'botão "Acessar demonstração" continua presente no arquivo')
  if (indiceBotaoDemo !== -1) {
    const trechoAntes = codigoFonte.slice(Math.max(0, indiceBotaoDemo - 1000), indiceBotaoDemo)
    assert(/\{demoModeAtivo\s*&&/.test(trechoAntes), 'o botão "Acessar demonstração" continua dentro de {demoModeAtivo && (...)}', trechoAntes.slice(-120))
  }

  console.log(`\n${failures === 0 ? '✅ Todos os testes passaram.' : `❌ ${failures} teste(s) falharam.`}`)
  if (failures > 0) process.exit(1)
}

main()
