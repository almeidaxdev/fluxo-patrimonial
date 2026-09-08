// scripts/test-senha-hardening.ts
//
// Etapa security/input-hardening-b1 — Hardening de senhas e autenticação.
//
//   Parte 1 (A-H): `utf8ByteLength()`/`senhaDentroDoLimiteBcrypt()`/
//     `senhaNovaSchema` (src/lib/validations.ts) em isolamento — mínimo 8
//     CARACTERES / máximo 72 BYTES UTF-8 para senha NOVA, contagem de bytes
//     real (multibyte), e confirmação de que senha NUNCA sofre trim.
//   Parte 2 (I-J): PATCH/POST reais de login — senha de login sem mínimo de
//     8 (compatibilidade legada) e rejeição de senha acima de 72 bytes
//     ANTES de bcrypt.compare(), com a MESMA resposta genérica de
//     credenciais inválidas (nunca uma mensagem distinta/enumerável).
//   Parte 3 (K-M): cadastro público, criação administrativa de colaborador
//     — mesma regra de senha NOVA (min 8 / max 72 bytes) nos dois.
//   Parte 4 (N-O): alteração da própria senha — nova senha segue a regra de
//     senha NOVA; senha ATUAL segue a regra de LOGIN (sem mínimo,
//     compatível com uma senha atual legada mais curta que 8).
//   Parte 5 (P): reset administrativo — senha temporária gerada já respeita
//     os limites (sem alterar o gerador, já correto).
//   Parte 6 (Q-R): Rate Limit (S4) continua rodando ANTES de qualquer nova
//     checagem de senha desta etapa, em login E cadastro.
//
// Importa e chama os handlers REAIS das rotas — só prisma, getSession/
// setSession e @vercel/firewall (via require.cache, mesmo padrão de
// scripts/test-rate-limit.ts) são mocks em memória. bcryptjs roda DE
// VERDADE (mesmo padrão de scripts/test-colaboradores-reset-senha.ts).
// Nenhum banco real é acessado, nenhuma chamada real ao Firewall é feita.
//
// Executar com: npm run test:senha-hardening

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

  // --- Mock de @vercel/firewall via require.cache (mesmo padrão de scripts/test-rate-limit.ts) ---
  const firewallPath = require.resolve('@vercel/firewall')
  const rateLimitState = { rateLimited: false }
  async function fakeCheckRateLimit() {
    return { rateLimited: rateLimitState.rateLimited }
  }
  require.cache[firewallPath] = {
    id: firewallPath,
    filename: firewallPath,
    loaded: true,
    exports: { checkRateLimit: fakeCheckRateLimit, unstable_checkRateLimit: fakeCheckRateLimit },
  } as unknown as NodeModule

  // emailPermitidoSchema (usado pelas rotas de cadastro/colaboradores
  // chamadas abaixo) é fail-closed sem isto.
  process.env.ALLOWED_EMAIL_DOMAINS = 'example.com'

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { utf8ByteLength, senhaDentroDoLimiteBcrypt, senhaNovaSchema, unicodeCharacterLength } = require('../src/lib/validations')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { prisma } = require('../src/lib/prisma')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const authModule = require('../src/lib/auth')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const bcryptModule = require('bcryptjs')

  authModule.setSession = async () => {}

  const contadores = { compare: 0, findUnique: 0 }
  const compareOriginal = bcryptModule.compare.bind(bcryptModule)
  bcryptModule.compare = async (...args: Parameters<typeof compareOriginal>) => {
    contadores.compare++
    return compareOriginal(...args)
  }
  function resetarContadores() {
    contadores.compare = 0
    contadores.findUnique = 0
  }

  // ===========================================================================
  // Parte 1 — utf8ByteLength() / senhaDentroDoLimiteBcrypt() / senhaNovaSchema
  // em isolamento (A-H)
  // ===========================================================================

  // --- A) nova senha com 7 caracteres → rejeitada ------------------------------
  {
    const r = senhaNovaSchema.safeParse('abcdefg') // 7 chars
    assert(r.success === false, 'A) nova senha com 7 caracteres é rejeitada', r)
    if (!r.success) {
      assert(r.error.errors[0]?.message === 'Informe pelo menos 8 caracteres.', 'A) mensagem correta', r.error.errors[0])
    }
  }

  // --- B) nova senha com exatamente 8 caracteres → aceita ----------------------
  {
    const r = senhaNovaSchema.safeParse('abcdefgh') // 8 chars ASCII = 8 bytes
    assert(r.success === true, 'B) nova senha com exatamente 8 caracteres é aceita', r)
  }

  // --- C) nova senha com exatamente 72 bytes (ASCII) → aceita ------------------
  {
    const senha72 = 'a'.repeat(72)
    assert(utf8ByteLength(senha72) === 72, 'C) fixture tem exatamente 72 bytes', utf8ByteLength(senha72))
    const r = senhaNovaSchema.safeParse(senha72)
    assert(r.success === true, 'C) nova senha com exatamente 72 bytes é aceita (limite, não exclusivo)', r)
  }

  // --- D) nova senha com 73 bytes → rejeitada -----------------------------------
  {
    const senha73 = 'a'.repeat(73)
    const r = senhaNovaSchema.safeParse(senha73)
    assert(r.success === false, 'D) nova senha com 73 bytes é rejeitada', r)
    if (!r.success) {
      assert(r.error.errors[0]?.message === 'A senha excede o tamanho máximo permitido.', 'D) mensagem correta', r.error.errors[0])
    }
  }

  // --- E) senha Unicode com <=72 CARACTERES mas >72 BYTES → rejeitada ----------
  // 'á' ocupa 2 bytes em UTF-8 — 37 caracteres = 74 bytes (excede 72), mesmo
  // satisfazendo o mínimo de 8 caracteres com folga. Prova que `.length` de
  // string (UTF-16 code units, ~= caracteres aqui) NUNCA é usado como proxy
  // de bytes — só `utf8ByteLength()` (TextEncoder) decide o teto.
  {
    const senhaUnicode = 'á'.repeat(37)
    assert(senhaUnicode.length === 37, 'E) fixture tem 37 caracteres (<=72)', senhaUnicode.length)
    assert(utf8ByteLength(senhaUnicode) === 74, 'E) mas 74 bytes UTF-8 (>72)', utf8ByteLength(senhaUnicode))
    const r = senhaNovaSchema.safeParse(senhaUnicode)
    assert(r.success === false, 'E) senha Unicode com <=72 caracteres mas >72 bytes é rejeitada', r)
  }

  // --- F) senha Unicode dentro de 72 bytes → aceita -----------------------------
  {
    const senhaUnicode = 'á'.repeat(36) // 36 * 2 bytes = 72 bytes exatos
    assert(utf8ByteLength(senhaUnicode) === 72, 'F) fixture tem exatamente 72 bytes', utf8ByteLength(senhaUnicode))
    const r = senhaNovaSchema.safeParse(senhaUnicode)
    assert(r.success === true, 'F) senha Unicode dentro de 72 bytes (exatamente no limite) é aceita', r)
  }

  // --- G) senha com espaço INICIAL → espaço preservado (nunca trim) ------------
  {
    const senhaComEspaco = ' senhaComEspacoInicial123'
    const r = senhaNovaSchema.safeParse(senhaComEspaco)
    assert(r.success === true, 'G) senha com espaço inicial passa na validação', r)
    if (r.success) {
      assert(r.data === senhaComEspaco, 'G) espaço inicial é PRESERVADO no valor validado (sem trim)', r.data)
      assert(r.data.startsWith(' '), 'G) valor validado ainda começa com espaço', r.data)
    }
  }

  // --- H) senha com espaço FINAL → espaço preservado (nunca trim) --------------
  {
    const senhaComEspaco = 'senhaComEspacoFinal123 '
    const r = senhaNovaSchema.safeParse(senhaComEspaco)
    assert(r.success === true, 'H) senha com espaço final passa na validação', r)
    if (r.success) {
      assert(r.data === senhaComEspaco, 'H) espaço final é PRESERVADO no valor validado (sem trim)', r.data)
      assert(r.data.endsWith(' '), 'H) valor validado ainda termina com espaço', r.data)
    }
  }

  // --- S) 7 code points Unicode (emoji, surrogate pair) → rejeitada -----------
  // Cada emoji fora do BMP ocupa 2 unidades UTF-16 (`.length` conta 14) mas é
  // 1 único code point — prova que `unicodeCharacterLength()` (via
  // `[...valor]`), não `.length`, decide o mínimo.
  {
    const senha7Emojis = '😀'.repeat(7)
    assert(senha7Emojis.length === 14, 'S) fixture tem .length === 14 (UTF-16, surrogate pairs)', senha7Emojis.length)
    assert(unicodeCharacterLength(senha7Emojis) === 7, 'S) mas 7 code points reais', unicodeCharacterLength(senha7Emojis))
    const r = senhaNovaSchema.safeParse(senha7Emojis)
    assert(r.success === false, 'S) nova senha com 7 code points Unicode (emoji) é rejeitada', r)
    if (!r.success) {
      assert(r.error.errors[0]?.message === 'Informe pelo menos 8 caracteres.', 'S) mensagem correta', r.error.errors[0])
    }
  }

  // --- T) 8 code points Unicode (emoji) dentro de 72 bytes → aceita -----------
  // 😀 ocupa 4 bytes em UTF-8 — 8 emojis = 32 bytes, bem dentro do teto de 72.
  {
    const senha8Emojis = '😀'.repeat(8)
    assert(unicodeCharacterLength(senha8Emojis) === 8, 'T) fixture tem exatamente 8 code points', unicodeCharacterLength(senha8Emojis))
    assert(utf8ByteLength(senha8Emojis) === 32, 'T) e 32 bytes UTF-8 (<=72)', utf8ByteLength(senha8Emojis))
    const r = senhaNovaSchema.safeParse(senha8Emojis)
    assert(r.success === true, 'T) nova senha com 8 code points Unicode (emoji) dentro de 72 bytes é aceita', r)
  }

  // --- U) 4 emojis não satisfazem o mínimo de 8 -------------------------------
  {
    const senha4Emojis = '😀'.repeat(4)
    assert(unicodeCharacterLength(senha4Emojis) === 4, 'U) fixture tem 4 code points', unicodeCharacterLength(senha4Emojis))
    const r = senhaNovaSchema.safeParse(senha4Emojis)
    assert(r.success === false, 'U) nova senha com 4 emojis é rejeitada (abaixo do mínimo de 8)', r)
    if (!r.success) {
      assert(r.error.errors[0]?.message === 'Informe pelo menos 8 caracteres.', 'U) mensagem correta', r.error.errors[0])
    }
  }

  // Reforço direto do helper de bytes (usado por login/senha atual, fora do zod schema):
  assert(senhaDentroDoLimiteBcrypt('a'.repeat(72)) === true, 'Reforço) senhaDentroDoLimiteBcrypt: 72 bytes → true', undefined)
  assert(senhaDentroDoLimiteBcrypt('a'.repeat(73)) === false, 'Reforço) senhaDentroDoLimiteBcrypt: 73 bytes → false', undefined)
  assert(senhaDentroDoLimiteBcrypt('') === true, 'Reforço) senhaDentroDoLimiteBcrypt: string vazia → true (0 bytes, dentro do teto — não-vazio é checado à parte)', undefined)

  // ===========================================================================
  // Parte 2 — Login real (I-J)
  // ===========================================================================

  const SENHA_LOGIN_CURTA = 'abc12' // 5 caracteres — abaixo do mínimo de 8, mas login não tem mínimo
  const SENHA_LOGIN_HASH = await bcryptModule.hash(SENHA_LOGIN_CURTA, 12)
  const USER_LOGIN = {
    id: 'user-login-1',
    nome: 'Fulano Legado',
    email: 'fulano.legado@example.com',
    senha: SENHA_LOGIN_HASH,
    ativo: true,
    permissao: 'colaborador' as const,
    podeSerGestor: false,
    podeSolicitarParaOutro: false,
    versaoSessao: 0,
  }

  function instalarMockUserLogin() {
    prisma.user = {
      findUnique: async ({ where }: { where: { email: string } }) => {
        contadores.findUnique++
        return where.email === USER_LOGIN.email ? { ...USER_LOGIN } : null
      },
    }
  }

  async function postarLogin(body: Record<string, unknown>) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rota = require('../src/app/api/auth/login/route')
    const req = { json: async () => body } as unknown as Parameters<typeof rota.POST>[0]
    return rota.POST(req)
  }

  // --- I) senha de login com menos de 8 caracteres chega ao fluxo normal ------
  instalarMockUserLogin()
  resetarContadores()
  rateLimitState.rateLimited = false
  {
    const res = await postarLogin({ email: USER_LOGIN.email, senha: SENHA_LOGIN_CURTA })
    const body = await res.json()
    assert(res.status === 200, 'I) login com senha de 5 caracteres (< 8) retorna 200 — sem mínimo no login', res.status)
    assert(body.user?.id === USER_LOGIN.id, 'I) autentica o usuário correto', body.user)
    assert(contadores.compare === 1, 'I) bcrypt.compare foi chamado normalmente (não bloqueado por um mínimo inexistente)', contadores)
  }

  // --- J) login com senha >72 bytes é rejeitado ANTES de bcrypt.compare -------
  instalarMockUserLogin()
  resetarContadores()
  {
    const senhaEnorme = 'x'.repeat(100) // 100 bytes ASCII, > 72
    const res = await postarLogin({ email: USER_LOGIN.email, senha: senhaEnorme })
    const body = await res.json()
    assert(res.status === 401, 'J) login com senha de 100 bytes retorna 401', res.status)
    assert(body.message === 'E-mail ou senha inválidos.', 'J) MESMA mensagem genérica de credenciais inválidas (nunca menciona bytes/bcrypt)', body)
    assert(contadores.compare === 0, 'J) bcrypt.compare NUNCA foi chamado (rejeitado antes)', contadores)
  }

  // ===========================================================================
  // Parte 3 — Cadastro público e criação administrativa (K-M)
  // ===========================================================================

  async function postarCadastro(body: Record<string, unknown>) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rota = require('../src/app/api/auth/cadastro/route')
    const req = { json: async () => body, headers: new Headers({ 'x-real-ip': '203.0.113.50' }) } as unknown as Parameters<typeof rota.POST>[0]
    return rota.POST(req)
  }

  function instalarMockUserInexistente() {
    prisma.user = { findUnique: async () => { contadores.findUnique++; return null } }
    prisma.user.create = async ({ data }: { data: Record<string, unknown> }) => ({ id: 'novo-1', ...data })
  }

  // --- K) cadastro com senha < 8 caracteres → rejeitado ------------------------
  instalarMockUserInexistente()
  resetarContadores()
  rateLimitState.rateLimited = false
  {
    const res = await postarCadastro({ nome: 'Fulano de Tal', email: 'fulano@example.com', senha: 'curta1' }) // 6 chars
    const body = await res.json()
    assert(res.status === 400, 'K) cadastro com senha de 6 caracteres (< 8) é rejeitado com 400', res.status)
    assert(body.message === 'Informe pelo menos 8 caracteres.', 'K) mensagem correta', body)
  }

  // --- L) cadastro com senha > 72 bytes → rejeitado -----------------------------
  instalarMockUserInexistente()
  resetarContadores()
  {
    const res = await postarCadastro({ nome: 'Fulano de Tal', email: 'fulano2@example.com', senha: 'y'.repeat(80) })
    const body = await res.json()
    assert(res.status === 400, 'L) cadastro com senha de 80 bytes é rejeitado com 400', res.status)
    assert(body.message === 'A senha excede o tamanho máximo permitido.', 'L) mensagem correta', body)
  }

  // --- cadastro com senha válida (8-72) continua funcionando (sanidade) -------
  instalarMockUserInexistente()
  resetarContadores()
  {
    const res = await postarCadastro({ nome: 'Fulano de Tal', email: 'fulano3@example.com', senha: 'SenhaValida123' })
    assert(res.status === 201, 'Sanidade) cadastro com senha válida (14 chars) continua retornando 201', res.status)
  }

  // --- M) criação administrativa de colaborador segue a MESMA regra -----------
  const ADMIN_ID = 'user-admin-hardening-1'
  const adminFake = {
    id: ADMIN_ID,
    nome: 'Admin',
    email: 'admin@example.com',
    senha: '$2a$12$hashfake',
    permissao: 'administrador' as const,
    ativo: true,
    podeSerGestor: false,
    podeSolicitarParaOutro: false,
    gestorPadraoId: null as string | null,
    versaoSessao: 0,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  }
  function instalarMockAdminECriacao() {
    prisma.user = {
      findUnique: async ({ where }: { where: { id?: string; email?: string } }) => {
        if (where.id === ADMIN_ID) return { ...adminFake }
        return null // nenhum e-mail conflitante
      },
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'novo-colab-1', ...data }),
    }
  }
  function logarComoAdmin() {
    authModule.getSession = async () => ({
      id: adminFake.id, nome: adminFake.nome, email: adminFake.email, permissao: adminFake.permissao,
      podeSerGestor: adminFake.podeSerGestor, podeSolicitarParaOutro: adminFake.podeSolicitarParaOutro, versaoSessao: adminFake.versaoSessao,
    })
  }
  async function postarColaborador(body: Record<string, unknown>) {
    logarComoAdmin()
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rota = require('../src/app/api/colaboradores/route')
    const req = { json: async () => body } as unknown as Parameters<typeof rota.POST>[0]
    return rota.POST(req)
  }

  instalarMockAdminECriacao()
  {
    const resCurta = await postarColaborador({ nome: 'Novo Colaborador', email: 'novo1@example.com', senha: 'curta1', permissao: 'colaborador' })
    assert(resCurta.status === 400, 'M) criação administrativa com senha < 8 caracteres é rejeitada com 400', resCurta.status)

    const resLonga = await postarColaborador({ nome: 'Novo Colaborador', email: 'novo2@example.com', senha: 'z'.repeat(90), permissao: 'colaborador' })
    assert(resLonga.status === 400, 'M) criação administrativa com senha > 72 bytes é rejeitada com 400', resLonga.status)

    const resValida = await postarColaborador({ nome: 'Novo Colaborador', email: 'novo3@example.com', senha: 'SenhaValida123', permissao: 'colaborador' })
    assert(resValida.status === 201, 'M) criação administrativa com senha válida continua retornando 201', resValida.status)
  }

  // ===========================================================================
  // Parte 4 — Alteração da própria senha (N-O)
  // ===========================================================================

  const SENHA_ATUAL_LEGADA = 'abc12' // 5 caracteres — senha atual legada, mais curta que 8
  const senhaAtualHash = await bcryptModule.hash(SENHA_ATUAL_LEGADA, 12)
  const userSenhaFake = {
    id: 'user-senha-1',
    nome: 'Fulano',
    email: 'fulano.senha@example.com',
    senha: senhaAtualHash,
    ativo: true,
    permissao: 'colaborador' as const,
    podeSerGestor: false,
    podeSolicitarParaOutro: false,
    versaoSessao: 3,
  }
  function instalarMockUserSenha() {
    prisma.user = {
      findUnique: async ({ where }: { where: { id: string } }) => (where.id === userSenhaFake.id ? { ...userSenhaFake } : null),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        const { versaoSessao, ...resto } = data
        Object.assign(userSenhaFake, resto)
        if (versaoSessao && typeof versaoSessao === 'object' && 'increment' in (versaoSessao as Record<string, unknown>)) {
          userSenhaFake.versaoSessao += (versaoSessao as { increment: number }).increment
        }
        return { ...userSenhaFake }
      },
    }
  }
  function logarComoUserSenha() {
    authModule.getSession = async () => ({
      id: userSenhaFake.id, nome: userSenhaFake.nome, email: userSenhaFake.email, permissao: userSenhaFake.permissao,
      podeSerGestor: userSenhaFake.podeSerGestor, podeSolicitarParaOutro: userSenhaFake.podeSolicitarParaOutro, versaoSessao: userSenhaFake.versaoSessao,
    })
  }
  async function patchSenha(senhaAtual: string, novaSenha: string) {
    logarComoUserSenha()
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rota = require('../src/app/api/auth/senha/route')
    const req = { json: async () => ({ senhaAtual, novaSenha }) } as unknown as Parameters<typeof rota.PATCH>[0]
    return rota.PATCH(req)
  }

  // --- N) nova senha segue a MESMA regra (min 8 / max 72 bytes) ---------------
  instalarMockUserSenha()
  resetarContadores()
  {
    const resCurta = await patchSenha(SENHA_ATUAL_LEGADA, 'curta1') // 6 chars
    const bodyCurta = await resCurta.json()
    assert(resCurta.status === 400, 'N) nova senha com 6 caracteres é rejeitada com 400', resCurta.status)
    assert(bodyCurta.message === 'Informe pelo menos 8 caracteres.', 'N) mensagem correta (mínimo)', bodyCurta)

    const resLonga = await patchSenha(SENHA_ATUAL_LEGADA, 'w'.repeat(80))
    const bodyLonga = await resLonga.json()
    assert(resLonga.status === 400, 'N) nova senha com 80 bytes é rejeitada com 400', resLonga.status)
    assert(bodyLonga.message === 'A senha excede o tamanho máximo permitido.', 'N) mensagem correta (máximo)', bodyLonga)
  }

  // --- O) senha ATUAL legada (< 8 caracteres) ainda pode ser verificada -------
  instalarMockUserSenha()
  resetarContadores()
  {
    const res = await patchSenha(SENHA_ATUAL_LEGADA, 'NovaSenhaValida123')
    const body = await res.json()
    assert(res.status === 200, 'O) troca de senha com senha ATUAL legada (5 chars, < 8) é aceita — sem mínimo na senha atual', res.status)
    assert(contadores.compare === 1, 'O) bcrypt.compare foi chamado normalmente para a senha atual curta', contadores)
    assert(userSenhaFake.versaoSessao === 4, 'O) versaoSessao incrementou (troca de senha continua revogando a sessão)', userSenhaFake.versaoSessao)
    void body
  }

  // --- senha ATUAL > 72 bytes é rejeitada ANTES de bcrypt.compare (mesma
  // mensagem de "senha atual incorreta", nunca uma mensagem distinta) ---------
  instalarMockUserSenha()
  resetarContadores()
  {
    const res = await patchSenha('v'.repeat(100), 'NovaSenhaValida123')
    const body = await res.json()
    assert(res.status === 400, 'Reforço O) senha atual com 100 bytes é rejeitada com 400', res.status)
    assert(body.message === 'Senha atual incorreta.', 'Reforço O) MESMA mensagem de senha atual incorreta (nunca menciona bytes)', body)
    assert(contadores.compare === 0, 'Reforço O) bcrypt.compare NUNCA foi chamado (rejeitado antes)', contadores)
  }

  // ===========================================================================
  // Parte 5 — Reset administrativo (P)
  // ===========================================================================

  const legadoParaResetFake = {
    id: 'user-reset-1',
    nome: 'Alvo Reset',
    email: 'alvo.reset@example.com',
    senha: '$2a$12$hashfake',
    permissao: 'colaborador' as const,
    ativo: true,
    podeSerGestor: false,
    podeSolicitarParaOutro: false,
    gestorPadraoId: null as string | null,
    versaoSessao: 0,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  }
  function instalarMockAdminEReset() {
    prisma.user = {
      findUnique: async ({ where }: { where: { id?: string } }) => {
        if (where.id === ADMIN_ID) return { ...adminFake }
        if (where.id === legadoParaResetFake.id) return { ...legadoParaResetFake }
        return null
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        const { versaoSessao, ...resto } = data
        Object.assign(legadoParaResetFake, resto)
        if (versaoSessao && typeof versaoSessao === 'object' && 'increment' in (versaoSessao as Record<string, unknown>)) {
          legadoParaResetFake.versaoSessao += (versaoSessao as { increment: number }).increment
        }
        return { ...legadoParaResetFake }
      },
    }
  }
  async function patchResetSenha() {
    logarComoAdmin()
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rota = require('../src/app/api/colaboradores/[id]/route')
    const req = { json: async () => ({ resetSenha: true }) } as unknown as Parameters<typeof rota.PATCH>[0]
    return rota.PATCH(req, { params: Promise.resolve({ id: legadoParaResetFake.id }) })
  }

  instalarMockAdminEReset()
  {
    const res = await patchResetSenha()
    const body = await res.json()
    assert(res.status === 200, 'P) reset administrativo retorna 200', res.status)
    const senhaTemporaria: string = body.senhaTemporaria
    assert(typeof senhaTemporaria === 'string' && senhaTemporaria.length > 0, 'P) senha temporária foi gerada', senhaTemporaria)
    assert(senhaTemporaria.length >= 8, 'P) senha temporária gerada tem >= 8 caracteres', senhaTemporaria.length)
    assert(utf8ByteLength(senhaTemporaria) <= 72, 'P) senha temporária gerada tem <= 72 bytes UTF-8', utf8ByteLength(senhaTemporaria))
    assert(/^[\x00-\x7F]*$/.test(senhaTemporaria), 'P) senha temporária é só ASCII (1 byte por caractere — gerador não foi alterado)', senhaTemporaria)
  }

  // ===========================================================================
  // Parte 6 — Rate Limit (S4) continua ANTES das novas checagens de senha (Q-R)
  // ===========================================================================

  // --- Q) login rate-limited: mesmo com senha ABSURDAMENTE grande (que a
  // checagem desta etapa rejeitaria), a resposta continua sendo 429 do rate
  // limit — nunca a nova checagem de bytes "vazando" um 401/400 antes dele. ---
  instalarMockUserLogin()
  resetarContadores()
  rateLimitState.rateLimited = true
  {
    const res = await postarLogin({ email: USER_LOGIN.email, senha: 'x'.repeat(500) })
    assert(res.status === 429, 'Q) login rate-limited retorna 429 mesmo com senha de 500 bytes (rate limit roda ANTES da checagem de tamanho)', res.status)
    assert(contadores.findUnique === 0, 'Q) prisma.user.findUnique NÃO foi chamado', contadores)
    assert(contadores.compare === 0, 'Q) bcrypt.compare NÃO foi chamado', contadores)
  }
  rateLimitState.rateLimited = false

  // --- R) cadastro rate-limited: mesmo com senha de 2 caracteres (que a nova
  // checagem de mínimo rejeitaria com 400), a resposta continua 429. ----------
  instalarMockUserInexistente()
  resetarContadores()
  rateLimitState.rateLimited = true
  {
    const res = await postarCadastro({ nome: 'X', email: 'x@example.com', senha: 'ab' })
    assert(res.status === 429, 'R) cadastro rate-limited retorna 429 mesmo com senha de 2 caracteres (rate limit roda ANTES da validação de senha)', res.status)
    assert(contadores.findUnique === 0, 'R) prisma.user.findUnique (duplicidade) NÃO foi chamado', contadores)
  }
  rateLimitState.rateLimited = false

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) de hardening de senha (security/input-hardening-b1) falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes de hardening de senha passaram. Nenhuma chamada real ao Firewall, nenhum banco real acessado.')
}

main().catch((err) => {
  console.error('Falha inesperada ao executar os testes de hardening de senha:', err instanceof Error ? err.message : err)
  process.exit(1)
})
