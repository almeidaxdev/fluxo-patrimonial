// scripts/test-demo-mode-routes.ts
//
// Teste manual (mesmo padrão de scripts/test-colaboradores-reset-senha.ts e
// scripts/test-rate-limit.ts) que chama os handlers REAIS de rota afetados
// por DEMO_MODE — nunca uma reimplementação, e nunca só "o botão sumiu da
// tela": cada caso aqui é uma chamada direta ao handler, como um atacante
// batendo na API diretamente faria.
//
// Modelo "dados mestres somente leitura" (revisão de hardening): as telas
// administrativas de colaboradores/patrimônios/categorias continuam
// visíveis na demo, mas QUALQUER mutação (criar/editar/excluir) nelas é
// bloqueada por inteiro — não existe mais uma lista de "campos sensíveis"
// nem um caso especial para a conta demonstrativa (ela é só mais um
// colaborador). Tipos de serviço não têm rota POST/PATCH/DELETE nesta base
// de código — nada a bloquear ali (confirmado por grep, ver GRUPO E).
//
// Cobre:
//   - DEMO_MODE=false: comportamento normal preservado em todas as rotas
//     tocadas por esta etapa.
//   - DEMO_MODE=true: POST/PATCH/DELETE de colaboradores/patrimônios/
//     categorias devolvem 403 com a mensagem fixa; auth:alterar-senha-
//     propria e auth:autocadastro idem; POST /api/demo/entrar funciona;
//     POST /api/internal/demo-reset exige o secret correto (header, tempo
//     constante); os dois endpoints de demo somem (404) fora de DEMO_MODE.
//   - CORE da demo (criar solicitação, aprovar, separar, retirar, devolver)
//     permanece ACESSÍVEL em DEMO_MODE=true — chamado de verdade, prova-se
//     que a resposta nunca é o 403 do gate de demo.
//   - CRIAÇÃO de solicitação, especificamente, ganhou DUAS proteções
//     ADICIONAIS só em DEMO_MODE=true (rate limit por sessão + limite
//     global `DEMO_MAX_SOLICITACOES`, ambas em src/lib/demo-mode.ts) — as
//     demais ações do workflow (aprovar/separar/retirar/devolver/etc.)
//     deliberadamente NÃO ganharam nada disso, por operarem sobre um
//     registro já existente.
//   - Verificação ESTÁTICA de que as rotas de AÇÃO sobre uma solicitação
//     já existente nunca importam src/lib/demo-mode — a única forma de uma
//     rota ser afetada por DEMO_MODE é chamar algo desse módulo; se o
//     arquivo não o importa, é estruturalmente impossível que DEMO_MODE a
//     bloqueie. A rota de CRIAÇÃO é verificada com a asserção inversa
//     (precisa importar, de propósito).
//
// Executar com: npm run test:demo-mode-routes

export {}

import * as fs from 'fs'
import * as path from 'path'

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
  process.env.ALLOWED_EMAIL_DOMAINS = 'example.com'

  // --- Mock de @vercel/firewall (fail-open: nunca bloqueia por rate limit
  // neste teste — o alvo é o gate de DEMO_MODE, não o de rate limit, já
  // coberto por scripts/test-rate-limit.ts). Ver comentário completo em
  // test-rate-limit.ts sobre por que isto precisa ser via require.cache.
  const firewallPath = require.resolve('@vercel/firewall')
  require.cache[firewallPath] = {
    id: firewallPath,
    filename: firewallPath,
    loaded: true,
    exports: {
      checkRateLimit: async () => ({ rateLimited: false }),
      unstable_checkRateLimit: async () => ({ rateLimited: false }),
    },
  } as unknown as NodeModule

  const { prisma } = require('../src/lib/prisma')
  const authModule = require('../src/lib/auth')
  const bcrypt = require('bcryptjs')

  authModule.setSession = async () => {}

  // --- Fixtures ------------------------------------------------------------
  const ADMIN_ID = 'user-admin-1'
  const COLEGA_ID = 'user-colega-1'
  const PATRIMONIO_ID = 'pat-1'
  const CATEGORIA_ID = 'cat-1'

  let adminFake: any
  let colegaFake: any
  let patrimonioFake: any
  let categoriaFake: any

  // Hash bcrypt REAL (custo baixo só para velocidade do teste) — nunca um
  // placeholder de texto puro: PATCH /api/auth/senha chama bcrypt.compare()
  // de verdade neste teste (handler real, não reimplementado).
  const HASH_SENHA_TESTE = bcrypt.hashSync('senha-teste-fixture', 4)

  function resetFixtures() {
    adminFake = {
      id: ADMIN_ID,
      nome: 'Administrador Demo',
      email: 'admin@example.com',
      senha: HASH_SENHA_TESTE,
      permissao: 'administrador',
      ativo: true,
      podeSerGestor: true,
      podeSolicitarParaOutro: false,
      gestorPadraoId: null,
      versaoSessao: 0,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    }
    colegaFake = {
      id: COLEGA_ID,
      nome: 'Colega',
      email: 'colega@example.com',
      senha: HASH_SENHA_TESTE,
      permissao: 'colaborador',
      ativo: true,
      podeSerGestor: false,
      podeSolicitarParaOutro: false,
      gestorPadraoId: null,
      versaoSessao: 0,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    }
    patrimonioFake = { id: PATRIMONIO_ID, numero: 'PAT-TEST-1', marca: 'X', modelo: 'Y', ativo: true, categoriaId: CATEGORIA_ID }
    categoriaFake = { id: CATEGORIA_ID, nome: 'Categoria Teste', ativo: true }
  }
  resetFixtures()

  function usuarioPorId(id: string) {
    if (id === adminFake?.id) return adminFake
    if (id === colegaFake?.id) return colegaFake
    return null
  }
  function usuarioPorEmail(email: string) {
    const todos = [adminFake, colegaFake].filter(Boolean)
    return todos.find((u) => u.email === email) ?? null
  }

  function instalarMockPrisma() {
    prisma.user = {
      findUnique: async ({ where }: { where: { id?: string; email?: string } }) => {
        const u = where.id ? usuarioPorId(where.id) : where.email ? usuarioPorEmail(where.email) : null
        return u ? { ...u } : null
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const u = usuarioPorId(where.id)
        if (!u) throw new Error('Usuário não encontrado (mock).')
        const { versaoSessao, ...resto } = data
        Object.assign(u, resto)
        if (versaoSessao && typeof versaoSessao === 'object' && 'increment' in (versaoSessao as Record<string, unknown>)) {
          u.versaoSessao += (versaoSessao as { increment: number }).increment
        }
        return { ...u }
      },
      delete: async ({ where }: { where: { id: string } }) => {
        if (where.id === adminFake?.id) adminFake = null
        if (where.id === colegaFake?.id) colegaFake = null
        return {}
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        return { id: 'user-novo', ...data }
      },
    }

    prisma.patrimonio = {
      findUnique: async ({ where }: { where: { id?: string; numero?: string } }) =>
        patrimonioFake && (where.id === patrimonioFake.id || where.numero === patrimonioFake.numero) ? { ...patrimonioFake } : null,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(patrimonioFake, data)
        return { ...patrimonioFake }
      },
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'pat-novo', ativo: true, ...data }),
      delete: async () => {
        patrimonioFake = null
        return {}
      },
      count: async () => 0,
    }
    prisma.itemPatrimonioSolicitacao = { count: async () => 0 }

    prisma.categoriaPatrimonio = {
      findUnique: async ({ where }: { where: { id?: string; nome?: string } }) =>
        categoriaFake && (where.id === categoriaFake.id || where.nome === categoriaFake.nome) ? { ...categoriaFake } : null,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(categoriaFake, data)
        return { ...categoriaFake }
      },
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'cat-nova', ativo: true, ...data }),
      delete: async () => {
        categoriaFake = null
        return {}
      },
    }

    // Fluxo de solicitações (GRUPO F, "core continua mutável"): mocks
    // mínimos, suficientes para provar que DEMO_MODE não interfere — não
    // reproduzem a regra de negócio completa (já coberta pelos testes
    // próprios de cada rota, ex.: scripts/test-solicitacoes-aprovar-gestor.ts).
    // `findUnique`/`findUniqueOrThrow` devolvendo `null`/lançando faz cada
    // rota cair no próprio caminho de "não encontrada" (404), uma resposta
    // limpa e determinística que NUNCA é o 403 do gate de demo.
    prisma.solicitacao = {
      findUnique: async () => null,
      findUniqueOrThrow: async () => {
        throw new Error('Solicitação não encontrada (mock).')
      },
      updateMany: async () => ({ count: 0 }),
      count: async () => 0,
    }
    prisma.$transaction = async (fn: unknown, _opts?: unknown) => {
      if (typeof fn === 'function') return fn(prisma)
      // Forma array (Prisma também aceita `$transaction([...])`) — não
      // usada pelas rotas exercitadas aqui, mas não deve quebrar se for.
      return Promise.all(fn as unknown as Promise<unknown>[])
    }
  }

  function sessaoAdmin() {
    return { id: adminFake.id, nome: adminFake.nome, email: adminFake.email, permissao: adminFake.permissao, versaoSessao: adminFake.versaoSessao }
  }

  function instalarSessao(sessao: ReturnType<typeof sessaoAdmin> | null) {
    authModule.getSession = async () => (sessao ? { ...sessao } : null)
  }

  function req(body: unknown = {}) {
    // `headers.get()` sempre presente (mesmo nas rotas que não usam rate
    // limit): POST /api/auth/cadastro e POST /api/demo/entrar chamam
    // extrairIpCliente(req), que acessa request.headers.get(...) — sem isso
    // o mock quebraria com "Cannot read properties of undefined".
    return { json: async () => body, headers: { get: () => null } } as any
  }

  function chamarRota(caminhoRelativo: string) {
    const caminho = `../src/app/api/${caminhoRelativo}/route`
    delete require.cache[require.resolve(caminho)]
    return require(caminho)
  }

  async function chamarPatchColaborador(id: string, body: unknown) {
    return chamarRota('colaboradores/[id]').PATCH(req(body), { params: Promise.resolve({ id }) })
  }
  async function chamarDeleteColaborador(id: string) {
    return chamarRota('colaboradores/[id]').DELETE(req(), { params: Promise.resolve({ id }) })
  }
  async function chamarPostColaborador(body: unknown) {
    return chamarRota('colaboradores').POST(req(body))
  }
  async function chamarPatchSenha(body: unknown) {
    return chamarRota('auth/senha').PATCH(req(body))
  }
  async function chamarPostCadastro(body: unknown) {
    return chamarRota('auth/cadastro').POST(req(body))
  }
  async function chamarPostPatrimonio(body: unknown) {
    return chamarRota('patrimonios').POST(req(body))
  }
  async function chamarPatchPatrimonio(id: string, body: unknown) {
    return chamarRota('patrimonios/[id]').PATCH(req(body), { params: Promise.resolve({ id }) })
  }
  async function chamarDeletePatrimonio(id: string) {
    return chamarRota('patrimonios/[id]').DELETE(req(), { params: Promise.resolve({ id }) })
  }
  async function chamarPostCategoria(body: unknown) {
    return chamarRota('categorias').POST(req(body))
  }
  async function chamarPatchCategoria(id: string, body: unknown) {
    return chamarRota('categorias/[id]').PATCH(req(body), { params: Promise.resolve({ id }) })
  }
  async function chamarDeleteCategoria(id: string) {
    return chamarRota('categorias/[id]').DELETE(req(), { params: Promise.resolve({ id }) })
  }
  async function chamarPostDemoEntrar() {
    return chamarRota('demo/entrar').POST(req())
  }
  async function chamarPostDemoReset(headers: Record<string, string> = {}) {
    const request = { headers: { get: (k: string) => headers[k.toLowerCase()] ?? null } } as any
    return chamarRota('internal/demo-reset').POST(request)
  }
  async function chamarPostSolicitacoes(body: unknown) {
    return chamarRota('solicitacoes').POST(req(body))
  }
  async function chamarPostAprovarGestor(id: string) {
    return chamarRota('solicitacoes/[id]/aprovar-gestor').POST(req(), { params: Promise.resolve({ id }) })
  }
  async function chamarPostSeparacao(id: string) {
    return chamarRota('solicitacoes/[id]/separacao').POST(req(), { params: Promise.resolve({ id }) })
  }
  async function chamarPostRetirada(id: string) {
    return chamarRota('solicitacoes/[id]/retirada').POST(req({}), { params: Promise.resolve({ id }) })
  }
  async function chamarPostDevolucao(id: string) {
    return chamarRota('solicitacoes/[id]/devolucao').POST(req({}), { params: Promise.resolve({ id }) })
  }

  async function mensagemDemo(resposta: Response): Promise<string | undefined> {
    try {
      const corpo = await resposta.json()
      return corpo.message
    } catch {
      return undefined
    }
  }

  const MSG_DEMO = 'Ação desabilitada no ambiente de demonstração.'

  // =========================================================================
  // GRUPO A — DEMO_MODE=false: comportamento normal preservado
  // =========================================================================
  delete process.env.DEMO_MODE
  delete process.env.DEMO_ACCOUNT_EMAIL
  delete process.env.DEMO_RESET_SECRET

  {
    resetFixtures()
    instalarMockPrisma()
    instalarSessao(sessaoAdmin())
    const rPatch = await chamarPatchColaborador(COLEGA_ID, { ativo: false, permissao: 'colaborador' })
    assert(rPatch.status === 200, 'DEMO_MODE=false → PATCH colaborador devolve 200', rPatch.status)

    resetFixtures()
    instalarMockPrisma()
    const rPostColab = await chamarPostColaborador({ nome: 'Fulano', email: 'fulano@example.com', senha: 'Senha12345', permissao: 'colaborador' })
    assert(rPostColab.status === 201, 'DEMO_MODE=false → POST colaborador devolve 201', rPostColab.status)

    resetFixtures()
    instalarMockPrisma()
    instalarSessao(sessaoAdmin())
    const rSenha = await chamarPatchSenha({ senhaAtual: 'senha-teste-fixture', novaSenha: 'Senha12345' })
    assert(rSenha.status === 200, 'DEMO_MODE=false → PATCH /api/auth/senha devolve 200', rSenha.status)

    resetFixtures()
    instalarMockPrisma()
    const rCadastro = await chamarPostCadastro({ nome: 'Novo Colaborador', email: 'novo@example.com', senha: 'Senha12345' })
    assert(rCadastro.status === 201, 'DEMO_MODE=false → POST /api/auth/cadastro devolve 201', rCadastro.status)

    resetFixtures()
    instalarMockPrisma()
    instalarSessao(sessaoAdmin())
    const rPostPat = await chamarPostPatrimonio({ numero: 'PAT-NOVO', marca: 'M', modelo: 'X', categoriaId: CATEGORIA_ID })
    assert(rPostPat.status === 201, 'DEMO_MODE=false → POST patrimônio devolve 201', rPostPat.status)

    resetFixtures()
    instalarMockPrisma()
    instalarSessao(sessaoAdmin())
    const rPatchPat = await chamarPatchPatrimonio(PATRIMONIO_ID, { marca: 'Nova Marca' })
    assert(rPatchPat.status === 200, 'DEMO_MODE=false → PATCH patrimônio devolve 200', rPatchPat.status)

    resetFixtures()
    instalarMockPrisma()
    instalarSessao(sessaoAdmin())
    const rDelPat = await chamarDeletePatrimonio(PATRIMONIO_ID)
    assert(rDelPat.status === 200, 'DEMO_MODE=false → DELETE patrimônio devolve 200', rDelPat.status)

    resetFixtures()
    instalarMockPrisma()
    instalarSessao(sessaoAdmin())
    const rPostCat = await chamarPostCategoria({ nome: 'Categoria Nova' })
    assert(rPostCat.status === 201, 'DEMO_MODE=false → POST categoria devolve 201', rPostCat.status)

    resetFixtures()
    instalarMockPrisma()
    instalarSessao(sessaoAdmin())
    const rPatchCat = await chamarPatchCategoria(CATEGORIA_ID, { nome: 'Categoria Editada' })
    assert(rPatchCat.status === 200, 'DEMO_MODE=false → PATCH categoria devolve 200', rPatchCat.status)

    resetFixtures()
    instalarMockPrisma()
    instalarSessao(sessaoAdmin())
    const rDelCat = await chamarDeleteCategoria(CATEGORIA_ID)
    assert(rDelCat.status === 200, 'DEMO_MODE=false → DELETE categoria devolve 200', rDelCat.status)

    resetFixtures()
    instalarMockPrisma()
    instalarSessao(sessaoAdmin())
    const rDelUser = await chamarDeleteColaborador(COLEGA_ID)
    assert(rDelUser.status === 200, 'DEMO_MODE=false → DELETE colaborador devolve 200', rDelUser.status)

    const rDemoEntrar = await chamarPostDemoEntrar()
    assert(rDemoEntrar.status === 404, 'DEMO_MODE=false → POST /api/demo/entrar devolve 404 (endpoint não existe fora da demo)', rDemoEntrar.status)

    const rDemoReset = await chamarPostDemoReset({ 'x-demo-reset-secret': 'qualquer' })
    assert(rDemoReset.status === 404, 'DEMO_MODE=false → POST /api/internal/demo-reset devolve 404', rDemoReset.status)
  }

  // =========================================================================
  // GRUPO B — DEMO_MODE=true: dados mestres (colaboradores) somente-leitura
  // =========================================================================
  process.env.DEMO_MODE = 'true'

  async function assertBloqueadoPorDemo(resposta: Response, label: string) {
    assert(resposta.status === 403, `${label} devolve 403`, resposta.status)
    assert((await mensagemDemo(resposta)) === MSG_DEMO, `${label} usa a mensagem fixa`, await mensagemDemo(resposta))
  }

  {
    resetFixtures()
    instalarMockPrisma()
    const r = await chamarPostColaborador({ nome: 'Fulano', email: 'fulano@example.com', senha: 'Senha12345', permissao: 'colaborador' })
    await assertBloqueadoPorDemo(r, 'DEMO_MODE=true → POST colaborador')
  }
  {
    resetFixtures()
    instalarMockPrisma()
    instalarSessao(sessaoAdmin())
    const r = await chamarPatchColaborador(COLEGA_ID, { nome: 'Novo Nome' })
    await assertBloqueadoPorDemo(r, 'DEMO_MODE=true → PATCH colaborador (mesmo só nome)')
    assert(colegaFake.nome === 'Colega', 'DEMO_MODE=true → PATCH colaborador NÃO alterou o nome de fato')
  }
  {
    resetFixtures()
    instalarMockPrisma()
    instalarSessao(sessaoAdmin())
    const r = await chamarPatchColaborador(ADMIN_ID, { nome: 'Novo Nome Admin' })
    await assertBloqueadoPorDemo(r, 'DEMO_MODE=true → PATCH na própria conta demo (admin@example.com)')
  }
  {
    resetFixtures()
    instalarMockPrisma()
    instalarSessao(sessaoAdmin())
    const r = await chamarDeleteColaborador(COLEGA_ID)
    await assertBloqueadoPorDemo(r, 'DEMO_MODE=true → DELETE colaborador')
    assert(colegaFake !== null, 'DEMO_MODE=true → DELETE colaborador NÃO removeu o usuário de fato')
  }
  {
    resetFixtures()
    instalarMockPrisma()
    instalarSessao(sessaoAdmin())
    const r = await chamarPatchSenha({ senhaAtual: 'x', novaSenha: 'Senha12345' })
    await assertBloqueadoPorDemo(r, 'DEMO_MODE=true → PATCH /api/auth/senha')
  }
  {
    resetFixtures()
    instalarMockPrisma()
    const r = await chamarPostCadastro({ nome: 'Novo', email: 'novo@example.com', senha: 'Senha12345' })
    await assertBloqueadoPorDemo(r, 'DEMO_MODE=true → POST /api/auth/cadastro (autocadastro)')
  }

  // =========================================================================
  // GRUPO C — DEMO_MODE=true: patrimônios somente-leitura
  // =========================================================================
  {
    resetFixtures()
    instalarMockPrisma()
    instalarSessao(sessaoAdmin())
    const r = await chamarPostPatrimonio({ numero: 'PAT-NOVO', marca: 'M', modelo: 'X', categoriaId: CATEGORIA_ID })
    await assertBloqueadoPorDemo(r, 'DEMO_MODE=true → POST patrimônio')
  }
  {
    resetFixtures()
    instalarMockPrisma()
    instalarSessao(sessaoAdmin())
    const r = await chamarPatchPatrimonio(PATRIMONIO_ID, { marca: 'Outra Marca' })
    await assertBloqueadoPorDemo(r, 'DEMO_MODE=true → PATCH patrimônio')
    assert(patrimonioFake.marca === 'X', 'DEMO_MODE=true → PATCH patrimônio NÃO alterou a marca de fato')
  }
  {
    resetFixtures()
    instalarMockPrisma()
    instalarSessao(sessaoAdmin())
    const r = await chamarDeletePatrimonio(PATRIMONIO_ID)
    await assertBloqueadoPorDemo(r, 'DEMO_MODE=true → DELETE patrimônio')
    assert(patrimonioFake !== null, 'DEMO_MODE=true → DELETE patrimônio NÃO removeu o bem de fato')
  }

  // =========================================================================
  // GRUPO D — DEMO_MODE=true: categorias somente-leitura
  // =========================================================================
  {
    resetFixtures()
    instalarMockPrisma()
    instalarSessao(sessaoAdmin())
    const r = await chamarPostCategoria({ nome: 'Categoria Nova' })
    await assertBloqueadoPorDemo(r, 'DEMO_MODE=true → POST categoria')
  }
  {
    resetFixtures()
    instalarMockPrisma()
    instalarSessao(sessaoAdmin())
    const r = await chamarPatchCategoria(CATEGORIA_ID, { nome: 'Outro Nome' })
    await assertBloqueadoPorDemo(r, 'DEMO_MODE=true → PATCH categoria')
    assert(categoriaFake.nome === 'Categoria Teste', 'DEMO_MODE=true → PATCH categoria NÃO alterou o nome de fato')
  }
  {
    resetFixtures()
    instalarMockPrisma()
    instalarSessao(sessaoAdmin())
    const r = await chamarDeleteCategoria(CATEGORIA_ID)
    await assertBloqueadoPorDemo(r, 'DEMO_MODE=true → DELETE categoria')
    assert(categoriaFake !== null, 'DEMO_MODE=true → DELETE categoria NÃO removeu a categoria de fato')
  }

  // =========================================================================
  // GRUPO E — Tipos de serviço: nenhuma rota de mutação existe nesta base de
  // código (confirmado por grep) — nada a bloquear; documentado aqui para
  // que uma futura rota POST/PATCH/DELETE de tipos-servico seja lembrada de
  // registrar um DemoAction e este teste seja atualizado.
  // =========================================================================
  {
    const conteudoRota = fs.readFileSync(path.join(path.resolve(__dirname, '..'), 'src/app/api/tipos-servico/route.ts'), 'utf8')
    assert(
      !/export async function (POST|PATCH|DELETE)/.test(conteudoRota),
      'src/app/api/tipos-servico/route.ts continua só-leitura (GET) — nenhuma mutação a bloquear'
    )
  }

  // =========================================================================
  // GRUPO F — DEMO_MODE=true: acesso e reset da demo
  // =========================================================================
  {
    resetFixtures()
    instalarMockPrisma()
    const r = await chamarPostDemoEntrar()
    assert(r.status === 200, 'DEMO_MODE=true → POST /api/demo/entrar devolve 200', r.status)
    const corpo = await r.json()
    assert(corpo.user?.email === 'admin@example.com', 'DEMO_MODE=true → POST /api/demo/entrar autentica a conta demo configurada', corpo.user?.email)
    assert(!('senha' in (corpo.user ?? {})), 'DEMO_MODE=true → resposta de /api/demo/entrar nunca inclui a senha/hash')
  }

  {
    delete process.env.DEMO_RESET_SECRET
    const r = await chamarPostDemoReset({ 'x-demo-reset-secret': 'qualquer-coisa' })
    assert(r.status === 503, 'DEMO_MODE=true, sem DEMO_RESET_SECRET configurado → 503 (fail-closed)', r.status)
  }

  process.env.DEMO_RESET_SECRET = 'segredo-de-teste-correto'
  {
    const r = await chamarPostDemoReset({})
    assert(r.status === 401, 'DEMO_MODE=true → POST /api/internal/demo-reset sem header devolve 401', r.status)
  }
  {
    const r = await chamarPostDemoReset({ 'x-demo-reset-secret': 'valor-errado' })
    assert(r.status === 401, 'DEMO_MODE=true → POST /api/internal/demo-reset com secret incorreto devolve 401', r.status)
  }
  delete process.env.DEMO_RESET_SECRET

  // =========================================================================
  // GRUPO G — DEMO_MODE=true: o CORE da demo continua mutável. Chamada REAL
  // a cada rota (não só a checagem estática do GRUPO H) — mocks mínimos
  // (ver instalarMockPrisma) fazem cada uma cair no seu próprio caminho de
  // "solicitação não encontrada" (404); o que se prova aqui é que a
  // resposta NUNCA é o 403 do gate de demo, não que a regra de negócio
  // completa funciona (já coberta pelos testes próprios de cada rota).
  // =========================================================================
  async function assertNaoBloqueadoPorDemo(resposta: Response, label: string) {
    const msg = await mensagemDemo(resposta)
    assert(msg !== MSG_DEMO, `${label} não é bloqueado pelo gate de demo (status ${resposta.status})`, msg)
  }

  {
    resetFixtures()
    instalarMockPrisma()
    instalarSessao(sessaoAdmin())
    const r = await chamarPostSolicitacoes({})
    await assertNaoBloqueadoPorDemo(r, 'DEMO_MODE=true → POST /api/solicitacoes (criar)')
  }
  {
    resetFixtures()
    instalarMockPrisma()
    instalarSessao(sessaoAdmin())
    const r = await chamarPostAprovarGestor('solicitacao-inexistente')
    await assertNaoBloqueadoPorDemo(r, 'DEMO_MODE=true → POST aprovar-gestor')
  }
  {
    resetFixtures()
    instalarMockPrisma()
    instalarSessao(sessaoAdmin())
    const r = await chamarPostSeparacao('solicitacao-inexistente')
    await assertNaoBloqueadoPorDemo(r, 'DEMO_MODE=true → POST separacao')
  }
  {
    resetFixtures()
    instalarMockPrisma()
    instalarSessao(sessaoAdmin())
    const r = await chamarPostRetirada('solicitacao-inexistente')
    await assertNaoBloqueadoPorDemo(r, 'DEMO_MODE=true → POST retirada')
  }
  {
    resetFixtures()
    instalarMockPrisma()
    instalarSessao(sessaoAdmin())
    const r = await chamarPostDevolucao('solicitacao-inexistente')
    await assertNaoBloqueadoPorDemo(r, 'DEMO_MODE=true → POST devolucao')
  }

  delete process.env.DEMO_MODE

  // =========================================================================
  // GRUPO H — verificação estática: as AÇÕES do fluxo de solicitações (tudo
  // que opera sobre um registro JÁ EXISTENTE — aprovar/rejeitar/separar/
  // retirar/devolver/cancelar/assinatura) nunca importam src/lib/demo-mode
  // (única forma de serem afetadas por DEMO_MODE). `solicitacoes/route.ts`
  // (POST = CRIAR) é a exceção deliberada desta etapa — ver GRUPO G acima —
  // e por isso é verificado à parte, com a asserção INVERTIDA (precisa
  // importar).
  // =========================================================================
  const ROTAS_ACOES_SOBRE_SOLICITACAO_EXISTENTE = [
    'src/app/api/solicitacoes/[id]/route.ts',
    'src/app/api/solicitacoes/[id]/aprovar-gestor/route.ts',
    'src/app/api/solicitacoes/[id]/rejeitar-gestor/route.ts',
    'src/app/api/solicitacoes/[id]/confirmar-patrimonio/route.ts',
    'src/app/api/solicitacoes/[id]/rejeitar-patrimonio/route.ts',
    'src/app/api/solicitacoes/[id]/separacao/route.ts',
    'src/app/api/solicitacoes/[id]/retirada/route.ts',
    'src/app/api/solicitacoes/[id]/devolucao/route.ts',
    'src/app/api/solicitacoes/[id]/nao-retirada/route.ts',
    'src/app/api/solicitacoes/[id]/cancelar/route.ts',
    'src/app/api/solicitacoes/[id]/assinatura/route.ts',
    'src/app/api/solicitacoes/[id]/assinatura/confirmar/route.ts',
  ]
  const raizProjeto = path.resolve(__dirname, '..')
  for (const rota of ROTAS_ACOES_SOBRE_SOLICITACAO_EXISTENTE) {
    const caminhoAbsoluto = path.join(raizProjeto, rota)
    const conteudo = fs.readFileSync(caminhoAbsoluto, 'utf8')
    assert(!conteudo.includes('demo-mode'), `Ação sobre solicitação existente permanece liberada: ${rota} não importa src/lib/demo-mode`)
  }
  {
    const conteudoCriacao = fs.readFileSync(path.join(raizProjeto, 'src/app/api/solicitacoes/route.ts'), 'utf8')
    assert(
      conteudoCriacao.includes("from '@/lib/demo-mode'"),
      'CRIAÇÃO de solicitação (src/app/api/solicitacoes/route.ts) importa src/lib/demo-mode de propósito (rate limit + limite global só em DEMO_MODE)'
    )
  }

  console.log(`\n${failures === 0 ? '✅ Todos os testes passaram.' : `❌ ${failures} teste(s) falharam.`}`)
  if (failures > 0) process.exit(1)
}

main()
