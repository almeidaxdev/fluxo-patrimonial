// scripts/test-patrimonios-pagination.ts
//
// Teste manual (mesmo padrão dos demais scripts/test-*.ts) da Etapa
// fix/patrimonios-pagination: GET /api/patrimonios já suportava page/limit
// (default limit=15) — o bug era exclusivamente na tela
// src/app/(dashboard)/patrimonios/page.tsx, que nunca enviava esses
// parâmetros e por isso sempre recebia só os 15 primeiros bens (skip=0).
// A API em si NÃO foi alterada nesta etapa; este script existe para
// confirmar por evidência (não só leitura de código) que o contrato que a
// tela agora depende — paginação real via page/limit, total no corpo da
// resposta — já funciona corretamente na rota.
//
// Importa e chama o handler GET REAL da rota — prisma (`patrimonio` e,
// desde a Etapa security/session-revocation, `user` — a rota revalida a
// sessão via getValidatedMutationSession()) e getSession são mocks em
// memória. Não abre conexão real com o banco.
//
// Cobre os itens A-C do pedido (paginação em si, na API). Os itens D-J
// (Anterior/Próxima disabled, reset de página ao trocar filtro, estado
// vazio, edição em página >1, não regressão de outros consumidores) são
// comportamento de componente React — o projeto não tem infraestrutura de
// teste de UI (nenhuma lib de testing-library/jsdom instalada) e não é
// escopo desta etapa instalar uma só para isso; esses itens foram
// verificados por leitura de código (ver diff de patrimonios/page.tsx) e
// homologação manual no navegador (ver roteiro entregue junto com esta
// mudança). O item J (outros consumidores de /api/patrimonios) foi
// verificado por grep no repositório: Nova Solicitação e Atendimento
// Imediato usam /api/patrimonios/disponibilidade, uma rota completamente
// separada — nenhum outro código chama GET /api/patrimonios além desta
// própria tela.
//
// Executar com: npm run test:patrimonios-pagination

// Torna este arquivo um MÓDULO aos olhos do TypeScript (Etapa
// perf/system-optimization — mesmo padrão já usado em todo o resto de
// scripts/*.ts sem `import`, ex.: test-separacao-concorrencia.ts): sem
// isso, `npx tsc --noEmit` compila os scripts sem import num único escopo
// GLOBAL compartilhado, e as declarações top-level (prisma, authModule,
// failures, assert...) colidem entre arquivos diferentes que também não
// tenham essa linha. Este era o único script do projeto ainda sem ela —
// inofensivo sozinho, mas passou a colidir assim que outro script novo
// também sem `import` foi adicionado (scripts/test-dashboard.ts). Não
// afeta `ts-node`, que roda um arquivo de cada vez.
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

const ADMIN_SESSION = { id: 'user-admin', nome: 'Admin', email: 'admin@example.com', permissao: 'administrador' as const, versaoSessao: 0 }
const COLABORADOR_SESSION = { id: 'user-colab', nome: 'Colaborador', email: 'colab@example.com', permissao: 'colaborador' as const, versaoSessao: 0 }

// Etapa security/session-revocation: GET /api/patrimonios passou a usar
// getValidatedMutationSession() (rota inteira já era exclusiva de
// Patrimônio/Admin) em vez de getSession() puro — ver
// scripts/test-session-revalidation.ts (itens V) para a cobertura de
// revogação em si; este mock só precisa refletir os MESMOS usuários das
// sessões usadas abaixo, para a revalidação não rejeitar sessões que já
// eram válidas antes desta etapa.
const USERS_FAKE: Record<string, { id: string; nome: string; email: string; permissao: string; ativo: boolean; podeSerGestor: boolean; podeSolicitarParaOutro: boolean; versaoSessao: number }> = {
  [ADMIN_SESSION.id]: { id: ADMIN_SESSION.id, nome: ADMIN_SESSION.nome, email: ADMIN_SESSION.email, permissao: ADMIN_SESSION.permissao, ativo: true, podeSerGestor: false, podeSolicitarParaOutro: false, versaoSessao: 0 },
  [COLABORADOR_SESSION.id]: { id: COLABORADOR_SESSION.id, nome: COLABORADOR_SESSION.nome, email: COLABORADOR_SESSION.email, permissao: COLABORADOR_SESSION.permissao, ativo: true, podeSerGestor: false, podeSolicitarParaOutro: false, versaoSessao: 0 },
}

interface PatrimonioFake {
  id: string
  numero: string
  marca: string
  modelo: string
  categoriaId: string
  ativo: boolean
}

// 22 bens fake, numerados de forma a ordenar de forma previsível por
// `numero` (orderBy: { numero: 'asc' } na rota) — "0001".."0022".
const TODOS: PatrimonioFake[] = Array.from({ length: 22 }, (_, i) => ({
  id: `pat-${i + 1}`,
  numero: String(i + 1).padStart(4, '0'),
  marca: 'Dell',
  modelo: `Latitude ${i + 1}`,
  categoriaId: 'cat-notebook',
  ativo: true,
}))

function instalarMockPrisma() {
  prisma.patrimonio = {
    findMany: async ({ where, orderBy, skip, take }: { where: Record<string, unknown>; orderBy: unknown; skip: number; take: number }) => {
      let filtrados = TODOS
      const whereObj = where as { categoriaId?: string; ativo?: boolean; OR?: Array<Record<string, { contains: string }>> }
      if (whereObj.categoriaId) filtrados = filtrados.filter((p) => p.categoriaId === whereObj.categoriaId)
      if (whereObj.ativo !== undefined) filtrados = filtrados.filter((p) => p.ativo === whereObj.ativo)
      if (whereObj.OR) {
        const termo = whereObj.OR[0]?.numero?.contains?.toLowerCase() ?? ''
        filtrados = filtrados.filter(
          (p) => p.numero.toLowerCase().includes(termo) || p.marca.toLowerCase().includes(termo) || p.modelo.toLowerCase().includes(termo)
        )
      }
      filtrados = [...filtrados].sort((a, b) => a.numero.localeCompare(b.numero))
      return filtrados.slice(skip, skip + take).map((p) => ({ ...p, categoria: { id: p.categoriaId, nome: 'Notebook' } }))
    },
    count: async ({ where }: { where: Record<string, unknown> }) => {
      let filtrados = TODOS
      const whereObj = where as { categoriaId?: string; ativo?: boolean; OR?: Array<Record<string, { contains: string }>> }
      if (whereObj.categoriaId) filtrados = filtrados.filter((p) => p.categoriaId === whereObj.categoriaId)
      if (whereObj.ativo !== undefined) filtrados = filtrados.filter((p) => p.ativo === whereObj.ativo)
      if (whereObj.OR) {
        const termo = whereObj.OR[0]?.numero?.contains?.toLowerCase() ?? ''
        filtrados = filtrados.filter(
          (p) => p.numero.toLowerCase().includes(termo) || p.marca.toLowerCase().includes(termo) || p.modelo.toLowerCase().includes(termo)
        )
      }
      return filtrados.length
    },
  }
  prisma.user = {
    findUnique: async ({ where }: { where: { id: string } }) => (USERS_FAKE[where.id] ? { ...USERS_FAKE[where.id] } : null),
  }
}

function instalarMockGetSession() {
  authModule.getSession = async () => ({ ...ADMIN_SESSION })
}

async function getPatrimonios(query: string) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rota = require('../src/app/api/patrimonios/route')
  const req = { url: `http://localhost:3000/api/patrimonios${query}` } as unknown as Parameters<typeof rota.GET>[0]
  return rota.GET(req)
}

async function main() {
  instalarMockPrisma()
  instalarMockGetSession()

  // --- A) mais de 15 patrimônios → página 1 retorna os 15 primeiros -------------------
  {
    const res = await getPatrimonios('?page=1&limit=15')
    const body = await res.json()
    assert(res.status === 200, 'A) resposta 200', res.status)
    assert(body.patrimonios.length === 15, 'A) página 1 retorna exatamente 15 itens (default/limite explícito)', body.patrimonios.length)
    assert(body.patrimonios[0].numero === '0001', 'A) primeiro item da página 1 é o de menor número (ordenação asc)', body.patrimonios[0]?.numero)
    assert(body.patrimonios[14].numero === '0015', 'A) décimo quinto item da página 1 é o número 0015', body.patrimonios[14]?.numero)
    assert(body.total === 22, 'A) total reflete o total real (22), não o tamanho da página', body.total)
  }

  // --- B) page=2 → retorna os seguintes (itens 16-22, sem repetir nenhum da página 1) ---
  {
    const res = await getPatrimonios('?page=2&limit=15')
    const body = await res.json()
    assert(res.status === 200, 'B) resposta 200 na página 2', res.status)
    assert(body.patrimonios.length === 7, 'B) página 2 retorna os 7 itens restantes (22 - 15)', body.patrimonios.length)
    assert(body.patrimonios[0].numero === '0016', 'B) primeiro item da página 2 é o número 0016 (nunca visto na página 1)', body.patrimonios[0]?.numero)
    assert(body.patrimonios[6].numero === '0022', 'B) último item da página 2 é o número 0022', body.patrimonios[6]?.numero)
  }

  // --- C) última página com quantidade parcial -------------------------------------------
  {
    // 22 itens / 15 por página = totalPages 2 (Math.ceil) — já coberto por
    // B acima (página 2 tem 7, não 15). Reforça explicitamente o cálculo
    // de totalPages que a tela faz client-side (Math.ceil(total/limit)).
    const res = await getPatrimonios('?page=2&limit=15')
    const body = await res.json()
    const totalPages = Math.ceil(body.total / 15)
    assert(totalPages === 2, 'C) Math.ceil(total/limit) calcula corretamente a última página como parcial', { total: body.total, totalPages })
    assert(body.patrimonios.length < 15, 'C) última página tem quantidade PARCIAL (< limit), não 15 nem 0', body.patrimonios.length)
  }

  // --- filtro por categoria reduz o total corretamente (base para o item G da tela) -----
  {
    const res = await getPatrimonios('?page=1&limit=15&categoriaId=cat-notebook')
    const body = await res.json()
    assert(body.total === 22, 'filtro por categoria existente retorna o total correto', body.total)

    const resVazio = await getPatrimonios('?page=1&limit=15&categoriaId=cat-inexistente')
    const bodyVazio = await resVazio.json()
    assert(bodyVazio.total === 0 && bodyVazio.patrimonios.length === 0, 'filtro sem nenhum resultado retorna total=0 e lista vazia (base do item H da tela)', bodyVazio)
  }

  // --- busca filtra corretamente (base para o item F da tela) ---------------------------
  {
    const res = await getPatrimonios('?page=1&limit=15&busca=0016')
    const body = await res.json()
    assert(body.total === 1 && body.patrimonios[0]?.numero === '0016', 'busca por número encontra exatamente o item correspondente, mesmo fora da página 1 default', body)
  }

  // --- permissão: sem sessão / sem permissão --------------------------------------------
  {
    authModule.getSession = async () => null
    const res = await getPatrimonios('?page=1&limit=15')
    assert(res.status === 401, 'sem sessão: 401', res.status)
  }
  {
    authModule.getSession = async () => ({ ...COLABORADOR_SESSION })
    const res = await getPatrimonios('?page=1&limit=15')
    assert(res.status === 403, 'sessão sem permissão patrimonio/admin: 403', res.status)
  }
  instalarMockGetSession()

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) de paginação de GET /api/patrimonios falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes de paginação de GET /api/patrimonios passaram. Nenhum banco real foi acessado.')
}

main().catch((err) => {
  console.error('Falha inesperada ao executar os testes de paginação de patrimônios:', err instanceof Error ? err.message : err)
  process.exit(1)
})
