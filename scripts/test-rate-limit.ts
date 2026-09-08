// scripts/test-rate-limit.ts
//
// Etapa security/rate-limit — valida o helper central `checkSensitiveRateLimit`
// (src/lib/rate-limit.ts) e sua integração nos handlers REAIS de
// POST /api/auth/login, POST /api/auth/cadastro e
// POST /api/solicitacoes/[id]/assinatura.
//
// `@vercel/firewall` é mockado substituindo diretamente a entrada de
// `require.cache` para o pacote — NÃO por atribuição de propriedade
// (`require('@vercel/firewall').checkRateLimit = ...`), porque o pacote
// exporta `checkRateLimit` via `Object.defineProperty(..., { get, })` sem
// `set` nem `configurable: true` (confirmado lendo
// node_modules/@vercel/firewall/dist/rate-limit.js) — sob `'use strict'`
// (que o TypeScript adiciona ao compilar com `strict`/`alwaysStrict`),
// atribuir a essa propriedade lançaria TypeError. Pré-popular
// `require.cache` ANTES de qualquer módulo da aplicação importar o pacote
// contorna isso de forma limpa: o `require()` do Node devolve o que já
// estiver no cache para aquele caminho resolvido, sem reexecutar o arquivo
// real nem tocar nas propriedades somente-leitura dele.
//
// Executar com: npm run test:rate-limit

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

interface CapturedCall {
  rateLimitId: string
  rateLimitKey?: string
}

async function main() {
  process.env.APP_URL = 'http://localhost:3000'

  // --- Mock de @vercel/firewall via require.cache (ver comentário no topo) ---
  const firewallPath = require.resolve('@vercel/firewall')
  const state = { rateLimited: false, shouldThrow: false }
  const capturedCalls: CapturedCall[] = []

  async function fakeCheckRateLimit(rateLimitId: string, options?: { rateLimitKey?: string }) {
    capturedCalls.push({ rateLimitId, rateLimitKey: options?.rateLimitKey })
    if (state.shouldThrow) {
      throw new Error('Firewall indisponível (simulado para teste)')
    }
    return { rateLimited: state.rateLimited }
  }

  require.cache[firewallPath] = {
    id: firewallPath,
    filename: firewallPath,
    loaded: true,
    exports: { checkRateLimit: fakeCheckRateLimit, unstable_checkRateLimit: fakeCheckRateLimit },
  } as unknown as NodeModule

  // --- Demais mocks/spies -----------------------------------------------
  const { prisma } = require('../src/lib/prisma')
  const authModule = require('../src/lib/auth')
  const bcryptModule = require('bcryptjs')
  const { checkSensitiveRateLimit } = require('../src/lib/rate-limit')

  // setSession() escreve um cookie via next/headers `cookies()`, que só
  // existe dentro de um request real do App Router — fora desse contexto
  // (chamando o handler diretamente, como este script faz) ela lança. Não é
  // o que este teste verifica (o alvo é o GATE de rate limit, não a escrita
  // de cookie em si — coberto por outros meios) — mockada como no-op.
  authModule.setSession = async () => {}

  const contadores = { findUnique: 0, compare: 0, transaction: 0 }

  // bcrypt roda DE VERDADE (mesmo padrão de scripts/test-colaboradores-reset-senha.ts)
  // — só contamos as chamadas, nunca substituímos o comportamento real.
  const compareOriginal = bcryptModule.compare.bind(bcryptModule)
  bcryptModule.compare = async (...args: Parameters<typeof compareOriginal>) => {
    contadores.compare++
    return compareOriginal(...args)
  }

  const SENHA_CORRETA = 'SenhaCorreta123'
  const SENHA_HASH = await bcryptModule.hash(SENHA_CORRETA, 12)
  const USER_LOGIN = {
    id: 'user-1',
    nome: 'Fulano de Tal',
    email: 'fulano@example.com',
    senha: SENHA_HASH,
    ativo: true,
    permissao: 'colaborador' as const,
    podeSerGestor: false,
    podeSolicitarParaOutro: false,
  }

  function instalarMockUserLogin() {
    prisma.user = {
      findUnique: async ({ where }: { where: { email: string } }) => {
        contadores.findUnique++
        return where.email === USER_LOGIN.email ? { ...USER_LOGIN } : null
      },
    }
  }

  function resetarContadores() {
    contadores.findUnique = 0
    contadores.compare = 0
    contadores.transaction = 0
    capturedCalls.length = 0
  }

  async function postarLogin(body: Record<string, unknown>) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rota = require('../src/app/api/auth/login/route')
    const req = { json: async () => body } as unknown as Parameters<typeof rota.POST>[0]
    return rota.POST(req)
  }

  async function postarCadastro(body: Record<string, unknown>, headers: Record<string, string> = {}) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rota = require('../src/app/api/auth/cadastro/route')
    const req = {
      json: async () => body,
      headers: new Headers(headers),
    } as unknown as Parameters<typeof rota.POST>[0]
    return rota.POST(req)
  }

  // ========================================================================
  // A) login normal abaixo do limite → fluxo continua
  // ========================================================================
  instalarMockUserLogin()
  resetarContadores()
  state.rateLimited = false
  {
    const res = await postarLogin({ email: USER_LOGIN.email, senha: SENHA_CORRETA })
    const body = await res.json()
    assert(res.status === 200, 'A) login abaixo do limite → 200', res.status)
    assert(body.user?.id === USER_LOGIN.id, 'A) sessão criada para o usuário correto', body.user)
    assert(contadores.findUnique === 1, 'A) prisma.user.findUnique chamado normalmente', contadores)
    assert(contadores.compare === 1, 'A) bcrypt.compare chamado normalmente', contadores)
  }

  // ========================================================================
  // B) login com rateLimited=true → 429; C) zero DB/bcrypt; J) Retry-After
  // ========================================================================
  resetarContadores()
  state.rateLimited = true
  {
    const res = await postarLogin({ email: USER_LOGIN.email, senha: SENHA_CORRETA })
    const body = await res.json()
    assert(res.status === 429, 'B) login com rateLimited=true → 429', res.status)
    assert(
      body.error === 'Muitas tentativas. Aguarde alguns minutos e tente novamente.',
      'B) mensagem genérica, sem revelar se a conta existe',
      body
    )
    assert(contadores.findUnique === 0, 'C) prisma.user.findUnique NÃO foi chamado quando bloqueado', contadores)
    assert(contadores.compare === 0, 'C) bcrypt.compare NÃO foi chamado quando bloqueado', contadores)
    assert(res.headers.get('Retry-After') === '600', 'J) header Retry-After presente e igual à janela (600s)', res.headers.get('Retry-After'))
  }
  state.rateLimited = false

  // ========================================================================
  // D) e-mails diferentes → rateLimitKey diferentes
  // E) mesmo e-mail com maiúsculas/espaços → mesma chave
  // F) rateLimitKey não contém e-mail bruto
  // ========================================================================
  resetarContadores()
  {
    await checkSensitiveRateLimit({ request: new Request('http://localhost/x'), namespace: 'login', identifier: 'a@example.com' })
    const chaveA = capturedCalls[capturedCalls.length - 1]?.rateLimitKey
    await checkSensitiveRateLimit({ request: new Request('http://localhost/x'), namespace: 'login', identifier: 'b@example.com' })
    const chaveB = capturedCalls[capturedCalls.length - 1]?.rateLimitKey
    assert(!!chaveA && !!chaveB && chaveA !== chaveB, 'D) e-mails diferentes produzem rateLimitKey diferentes', { chaveA, chaveB })

    await checkSensitiveRateLimit({ request: new Request('http://localhost/x'), namespace: 'login', identifier: '  A@Example.com  ' })
    const chaveNormalizada = capturedCalls[capturedCalls.length - 1]?.rateLimitKey
    assert(chaveNormalizada === chaveA, 'E) mesmo e-mail com maiúsculas/espaços produz a MESMA chave (normalização)', { chaveNormalizada, chaveA })

    assert(!chaveA?.toLowerCase().includes('a@example.com'), 'F) rateLimitKey não contém o e-mail bruto', chaveA)
    assert(chaveA?.startsWith('login:') === true, 'F) rateLimitKey usa o namespace como prefixo (chave opaca depois dos dois-pontos)', chaveA)
  }

  // ========================================================================
  // G) cadastro usa namespace diferente; H) login e cadastro do MESMO
  // identificador → chaves diferentes (isolamento por namespace)
  // ========================================================================
  resetarContadores()
  {
    await checkSensitiveRateLimit({ request: new Request('http://localhost/x'), namespace: 'login', identifier: '203.0.113.10' })
    const chaveLogin = capturedCalls[capturedCalls.length - 1]?.rateLimitKey
    await checkSensitiveRateLimit({ request: new Request('http://localhost/x'), namespace: 'cadastro', identifier: '203.0.113.10' })
    const chaveCadastro = capturedCalls[capturedCalls.length - 1]?.rateLimitKey
    assert(chaveCadastro?.startsWith('cadastro:') === true, 'G) namespace "cadastro" usado como prefixo', chaveCadastro)
    assert(chaveLogin !== chaveCadastro, 'H) mesmo identificador em namespaces diferentes → chaves diferentes (contadores isolados)', { chaveLogin, chaveCadastro })
  }

  // --- G, reforço) rota real de cadastro também bloqueia com 429 quando o
  // Firewall determina rateLimited=true (prova a integração, não só o
  // helper isolado) ---
  resetarContadores()
  state.rateLimited = true
  {
    prisma.user = { findUnique: async () => { contadores.findUnique++; return null } }
    const res = await postarCadastro(
      { nome: 'Novo Colaborador', email: 'novo@example.com', senha: 'SenhaForte123' },
      { 'x-real-ip': '198.51.100.7' }
    )
    const body = await res.json()
    assert(res.status === 429, 'G) rota real POST /api/auth/cadastro também bloqueia com 429', res.status)
    assert(body.error === 'Muitas tentativas. Aguarde alguns minutos e tente novamente.', 'G) mensagem genérica no cadastro também', body)
    assert(contadores.findUnique === 0, 'G) prisma.user.findUnique (checagem de duplicidade) NÃO chamado quando bloqueado', contadores)
    assert(res.headers.get('Retry-After') === '600', 'G) Retry-After presente também no cadastro', res.headers.get('Retry-After'))
  }
  state.rateLimited = false

  // ========================================================================
  // I) falha de infraestrutura → fail-open documentado, sem propagar erro
  // ========================================================================
  resetarContadores()
  state.shouldThrow = true
  {
    const consoleErrorOriginal = console.error
    const mensagensLogadas: unknown[][] = []
    console.error = (...args: unknown[]) => { mensagensLogadas.push(args) }

    let lancou = false
    let resultado: { limited: boolean } | undefined
    try {
      resultado = await checkSensitiveRateLimit({ request: new Request('http://localhost/x'), namespace: 'login', identifier: 'vitima@example.com' })
    } catch {
      lancou = true
    } finally {
      console.error = consoleErrorOriginal
    }

    assert(!lancou, 'I) falha de infraestrutura do Firewall NÃO propaga exceção (fail-open)', lancou)
    assert(resultado?.limited === false, 'I) em falha de infraestrutura, limited=false (requisição segue normalmente)', resultado)
    const logComEmailBruto = mensagensLogadas.some((args) => args.some((a) => typeof a === 'string' && a.includes('vitima@example.com')))
    assert(!logComEmailBruto, 'I) log de erro da falha NÃO contém o identificador bruto (e-mail)', mensagensLogadas)
  }
  state.shouldThrow = false

  // ========================================================================
  // K) reenvio de assinatura bloqueado → nenhum novo EmailEvento/processamento
  // ========================================================================
  const SESSION_PATRIMONIO = { id: 'user-patrimonio', nome: 'Patrimônio', email: 'patrimonio@example.com', permissao: 'patrimonio' as const, podeSerGestor: false, podeSolicitarParaOutro: false }
  function logarComo(sessao: typeof SESSION_PATRIMONIO) {
    authModule.getSession = async () => ({ ...sessao });
  }

  function instalarMockAssinatura() {
    const tx = {
      solicitacao: { findUnique: async () => ({ id: 'sol-1', tipoEmprestimo: 'externo', status: 'AGUARDANDO_ENVIO_ASSINATURA', updatedAt: new Date() }) },
      emailEvento: { findUnique: async () => null, create: async () => { throw new Error('NÃO deveria ser chamado — solicitação bloqueada por rate limit') } },
    }
    prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
      contadores.transaction++
      return fn(tx)
    }
  }

  async function postarAssinatura(id: string, body: Record<string, unknown>) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rota = require('../src/app/api/solicitacoes/[id]/assinatura/route')
    const req = { json: async () => body } as unknown as Parameters<typeof rota.POST>[0]
    return rota.POST(req, { params: Promise.resolve({ id }) })
  }

  instalarMockAssinatura()
  logarComo(SESSION_PATRIMONIO)
  resetarContadores()
  state.rateLimited = true
  {
    const res = await postarAssinatura('sol-1', { link: 'https://assinaturas.example.com/doc/123' })
    const body = await res.json()
    assert(res.status === 429, 'K) reenvio de assinatura com rateLimited=true → 429', res.status)
    assert(body.error === 'Muitas tentativas. Aguarde alguns minutos e tente novamente.', 'K) mensagem genérica', body)
    assert(contadores.transaction === 0, 'K) nenhuma $transaction foi aberta (nenhum EmailEvento/processamento disparado)', contadores)
  }
  state.rateLimited = false

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) de rate limiting falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes de rate limiting passaram. Nenhuma chamada real ao Vercel Firewall foi feita, nenhum e-mail real foi enviado, nenhum banco real foi acessado.')
}

main().catch((err) => {
  console.error('Falha inesperada ao executar os testes de rate limiting:', err instanceof Error ? err.message : err)
  process.exit(1)
})
