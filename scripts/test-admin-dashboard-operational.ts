// scripts/test-admin-dashboard-operational.ts
//
// Etapa feat/admin-dashboard-operational — o Dashboard do Administrador
// passa a ter duas seções claras ("Minha atividade" pessoal + "Operação do
// Patrimônio", REAPROVEITANDO o mesmo componente já homologado para o
// perfil PATRIMONIO — `OperacaoPatrimonio.tsx`) em vez de uma versão própria
// e desatualizada dos cards operacionais.
//
// Cobre:
//   A) Admin mantém TODOS os cards/ações pessoais (Nova Solicitação,
//      Minhas Solicitações em andamento, Assinaturas pendentes, Prontas
//      para retirada, aprovações quando aplicável) — nada removido.
//   B) Sidebar continua listando "Nova Solicitação"/"Minhas Solicitações"
//      para `administrador` (regra exclusiva de PATRIMONIO, nunca do
//      Admin — ver Etapa feat/patrimonio-operational-ux).
//   C) A seção operacional do Admin usa o MESMO componente compartilhado
//      (`OperacaoPatrimonio`) do Painel do Patrimônio — nunca uma segunda
//      implementação dos cards/contador/prioridades.
//   D) O contador de atenção do Admin usa a MESMA função pura
//      (`calcularTotalAtencaoPatrimonio`) — mesma composição (5 estados,
//      nunca inventário, nunca `aguardandoAssinatura`), testada aqui
//      diretamente com valores sintéticos.
//   E) COLABORADOR/GESTOR não ganham a seção operacional (só ADMINISTRADOR
//      e PATRIMONIO) — `lobby/page.tsx` não a renderiza para eles.
//   F) Nenhuma duplicação de regra operacional: `lobby/page.tsx` não
//      hardcoda nenhum dos 5 status de ação diretamente — toda a lógica
//      vem de `OperacaoPatrimonio`/`calcularTotalAtencaoPatrimonio`,
//      importados, nunca reimplementados.
//   G) O Painel do Patrimônio (perfil PATRIMONIO) continua com o mesmo
//      título/saudação de página inteira já homologados — regressão visual
//      estrutural (o wrapper fino não perdeu nada do comportamento antigo).
//   H) `PatrimonioStats` (o contrato de dados) não inclui mais os campos
//      antigos (`aguardandoAssinatura`, `internos`, `externos`) — nenhuma
//      das duas telas os consome mais.
//
// Verificação estrutural do arquivo-fonte (mesmo padrão já usado em
// scripts/test-patrimonio-operational-ux.ts) — sem DOM/renderer disponível
// neste projeto. D chama a função pura real diretamente.
//
// Executar com: npm run test:admin-dashboard-operational

import { readFileSync } from 'fs'
import { join } from 'path'

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
  const lobbyPath = join(__dirname, '..', 'src', 'app', '(dashboard)', 'lobby', 'page.tsx')
  const painelPath = join(__dirname, '..', 'src', 'app', '(dashboard)', 'lobby', 'PainelPatrimonio.tsx')
  const operacaoPath = join(__dirname, '..', 'src', 'app', '(dashboard)', 'lobby', 'OperacaoPatrimonio.tsx')
  const sidebarPath = join(__dirname, '..', 'src', 'components', 'layout', 'Sidebar.tsx')

  const lobby = readFileSync(lobbyPath, 'utf8')
  const painel = readFileSync(painelPath, 'utf8')
  const operacao = readFileSync(operacaoPath, 'utf8')
  const sidebar = readFileSync(sidebarPath, 'utf8')

  // ===========================================================================
  // Parte A — Admin mantém os cards/ações pessoais
  // ===========================================================================

  assert(lobby.includes("label: 'Minhas solicitações em andamento'"), 'A) card pessoal "Minhas solicitações em andamento" preservado', true)
  assert(lobby.includes("label: 'Assinaturas pendentes'"), 'A) card pessoal "Assinaturas pendentes" preservado', true)
  // Etapa feat/admin-dashboard-operational (homologação pós-entrega): os 3
  // cards pessoais quantitativos passaram a abrir /minhas-solicitacoes JÁ
  // FILTRADO (ver scripts/test-dashboard-personal-filters.ts para a
  // cobertura completa dessa mudança) — aqui só confirma que o card em si
  // não foi removido/renomeado.
  assert(lobby.includes("label: 'Prontas para retirada'") && lobby.includes("href: '/minhas-solicitacoes?status=PRONTA_RETIRADA'"), 'A) card pessoal "Prontas para retirada" preservado (agora com filtro real)', true)
  assert(lobby.includes("label: 'Atividades externas'") && lobby.includes("href: '/aprovacoes'"), 'A) card condicional de aprovações preservado', true)
  assert(lobby.includes("label: 'Nova Solicitação'") && lobby.includes("href: '/nova-solicitacao'"), 'A) atalho "Nova Solicitação" preservado', true)
  assert(lobby.includes('Minhas solicitações recentes'), 'A) bloco "Minhas solicitações recentes" preservado', true)
  assert(lobby.includes('Minha atividade'), 'A) seção pessoal agora tem um rótulo próprio ("Minha atividade")', true)

  // ===========================================================================
  // Parte B — Sidebar: Nova Solicitação/Minhas Solicitações continuam para Admin
  // ===========================================================================

  {
    const blocoNova = sidebar.slice(sidebar.indexOf("href: '/nova-solicitacao'"), sidebar.indexOf("href: '/minhas-solicitacoes'"))
    assert(/roles: \[[^\]]*'administrador'[^\]]*\]/.test(blocoNova), 'B) "Nova Solicitação" continua nos roles de administrador no Sidebar', true)
    assert(!/roles: \[[^\]]*'patrimonio'[^\]]*\]/.test(blocoNova), 'B) "Nova Solicitação" continua SEM "patrimonio" nos roles (regra já homologada, não regredida)', true)
  }

  // ===========================================================================
  // Parte C — seção operacional do Admin usa o componente COMPARTILHADO
  // ===========================================================================

  assert(/import\s*\{[^}]*OperacaoPatrimonio[^}]*\}\s*from\s*'\.\/OperacaoPatrimonio'/.test(lobby), 'C) lobby/page.tsx importa OperacaoPatrimonio (componente compartilhado)', true)
  assert(/<OperacaoPatrimonio\s+stats=/.test(lobby), 'C) lobby/page.tsx renderiza <OperacaoPatrimonio /> na seção operacional', true)
  assert(lobby.includes('Operação do Patrimônio'), 'C) seção operacional do Admin tem rótulo próprio ("Operação do Patrimônio")', true)
  assert(/export function OperacaoPatrimonio/.test(operacao), 'C) OperacaoPatrimonio.tsx exporta o componente compartilhado de verdade', true)

  // ===========================================================================
  // Parte D — contador de atenção: mesma função pura, mesma composição
  // ===========================================================================

  {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { calcularTotalAtencaoPatrimonio } = require('../src/lib/patrimonio-dashboard')
    const stats = { aguardandoAnalise: 2, emSeparacao: 3, prontasRetirada: 1, emUtilizacao: 4, aguardandoDevolucao: 4, naoRetiradas: 1, bensTotal: 100, bensAtivos: 90 }
    const total = calcularTotalAtencaoPatrimonio(stats)
    assert(total === 2 + 3 + 1 + 4 + 1, 'D) calcularTotalAtencaoPatrimonio() soma exatamente os 5 estados de ação (2+3+1+4+1=11)', total)
    assert(/calcularTotalAtencaoPatrimonio/.test(lobby), 'D) lobby/page.tsx reaproveita a MESMA função para o contador do Admin (nunca recalcula à parte)', true)
    assert(/calcularTotalAtencaoPatrimonio/.test(painel), 'D) PainelPatrimonio.tsx reaproveita a MESMA função (nunca uma segunda definição)', true)
  }

  // ===========================================================================
  // Parte E — só ADMINISTRADOR/PATRIMONIO veem a seção operacional
  // ===========================================================================

  assert(/mostrarOperacaoPatrimonio\s*=\s*user\?\.permissao === 'administrador'/.test(lobby), "E) seção operacional do Admin é exibida só quando permissao === 'administrador'", true)
  assert(/\{mostrarOperacaoPatrimonio && \(/.test(lobby), 'E) a renderização da seção operacional é de fato condicionada a esse flag', true)

  // ===========================================================================
  // Parte F — nenhuma duplicação de regra operacional em lobby/page.tsx
  // ===========================================================================

  {
    // Etapa feat/admin-dashboard-operational (homologação pós-entrega):
    // "PRONTA_RETIRADA" passou a aparecer LEGITIMAMENTE em lobby/page.tsx —
    // é o filtro real do card PESSOAL "Prontas para retirada"
    // (/minhas-solicitacoes?status=PRONTA_RETIRADA), um contexto
    // inteiramente diferente da seção operacional do Patrimônio. O risco
    // real de duplicação que esta parte cobre é lobby/page.tsx reimplementar
    // a rota OPERACIONAL (/todas-solicitacoes?status=...) por conta própria
    // — isso nunca deve acontecer, delegado inteiramente a OperacaoPatrimonio.
    assert(!/\/todas-solicitacoes\?status=/.test(lobby), 'F) lobby/page.tsx nunca hardcoda /todas-solicitacoes?status=... (rota operacional delegada inteiramente a OperacaoPatrimonio)', true)
    const statusDeAcaoOperacional = ['AGUARDANDO_PATRIMONIO', 'EM_SEPARACAO', 'EM_UTILIZACAO', 'NAO_RETIRADA']
    for (const status of statusDeAcaoOperacional) {
      assert(!lobby.includes(status), `F) lobby/page.tsx não hardcoda o status operacional "${status}" (delegado inteiramente a OperacaoPatrimonio)`, true)
    }
  }

  // ===========================================================================
  // Parte G — Painel do Patrimônio (perfil PATRIMONIO) sem regressão visual
  // ===========================================================================

  assert(painel.includes('Painel do Patrimônio'), 'G) PainelPatrimonio.tsx mantém o título de página inteira "Painel do Patrimônio"', true)
  assert(/itens precisam/.test(painel) && /item precisa/.test(painel) && painel.includes('de atenção'), 'G) PainelPatrimonio.tsx mantém a frase de saudação com a contagem de atenção (singular/plural)', true)
  assert(/<OperacaoPatrimonio stats=\{stats\} \/>/.test(painel), 'G) PainelPatrimonio.tsx delega a parte operacional ao componente compartilhado', true)

  // ===========================================================================
  // Parte H — contrato de dados sem os campos antigos
  // ===========================================================================

  {
    const libPath = join(__dirname, '..', 'src', 'lib', 'patrimonio-dashboard.ts')
    const lib = readFileSync(libPath, 'utf8')
    const interfaceMatch = lib.match(/export interface PatrimonioStats \{([^}]*)\}/)
    assert(!!interfaceMatch, 'H) PatrimonioStats está definida em src/lib/patrimonio-dashboard.ts (única fonte do contrato, sem JSX)', true)
    const corpoInterface = interfaceMatch ? interfaceMatch[1] : ''
    assert(!corpoInterface.includes('aguardandoAssinatura'), 'H) PatrimonioStats não inclui mais "aguardandoAssinatura" (aguardando ação de terceiro)', true)
    assert(!corpoInterface.includes('internos') && !corpoInterface.includes('externos'), 'H) PatrimonioStats não inclui mais "internos"/"externos" (métrica de relatório, não pendência)', true)
    assert(/from '@\/lib\/patrimonio-dashboard'/.test(operacao), 'H) OperacaoPatrimonio.tsx importa o contrato de src/lib/patrimonio-dashboard.ts (nunca redefine)', true)
  }

  console.log('')
  if (failures > 0) {
    console.error(`${failures} verificação(ões) falharam.`)
    process.exit(1)
  } else {
    console.log('Todas as verificações passaram.')
  }
}

main().catch((e) => {
  console.error('Erro inesperado ao rodar os testes:', e)
  process.exit(1)
})
