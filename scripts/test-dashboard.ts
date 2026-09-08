// scripts/test-dashboard.ts
//
// Teste manual (mesmo padrão dos demais scripts/test-*.ts) da Etapa
// perf/system-optimization: GET /api/dashboard deixou de fazer
// `prisma.user.findUnique` (usava `session.id`/`session.podeSerGestor`, já
// disponíveis no JWT, só para reler o mesmo dado do banco) e passou a
// disparar TODAS as contagens — fixas e condicionais (aprovações/Patrimônio)
// — num ÚNICO Promise.all, em vez de até 3 estágios sequenciais (findUnique
// → Promise.all de 4 → count condicional → Promise.all condicional de 9).
//
// Importa e chama o handler GET REAL da rota — prisma e getSession são
// mocks em memória. Cada chamada de prisma é registrada num log, para provar
// por evidência (não só leitura de código):
// - prisma.user.findUnique NUNCA é chamado;
// - o número de round-trips reais ao "banco" é exatamente o esperado por
//   papel (nunca mais do que o necessário para aquele papel);
// - o formato/conteúdo do payload retornado é idêntico ao contrato anterior.
//
// Não abre conexão real com o banco.
//
// Executar com: npm run test:dashboard

// Torna este arquivo um MÓDULO aos olhos do TypeScript (nunca um script
// solto) — sem isso, `npx tsc --noEmit` compila todos os scripts/*.ts
// sem `import` num único escopo global compartilhado, e as declarações
// top-level (prisma, authModule, failures, assert...) colidem com as de
// outros scripts igualmente sem import (ex.: test-patrimonios-pagination.ts).
// `ts-node --project scripts/tsconfig.json` (como cada script roda de
// verdade, um de cada vez) nunca sofre esse problema — é específico do
// `tsc --noEmit` compilando o projeto inteiro de uma vez.
export {}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { prisma } = require('../src/lib/prisma')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const authModule = require('../src/lib/auth')

let failures = 0

function assert(condition: boolean, label: string, detalhe?: unknown) {
  if (condition) {
    console.log(`OK   - ${label}`)
  } else {
    failures++
    console.error(`FALHA - ${label}${detalhe !== undefined ? ` (${JSON.stringify(detalhe)})` : ''}`)
  }
}

let chamadas: string[]
let userFindUniqueChamado: boolean

function instalarMockPrisma() {
  chamadas = []
  userFindUniqueChamado = false

  prisma.user = {
    findUnique: async () => {
      // Não deve ser chamado nesta rota (Etapa perf/system-optimization) —
      // se for, o teste falha explicitamente em vez de silenciosamente
      // devolver um usuário fake que mascararia a regressão.
      userFindUniqueChamado = true
      throw new Error('prisma.user.findUnique NÃO deveria ser chamado por GET /api/dashboard.')
    },
  }

  prisma.solicitacao = {
    count: async ({ where }: { where: Record<string, unknown> }) => {
      chamadas.push(`solicitacao.count(${JSON.stringify(where)})`)
      // Valor determinístico e distinto por filtro, para o teste conseguir
      // provar que cada contagem chega ao campo certo do payload (não só
      // "algum número apareceu").
      return chamadas.length
    },
    findMany: async (_args: unknown) => {
      chamadas.push('solicitacao.findMany(recentes)')
      return [{ id: 'sol-1', numero: 10, status: 'AGUARDANDO_PATRIMONIO', data: new Date('2026-09-01'), tipoEmprestimo: 'interno' }]
    },
  }

  prisma.patrimonio = {
    count: async ({ where }: { where?: Record<string, unknown> } = {}) => {
      chamadas.push(`patrimonio.count(${JSON.stringify(where ?? {})})`)
      return chamadas.length
    },
  }
}

async function chamarDashboard() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rota = require('../src/app/api/dashboard/route')
  const res = await rota.GET()
  return { res, body: await res.json() }
}

function instalarMockGetSession(sessao: { id: string; nome: string; email: string; permissao: 'colaborador' | 'patrimonio' | 'administrador'; podeSerGestor: boolean }) {
  authModule.getSession = async () => ({ ...sessao })
}

async function main() {
  // --- A) colaborador comum (sem podeSerGestor, sem permissão de Patrimônio)
  instalarMockPrisma()
  instalarMockGetSession({ id: 'user-colab', nome: 'Colaborador', email: 'colab@example.com', permissao: 'colaborador', podeSerGestor: false })
  {
    const { res, body } = await chamarDashboard()
    assert(res.status === 200, 'A) resposta 200', res.status)
    assert(!userFindUniqueChamado, 'A) prisma.user.findUnique NUNCA é chamado', userFindUniqueChamado)
    assert(chamadas.length === 4, 'A) exatamente 4 round-trips reais (3 counts + 1 findMany) — nenhuma query condicional é disparada', chamadas)
    assert('minhasPendentes' in body && 'minhasAssinaturaPendente' in body && 'minhasProntas' in body && 'minhasRecentes' in body, 'A) payload traz os 4 campos fixos', body)
    assert(!('aprovacoesPendentes' in body), 'A) sem podeSerGestor, aprovacoesPendentes NÃO aparece no payload', body)
    assert(!('patrimonio' in body), 'A) sem permissão de Patrimônio, a chave patrimonio NÃO aparece no payload', body)
    assert(Array.isArray(body.minhasRecentes) && body.minhasRecentes.length === 1, 'A) minhasRecentes reflete o findMany mockado', body.minhasRecentes)
    // Etapa feat/admin-dashboard-operational (homologação): "em andamento"
    // usa STATUS_EM_ANDAMENTO_SOLICITANTE (whitelist explícita) em vez do
    // `notIn` anterior — a MESMA lista que o card pessoal equivalente usa de
    // verdade em GET /api/solicitacoes?status=EM_ANDAMENTO (ver
    // scripts/test-dashboard-personal-filters.ts).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { STATUS_EM_ANDAMENTO_SOLICITANTE } = require('../src/lib/status')
    assert(
      chamadas[0] === `solicitacao.count(${JSON.stringify({ solicitanteId: 'user-colab', status: { in: STATUS_EM_ANDAMENTO_SOLICITANTE } })})`,
      'A) minhasPendentes usa status: { in: STATUS_EM_ANDAMENTO_SOLICITANTE } (fonte única, nunca um notIn paralelo)',
      chamadas[0]
    )
  }

  // --- B) gestor (podeSerGestor=true, permissao=colaborador) --------------
  instalarMockPrisma()
  instalarMockGetSession({ id: 'user-gestor', nome: 'Gestor', email: 'gestor@example.com', permissao: 'colaborador', podeSerGestor: true })
  {
    const { res, body } = await chamarDashboard()
    assert(res.status === 200, 'B) resposta 200', res.status)
    assert(!userFindUniqueChamado, 'B) prisma.user.findUnique NUNCA é chamado', userFindUniqueChamado)
    assert(chamadas.length === 5, 'B) exatamente 5 round-trips (4 fixos + 1 de aprovacoesPendentes)', chamadas)
    assert('aprovacoesPendentes' in body, 'B) com podeSerGestor, aprovacoesPendentes aparece no payload', body)
    assert(!('patrimonio' in body), 'B) ainda sem permissão de Patrimônio, a chave patrimonio NÃO aparece', body)
  }

  // --- C) Patrimônio (permissao=patrimonio, sem podeSerGestor) -------------
  instalarMockPrisma()
  instalarMockGetSession({ id: 'user-pat', nome: 'Patrimônio', email: 'pat@example.com', permissao: 'patrimonio', podeSerGestor: false })
  {
    const { res, body } = await chamarDashboard()
    assert(res.status === 200, 'C) resposta 200', res.status)
    assert(!userFindUniqueChamado, 'C) prisma.user.findUnique NUNCA é chamado', userFindUniqueChamado)
    // Etapa feat/admin-dashboard-operational: -3 round-trips (14→11) e -3
    // campos (`aguardandoAssinatura`, `internos`, `externos`) — só
    // alimentavam a versão ANTIGA da seção operacional do Admin, removida
    // nesta etapa (Admin agora usa o MESMO componente compartilhado
    // `OperacaoPatrimonio`, que nunca leu esses 3 campos — ver
    // lobby/OperacaoPatrimonio.tsx).
    assert(chamadas.length === 11, 'C) exatamente 11 round-trips (4 fixos + 7 de Patrimônio)', chamadas)
    assert(!('aprovacoesPendentes' in body), 'C) sem podeSerGestor, aprovacoesPendentes NÃO aparece', body)
    assert('patrimonio' in body, 'C) com permissão de Patrimônio, a chave patrimonio aparece', body)
    const camposEsperados = ['aguardandoAnalise', 'emSeparacao', 'prontasRetirada', 'emUtilizacao', 'aguardandoDevolucao', 'naoRetiradas', 'bensTotal', 'bensAtivos']
    assert(camposEsperados.every((c) => c in body.patrimonio), 'C) payload.patrimonio traz todos os 8 campos do contrato atual', body.patrimonio)
    assert(!('aguardandoAssinatura' in body.patrimonio) && !('internos' in body.patrimonio) && !('externos' in body.patrimonio), 'C) campos antigos (aguardandoAssinatura/internos/externos) não aparecem mais', body.patrimonio)
    assert(body.patrimonio.aguardandoDevolucao === body.patrimonio.emUtilizacao, 'C) aguardandoDevolucao continua espelhando emUtilizacao (mesmo contrato de antes)', body.patrimonio)
  }

  // --- D) administrador com podeSerGestor=true → os dois blocos aparecem ---
  instalarMockPrisma()
  instalarMockGetSession({ id: 'user-admin', nome: 'Admin', email: 'admin@example.com', permissao: 'administrador', podeSerGestor: true })
  {
    const { res, body } = await chamarDashboard()
    assert(res.status === 200, 'D) resposta 200', res.status)
    assert(!userFindUniqueChamado, 'D) prisma.user.findUnique NUNCA é chamado', userFindUniqueChamado)
    // Etapa feat/admin-dashboard-operational: -3 round-trips (15→12), mesmo
    // motivo do cenário C acima.
    assert(chamadas.length === 12, 'D) exatamente 12 round-trips (4 fixos + 1 aprovacoes + 7 Patrimônio) — o máximo possível, nunca mais que isso', chamadas)
    assert('aprovacoesPendentes' in body && 'patrimonio' in body, 'D) ambos os blocos condicionais aparecem juntos quando as duas condições são verdadeiras', body)
  }

  // --- E) sem sessão → 401, nenhuma query é disparada ------------------------
  instalarMockPrisma()
  authModule.getSession = async () => null
  {
    const { res } = await chamarDashboard()
    assert(res.status === 401, 'E) sem sessão retorna 401', res.status)
    assert(chamadas.length === 0, 'E) nenhuma query é disparada sem sessão válida', chamadas)
  }

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) de GET /api/dashboard falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes de GET /api/dashboard passaram. Nenhum banco real foi acessado.')
}

main().catch((err) => {
  console.error('Falha inesperada ao executar os testes de dashboard:', err instanceof Error ? err.message : err)
  process.exit(1)
})
