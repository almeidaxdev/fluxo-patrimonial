// scripts/test-demo-solicitacoes-limit.ts
//
// Teste manual (mesmo padrão de scripts/test-demo-mode-routes.ts e
// scripts/test-rate-limit.ts) das DUAS proteções adicionais de
// POST /api/solicitacoes, ativas SOMENTE quando DEMO_MODE=true:
//   1. Rate limit por sessão (checkSensitiveRateLimit, namespace
//      'demo-solicitacoes-criar').
//   2. Limite global independente (DEMO_MAX_SOLICITACOES,
//      getDemoMaxSolicitacoes()/respostaLimiteSolicitacoesDemo() em
//      src/lib/demo-mode.ts) — defesa em profundidade: mesmo se o rate
//      limit estiver fail-open (Firewall não configurado), este limite
//      ainda bloqueia.
//
// Chama o handler REAL da rota (não uma reimplementação) — mocks mínimos
// de prisma/sessão/@vercel/firewall, mesmo padrão dos demais scripts de
// teste deste projeto.
//
// Executar com: npm run test:demo-solicitacoes-limit

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
  process.env.APP_URL = 'http://localhost:3000'

  // --- Mock de @vercel/firewall via require.cache (ver test-rate-limit.ts) -
  const firewallPath = require.resolve('@vercel/firewall')
  const estadoFirewall = { rateLimited: false }
  require.cache[firewallPath] = {
    id: firewallPath,
    filename: firewallPath,
    loaded: true,
    exports: {
      checkRateLimit: async () => ({ rateLimited: estadoFirewall.rateLimited }),
      unstable_checkRateLimit: async () => ({ rateLimited: estadoFirewall.rateLimited }),
    },
  } as unknown as NodeModule

  const { prisma } = require('../src/lib/prisma')
  const authModule = require('../src/lib/auth')

  const ADMIN_ID = 'user-admin-1'
  const adminFake = {
    id: ADMIN_ID,
    nome: 'Administrador Demo',
    email: 'admin@example.com',
    permissao: 'administrador',
    ativo: true,
    podeSerGestor: true,
    podeSolicitarParaOutro: false,
    gestorPadraoId: null,
    versaoSessao: 0,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  }

  let contagemAtual = 0
  let contagemChamadas = 0

  function instalarMockPrisma() {
    prisma.user = {
      findUnique: async ({ where }: { where: { id?: string } }) => (where.id === ADMIN_ID ? { ...adminFake } : null),
    }
    prisma.solicitacao = {
      count: async () => {
        contagemChamadas++
        return contagemAtual
      },
    }
  }

  authModule.getSession = async () => ({
    id: adminFake.id,
    nome: adminFake.nome,
    email: adminFake.email,
    permissao: adminFake.permissao,
    versaoSessao: adminFake.versaoSessao,
  })

  function req(body: unknown = {}) {
    return { json: async () => body, headers: { get: () => null } } as any
  }

  async function chamarPostSolicitacoes(body: unknown = {}) {
    delete require.cache[require.resolve('../src/app/api/solicitacoes/route')]
    const rota = require('../src/app/api/solicitacoes/route')
    return rota.POST(req(body))
  }

  const MSG_LIMITE_DEMO = 'Limite temporário da demonstração atingido. Tente novamente após a restauração do ambiente.'
  const MSG_RATE_LIMIT = 'Muitas tentativas. Aguarde alguns minutos e tente novamente.'

  // =========================================================================
  // getDemoMaxSolicitacoes() — configuração isolada (sem precisar da rota)
  // =========================================================================
  {
    const { getDemoMaxSolicitacoes } = require('@/lib/demo-mode')

    delete process.env.DEMO_MAX_SOLICITACOES
    assert(getDemoMaxSolicitacoes() === 200, 'DEMO_MAX_SOLICITACOES ausente → default seguro (200)', getDemoMaxSolicitacoes())

    for (const valorInvalido of ['0', '-5', 'abc', '3.5', '', '  ']) {
      process.env.DEMO_MAX_SOLICITACOES = valorInvalido
      assert(
        getDemoMaxSolicitacoes() === 200,
        `DEMO_MAX_SOLICITACOES=${JSON.stringify(valorInvalido)} (inválido) → default seguro (200)`,
        getDemoMaxSolicitacoes()
      )
    }

    process.env.DEMO_MAX_SOLICITACOES = '50'
    assert(getDemoMaxSolicitacoes() === 50, 'DEMO_MAX_SOLICITACOES="50" (válido) → 50', getDemoMaxSolicitacoes())

    delete process.env.DEMO_MAX_SOLICITACOES
  }

  // =========================================================================
  // DEMO_MODE=false — nenhuma das duas proteções interfere
  // =========================================================================
  delete process.env.DEMO_MODE
  {
    process.env.DEMO_MAX_SOLICITACOES = '1' // deliberadamente baixíssimo
    contagemAtual = 999 // muito acima de qualquer limite configurável
    contagemChamadas = 0
    estadoFirewall.rateLimited = true // e o rate limit "bloquearia" se fosse checado
    instalarMockPrisma()

    const r = await chamarPostSolicitacoes({})
    const corpo = await r.json().catch(() => ({}))
    assert(r.status !== 429, 'DEMO_MODE=false → POST /api/solicitacoes nunca devolve 429 por causa das proteções de demo', r.status)
    assert(corpo.message !== MSG_LIMITE_DEMO, 'DEMO_MODE=false → mensagem de limite de demo nunca aparece', corpo.message)
    assert(contagemChamadas === 0, 'DEMO_MODE=false → prisma.solicitacao.count() NUNCA é chamado (comportamento anterior preservado byte a byte)', contagemChamadas)

    delete process.env.DEMO_MAX_SOLICITACOES
    estadoFirewall.rateLimited = false
  }

  // =========================================================================
  // DEMO_MODE=true
  // =========================================================================
  process.env.DEMO_MODE = 'true'

  {
    // Rate limit bloqueado — verificado ANTES do limite global (contagem
    // nunca chega a ser consultada).
    estadoFirewall.rateLimited = true
    contagemAtual = 0
    contagemChamadas = 0
    instalarMockPrisma()

    const r = await chamarPostSolicitacoes({})
    assert(r.status === 429, 'DEMO_MODE=true, rate limit bloqueado → 429', r.status)
    const corpo = await r.json()
    assert(corpo.error === MSG_RATE_LIMIT, 'DEMO_MODE=true, rate limit bloqueado → mensagem padrão de rate limit', corpo)
    assert(r.headers.get('Retry-After') !== null, 'DEMO_MODE=true, rate limit bloqueado → header Retry-After presente')
    assert(contagemChamadas === 0, 'DEMO_MODE=true, rate limit bloqueado → limite global nem chega a ser consultado (short-circuit)', contagemChamadas)

    estadoFirewall.rateLimited = false
  }

  {
    // Limite global atingido (rate limit OK).
    process.env.DEMO_MAX_SOLICITACOES = '5'
    contagemAtual = 5
    instalarMockPrisma()

    const r = await chamarPostSolicitacoes({})
    assert(r.status === 429, 'DEMO_MODE=true, limite global atingido (5/5) → 429', r.status)
    const corpo = await r.json()
    assert(corpo.message === MSG_LIMITE_DEMO, 'DEMO_MODE=true, limite atingido → mensagem genérica exigida', corpo.message)
  }

  {
    // Acima do limite também bloqueia (não só igual).
    process.env.DEMO_MAX_SOLICITACOES = '5'
    contagemAtual = 8
    instalarMockPrisma()

    const r = await chamarPostSolicitacoes({})
    assert(r.status === 429, 'DEMO_MODE=true, acima do limite (8/5) → 429', r.status)
  }

  {
    // Abaixo do limite → permitido: as DUAS proteções liberam a chamada, que
    // segue para a validação normal da rota (corpo vazio → 400 de negócio,
    // nunca o 429 de nenhuma das duas proteções de demo).
    process.env.DEMO_MAX_SOLICITACOES = '5'
    contagemAtual = 3
    instalarMockPrisma()

    const r = await chamarPostSolicitacoes({})
    const corpo = await r.json().catch(() => ({}))
    assert(r.status !== 429, 'DEMO_MODE=true, abaixo do limite (3/5) → não bloqueado por nenhuma das proteções de demo', r.status)
    assert(corpo.message !== MSG_LIMITE_DEMO, 'DEMO_MODE=true, abaixo do limite → mensagem de limite de demo não aparece', corpo.message)
    assert(corpo.error !== MSG_RATE_LIMIT, 'DEMO_MODE=true, abaixo do limite → mensagem de rate limit não aparece', corpo.error)
  }

  delete process.env.DEMO_MAX_SOLICITACOES
  delete process.env.DEMO_MODE

  // =========================================================================
  // Ações do workflow (aprovação/separação/retirada/devolução) NUNCA
  // ganharam este bloqueio — verificado por inspeção estática: nenhuma
  // delas importa checkSensitiveRateLimit/demo-mode para este propósito.
  // Cobertura completa (todas as 13 rotas do fluxo) já existe em
  // scripts/test-demo-mode-routes.ts (GRUPO H); aqui, um reforço pontual
  // só nas 4 rotas citadas explicitamente no pedido.
  // =========================================================================
  {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs')
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path')
    const raizProjeto = path.resolve(__dirname, '..')
    const rotas = [
      'src/app/api/solicitacoes/[id]/aprovar-gestor/route.ts',
      'src/app/api/solicitacoes/[id]/separacao/route.ts',
      'src/app/api/solicitacoes/[id]/retirada/route.ts',
      'src/app/api/solicitacoes/[id]/devolucao/route.ts',
    ]
    for (const rota of rotas) {
      const conteudo = fs.readFileSync(path.join(raizProjeto, rota), 'utf8')
      assert(!conteudo.includes('demo-mode'), `${rota} não importa src/lib/demo-mode — sem o novo limite de criação`)
    }
  }

  console.log(`\n${failures === 0 ? '✅ Todos os testes passaram.' : `❌ ${failures} teste(s) falharam.`}`)
  if (failures > 0) process.exit(1)
}

main()
