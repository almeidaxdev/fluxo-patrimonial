// scripts/test-session-revalidation.ts
//
// Teste manual (mesmo padrão de scripts/test-colaboradores-reset-senha.ts) da
// Etapa security/session-revocation — parte revalidação + gatilhos:
//
//   Parte 1 (A-J): getValidatedMutationSession() (src/lib/session-validation.ts)
//     em isolamento — chamada diretamente, sem passar por nenhuma rota.
//   Parte 2 (K-S): gatilhos reais de versaoSessao — chama os handlers REAIS
//     de PATCH /api/colaboradores/[id] e PATCH /api/auth/senha para provar
//     QUAIS mudanças incrementam a versão (e quais não incrementam).
//   Parte 3 (T-U): fim a fim — uma sessão que perde a validade PORQUE um
//     gatilho disparou enquanto ela existia (não porque expirou) deixa de
//     conseguir mutar em qualquer rota protegida (aqui, PATCH
//     /api/notificacoes/[id]), mesmo com o JWT ainda "vivo".
//
// Complementa scripts/test-session-jwt.ts (que cobre só sign/verify/exp do
// JWT) e scripts/test-colaboradores-reset-senha.ts (que cobre a geração da
// senha temporária em si, não os gatilhos de versaoSessao). Referenciado a
// partir do teste C) de test-session-jwt.ts.
//
// Importa e chama os handlers REAIS das rotas (não reimplementações) — só
// prisma e getSession/setSession são mocks em memória (mesma técnica de
// scripts/test-colaboradores-reset-senha.ts). Não abre conexão real com o
// banco, não roda nenhum SQL/migração.
//
// Executar com: npm run test:session-revalidation

export {}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { prisma } = require('../src/lib/prisma')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const authModule = require('../src/lib/auth')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bcrypt = require('bcryptjs')

let failures = 0

function assert(condition: boolean, label: string, detalhe?: unknown) {
  if (condition) {
    console.log(`OK   - ${label}`)
  } else {
    failures++
    console.error(`FALHA - ${label}${detalhe !== undefined ? ` (${JSON.stringify(detalhe)})` : ''}`)
  }
}

// --- Fixtures --------------------------------------------------------------

interface UserFake {
  id: string
  nome: string
  email: string
  senha: string
  permissao: 'colaborador' | 'patrimonio' | 'administrador'
  ativo: boolean
  podeSerGestor: boolean
  podeSolicitarParaOutro: boolean
  gestorPadraoId: string | null
  versaoSessao: number
  createdAt: Date
}

interface SessaoFake {
  id: string
  nome: string
  email: string
  permissao: string
  podeSerGestor?: boolean
  podeSolicitarParaOutro?: boolean
  versaoSessao?: number
}

interface NotificacaoFake {
  id: string
  usuarioId: string
  lida: boolean
}

const ADMIN_ID = 'user-admin-1'
const ALVO_ID = 'user-alvo-1'
const COLEGA_ID = 'user-colega-1'
const PATRIMONIO_ID = 'user-patrimonio-1'
const NOTIFICACAO_ID = 'notif-1'

let adminFake: UserFake
let alvoFake: UserFake
let colegaFake: UserFake
let patrimonioFake: UserFake
let notificacaoFake: NotificacaoFake
let updateCallsUser: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>

function usuarioBase(overrides: Partial<UserFake> & { id: string }): UserFake {
  return {
    nome: 'Fulano',
    email: `${overrides.id}@example.com`,
    senha: '$2a$12$hashfake',
    permissao: 'colaborador',
    ativo: true,
    podeSerGestor: false,
    podeSolicitarParaOutro: false,
    gestorPadraoId: null,
    versaoSessao: 0,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  }
}

async function resetMocks() {
  adminFake = usuarioBase({ id: ADMIN_ID, nome: 'Admin', permissao: 'administrador', senha: await bcrypt.hash('senhaAdmin@123', 12) })
  alvoFake = usuarioBase({ id: ALVO_ID, nome: 'Alvo', senha: await bcrypt.hash('senhaAlvo@123', 12) })
  colegaFake = usuarioBase({ id: COLEGA_ID, nome: 'Colega' })
  patrimonioFake = usuarioBase({ id: PATRIMONIO_ID, nome: 'Patrimonio', permissao: 'patrimonio' })
  notificacaoFake = { id: NOTIFICACAO_ID, usuarioId: ALVO_ID, lida: false }
  updateCallsUser = []
}

function usuarioPorId(id: string): UserFake | null {
  if (id === adminFake.id) return adminFake
  if (id === alvoFake.id) return alvoFake
  if (id === colegaFake.id) return colegaFake
  if (id === patrimonioFake.id) return patrimonioFake
  return null
}

function instalarMockPrisma() {
  prisma.user = {
    findUnique: async ({ where }: { where: { id?: string; email?: string }; select?: Record<string, boolean> }) => {
      const u = where.id ? usuarioPorId(where.id) : null
      return u ? { ...u } : null
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      updateCallsUser.push({ where, data })
      const u = usuarioPorId(where.id)
      if (!u) throw new Error('Usuário não encontrado (mock).')
      const { versaoSessao, ...resto } = data
      Object.assign(u, resto)
      if (versaoSessao && typeof versaoSessao === 'object' && 'increment' in (versaoSessao as Record<string, unknown>)) {
        u.versaoSessao += (versaoSessao as { increment: number }).increment
      }
      return {
        id: u.id,
        nome: u.nome,
        email: u.email,
        permissao: u.permissao,
        ativo: u.ativo,
        podeSerGestor: u.podeSerGestor,
        podeSolicitarParaOutro: u.podeSolicitarParaOutro,
        gestorPadraoId: u.gestorPadraoId,
        createdAt: u.createdAt,
      }
    },
  }
  prisma.notificacao = {
    findUnique: async ({ where }: { where: { id: string } }) => (where.id === notificacaoFake.id ? { ...notificacaoFake } : null),
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      if (where.id !== notificacaoFake.id) throw new Error('Notificação não encontrada (mock).')
      Object.assign(notificacaoFake, data)
      return { ...notificacaoFake }
    },
  }
  // Usados só pelos testes V)/W) (GETs privilegiados revalidados) — o
  // conteúdo retornado não importa para esses testes, só o STATUS da
  // resposta da rota (200/401/403), então findMany/count ficam vazios.
  prisma.patrimonio = {
    findMany: async () => [],
    count: async () => 0,
  }
  prisma.solicitacao = {
    findMany: async () => [],
    count: async () => 0,
  }
}

function instalarMockAuth(sessao: SessaoFake | null) {
  authModule.getSession = async () => (sessao ? { ...sessao } : null)
  authModule.setSession = async () => {}
}

function sessaoDe(user: UserFake, overrides: Partial<SessaoFake> = {}): SessaoFake {
  return {
    id: user.id,
    nome: user.nome,
    email: user.email,
    permissao: user.permissao,
    podeSerGestor: user.podeSerGestor,
    podeSolicitarParaOutro: user.podeSolicitarParaOutro,
    versaoSessao: user.versaoSessao,
    ...overrides,
  }
}

async function validar() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sessionValidation = require('../src/lib/session-validation')
  return sessionValidation.getValidatedMutationSession()
}

async function patchColaborador(sessao: SessaoFake | null, alvoId: string, body: Record<string, unknown>) {
  instalarMockAuth(sessao)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rota = require('../src/app/api/colaboradores/[id]/route')
  const req = { json: async () => body } as unknown as Parameters<typeof rota.PATCH>[0]
  return rota.PATCH(req, { params: Promise.resolve({ id: alvoId }) })
}

async function patchSenha(sessao: SessaoFake | null, senhaAtual: string, novaSenha: string) {
  instalarMockAuth(sessao)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rota = require('../src/app/api/auth/senha/route')
  const req = { json: async () => ({ senhaAtual, novaSenha }) } as unknown as Parameters<typeof rota.PATCH>[0]
  return rota.PATCH(req)
}

async function patchNotificacaoLida(sessao: SessaoFake | null) {
  instalarMockAuth(sessao)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rota = require('../src/app/api/notificacoes/[id]/route')
  return rota.PATCH({} as never, { params: Promise.resolve({ id: NOTIFICACAO_ID }) })
}

async function getPatrimonios(sessao: SessaoFake | null) {
  instalarMockAuth(sessao)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rota = require('../src/app/api/patrimonios/route')
  const req = { url: 'http://localhost/api/patrimonios' } as unknown as Parameters<typeof rota.GET>[0]
  return rota.GET(req)
}

async function getSolicitacoes(sessao: SessaoFake | null, querystring: string) {
  instalarMockAuth(sessao)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rota = require('../src/app/api/solicitacoes/route')
  const req = { url: `http://localhost/api/solicitacoes${querystring}` } as unknown as Parameters<typeof rota.GET>[0]
  return rota.GET(req)
}

const MENSAGEM_SESSAO_INVALIDA = 'Sessão inválida ou expirada. Faça login novamente.'

async function main() {
  instalarMockPrisma()

  // ===========================================================================
  // Parte 1 — getValidatedMutationSession() em isolamento (A-J)
  // ===========================================================================

  // --- A) sem sessão (getSession() retorna null) -----------------------------
  await resetMocks()
  {
    instalarMockAuth(null)
    const resultado = await validar()
    assert(resultado.valido === false, 'A) sem cookie de sessão: valido é false', resultado)
    if (!resultado.valido) {
      assert(resultado.resposta.status === 401, 'A) resposta é 401', resultado.resposta.status)
      const body = await resultado.resposta.clone().json()
      assert(body.message === MENSAGEM_SESSAO_INVALIDA, 'A) mensagem genérica padronizada', body)
    }
  }

  // --- B) sessão sem a claim versaoSessao (token pré-S5) ----------------------
  await resetMocks()
  {
    const { versaoSessao, ...semVersao } = sessaoDe(alvoFake)
    instalarMockAuth(semVersao as SessaoFake)
    const resultado = await validar()
    assert(resultado.valido === false, 'B) sessão sem claim versaoSessao (token pré-S5): rejeitada', resultado)
    assert(updateCallsUser.length === 0, 'B) rejeitada ANTES de qualquer consulta ao banco (sem update, e nenhum find nesta rodada)', updateCallsUser)
  }

  // --- C) sessão aponta para usuário que não existe mais (removido) ----------
  await resetMocks()
  {
    instalarMockAuth(sessaoDe({ ...alvoFake, id: 'usuario-removido' }))
    const resultado = await validar()
    assert(resultado.valido === false, 'C) usuário do token não existe mais no banco: rejeitada', resultado)
  }

  // --- D) usuário existe mas está desativado (ativo=false) --------------------
  await resetMocks()
  {
    alvoFake.ativo = false
    instalarMockAuth(sessaoDe({ ...alvoFake, ativo: true })) // claim antiga: token emitido quando ainda estava ativo
    const resultado = await validar()
    assert(resultado.valido === false, 'D) usuário desativado no banco: rejeitada mesmo com claim antiga dizendo ativo', resultado)
  }

  // --- E) versaoSessao do banco diverge da claim do token ---------------------
  await resetMocks()
  {
    instalarMockAuth(sessaoDe(alvoFake, { versaoSessao: 0 }))
    alvoFake.versaoSessao = 1 // simula gatilho disparado depois que o token foi emitido
    const resultado = await validar()
    assert(resultado.valido === false, 'E) versaoSessao do banco (1) != claim do token (0): rejeitada', resultado)
  }

  // --- F) sessão válida (tudo bate): aceita e devolve dados FRESCOS do banco --
  await resetMocks()
  {
    alvoFake.permissao = 'patrimonio' // mudou no banco DEPOIS do login
    instalarMockAuth(sessaoDe({ ...alvoFake, permissao: 'colaborador' })) // claim antiga do JWT
    const resultado = await validar()
    assert(resultado.valido === true, 'F) tudo bate: sessão aceita', resultado)
    if (resultado.valido) {
      assert(resultado.user.permissao === 'patrimonio', 'F) user devolvido usa permissao ATUAL do banco, não a claim antiga do JWT', resultado.user)
      assert(!('versaoSessao' in resultado.user), 'F) user devolvido não expõe versaoSessao (ValidatedUser omite o campo)', resultado.user)
    }
  }

  // --- G) resposta de sessão inválida sempre limpa o cookie "session" --------
  await resetMocks()
  {
    instalarMockAuth(null)
    const resultado = await validar()
    if (!resultado.valido) {
      const cookieSession = resultado.resposta.cookies.get('session')
      assert(cookieSession?.value === '', 'G) cookie "session" é limpo (valor vazio) na resposta de sessão inválida', cookieSession)
    } else {
      assert(false, 'G) (setup inválido: deveria ter caído no ramo inválido)')
    }
  }

  // --- H) mensagem de erro é IDÊNTICA em todos os motivos de rejeição --------
  // (nunca revela se foi usuário inexistente, desativado, versão divergente
  // ou token pré-S5 — impede enumeração/fingerprinting pelo cliente).
  await resetMocks()
  {
    const mensagens: string[] = []

    instalarMockAuth(null)
    mensagens.push((await (await validar()).resposta?.clone().json())?.message)

    instalarMockAuth(sessaoDe({ ...alvoFake, id: 'inexistente' }))
    mensagens.push((await (await validar()).resposta?.clone().json())?.message)

    alvoFake.ativo = false
    instalarMockAuth(sessaoDe({ ...alvoFake, ativo: true }))
    mensagens.push((await (await validar()).resposta?.clone().json())?.message)
    alvoFake.ativo = true

    instalarMockAuth(sessaoDe(alvoFake, { versaoSessao: 999 }))
    mensagens.push((await (await validar()).resposta?.clone().json())?.message)

    assert(mensagens.every((m) => m === MENSAGEM_SESSAO_INVALIDA), 'H) todos os motivos de rejeição usam a MESMA mensagem genérica', mensagens)
  }

  // --- I) versaoSessao=0 explícito no token (usuário nunca revogado) continua
  //        válido — 0 é um valor legítimo, só a AUSÊNCIA da claim é rejeitada
  //        (garante que não existe fallback ?? 0 tratando ausência como 0). ---
  await resetMocks()
  {
    alvoFake.versaoSessao = 0
    instalarMockAuth(sessaoDe(alvoFake, { versaoSessao: 0 }))
    const resultado = await validar()
    assert(resultado.valido === true, 'I) versaoSessao=0 explícito (nunca revogado) é válido, não confundido com claim ausente', resultado)
  }

  // --- J) ÚNICA consulta ao banco por chamada válida --------------------------
  await resetMocks()
  {
    let chamadasFindUnique = 0
    const findUniqueOriginal = prisma.user.findUnique
    prisma.user.findUnique = async (...args: unknown[]) => {
      chamadasFindUnique++
      return findUniqueOriginal(...(args as Parameters<typeof findUniqueOriginal>))
    }
    instalarMockAuth(sessaoDe(alvoFake))
    await validar()
    assert(chamadasFindUnique === 1, 'J) getValidatedMutationSession() faz exatamente 1 consulta ao banco por chamada', chamadasFindUnique)
    prisma.user.findUnique = findUniqueOriginal
  }

  // ===========================================================================
  // Parte 1.1 — GET /api/auth/me (Etapa fix/collaborator-session-sync): usa
  // getValidatedMutationSession() por baixo — mesma revalidação, endpoint
  // dedicado que o frontend chama estrategicamente (montagem, foco da
  // janela, aba visível) para nunca continuar exibindo permissões
  // desatualizadas. (AA-AF)
  // ===========================================================================

  async function getAuthMe() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rota = require('../src/app/api/auth/me/route')
    return rota.GET()
  }

  // --- AA) sessão válida (versão bate, usuário ativo) → 200 -------------------
  await resetMocks()
  {
    instalarMockAuth(sessaoDe(alvoFake))
    const res = await getAuthMe()
    assert(res.status === 200, 'AA) GET /api/auth/me com sessão válida retorna 200', res.status)
  }

  // --- AB) versaoSessao divergente → 401 ---------------------------------------
  await resetMocks()
  {
    instalarMockAuth(sessaoDe(alvoFake, { versaoSessao: 0 }))
    alvoFake.versaoSessao = 1 // gatilho disparou depois do login
    const res = await getAuthMe()
    assert(res.status === 401, 'AB) GET /api/auth/me com versaoSessao divergente retorna 401', res.status)
  }

  // --- AC) usuário inativo → 401 -----------------------------------------------
  await resetMocks()
  {
    alvoFake.ativo = false
    instalarMockAuth(sessaoDe({ ...alvoFake, ativo: true }))
    const res = await getAuthMe()
    assert(res.status === 401, 'AC) GET /api/auth/me com usuário inativo no banco retorna 401', res.status)
  }

  // --- AD) token antigo sem a claim versaoSessao → 401 -------------------------
  await resetMocks()
  {
    const { versaoSessao, ...semVersao } = sessaoDe(alvoFake)
    instalarMockAuth(semVersao as SessaoFake)
    const res = await getAuthMe()
    assert(res.status === 401, 'AD) GET /api/auth/me com token pré-S5 (sem versaoSessao) retorna 401', res.status)
  }

  // --- AE) dados devolvidos vêm do banco ATUAL, não da claim do JWT -----------
  await resetMocks()
  {
    alvoFake.permissao = 'patrimonio' // mudou no banco DEPOIS do login
    instalarMockAuth(sessaoDe({ ...alvoFake, permissao: 'colaborador' })) // claim antiga
    const res = await getAuthMe()
    const body = await res.json()
    assert(body.user?.permissao === 'patrimonio', 'AE) GET /api/auth/me devolve permissao ATUAL do banco, não a claim antiga do JWT', body.user)
    assert(body.user?.ativo === true, 'AE) GET /api/auth/me devolve ativo=true explicitamente (não omitido)', body.user)
    assert(!('versaoSessao' in body.user), 'AE) GET /api/auth/me nunca expõe versaoSessao ao client', body.user)
  }

  // --- AE1) GET /api/auth/me devolve gestorPadraoId do PRÓPRIO usuário autenticado
  // Etapa fix/default-manager-self-request — causa raiz do bug "gestor padrão
  // não é pré-selecionado quando o colaborador solicita para si": este
  // endpoint (fonte de `user` no AuthProvider/useSession, consumido por
  // Nova Solicitação) simplesmente não devolvia `gestorPadraoId` do usuário
  // autenticado (só o objeto do colaborador escolhido em "solicitar para
  // outro", vindo de /api/colaboradores/busca, trazia esse campo). Testes
  // AE1/AE2 replicam COL-01/COL-02 do relato: colaborador comum com gestor
  // padrão configurado, pedindo para SI mesmo.
  await resetMocks()
  {
    const gestor = usuarioBase({ id: 'user-gestor-padrao-1', nome: 'Paulo Ribeiro', podeSerGestor: true })
    alvoFake.gestorPadraoId = gestor.id // COL-01
    instalarMockAuth(sessaoDe(alvoFake))
    const res = await getAuthMe()
    const body = await res.json()
    assert(body.user?.gestorPadraoId === gestor.id, 'AE1) GET /api/auth/me devolve gestorPadraoId do usuário autenticado (COL-01 para si)', body.user)
  }

  // --- AE2) mesmo campo para um segundo colaborador com o mesmo gestor padrão -
  await resetMocks()
  {
    const gestor = usuarioBase({ id: 'user-gestor-padrao-1', nome: 'Paulo Ribeiro', podeSerGestor: true })
    colegaFake.gestorPadraoId = gestor.id // COL-02
    instalarMockAuth(sessaoDe(colegaFake))
    const res = await getAuthMe()
    const body = await res.json()
    assert(body.user?.gestorPadraoId === gestor.id, 'AE2) GET /api/auth/me devolve gestorPadraoId do usuário autenticado (COL-02 para si)', body.user)
  }

  // --- AE3) sem gestor padrão configurado → campo null, nunca omitido/errado --
  await resetMocks()
  {
    alvoFake.gestorPadraoId = null
    instalarMockAuth(sessaoDe(alvoFake))
    const res = await getAuthMe()
    const body = await res.json()
    assert(body.user?.gestorPadraoId === null, 'AE3) GET /api/auth/me devolve gestorPadraoId=null quando o usuário autenticado não tem gestor padrão', body.user)
  }

  // --- AF) middleware continua sem Prisma (sem consulta ao banco na navegação) -
  // Checagem estática do próprio arquivo-fonte: garante que ninguém
  // reintroduziu um import de Prisma em src/middleware.ts nesta etapa — a
  // revalidação dinâmica vive só em GET /api/auth/me + AuthProvider
  // (client), nunca no middleware.
  {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs')
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path')
    const codigoMiddleware = fs.readFileSync(path.join(__dirname, '..', 'src', 'middleware.ts'), 'utf8') as string
    assert(!/prisma/i.test(codigoMiddleware), 'AF) src/middleware.ts não contém nenhuma referência a Prisma (nem import, nem uso)', codigoMiddleware.slice(0, 200))
    assert(codigoMiddleware.includes('verifyToken'), 'AF) src/middleware.ts continua validando só assinatura/expiração via verifyToken()', true)
  }

  // ===========================================================================
  // Parte 2 — Gatilhos reais de versaoSessao via PATCH /api/colaboradores/[id]
  // e PATCH /api/auth/senha (K-S)
  // ===========================================================================

  const ADMIN_SESSION = () => sessaoDe(adminFake)

  // --- K) mudar permissao incrementa versaoSessao do ALVO ---------------------
  await resetMocks()
  {
    const versaoAntes = alvoFake.versaoSessao
    await patchColaborador(ADMIN_SESSION(), ALVO_ID, { permissao: 'patrimonio' })
    assert(alvoFake.versaoSessao === versaoAntes + 1, 'K) mudar permissao incrementa versaoSessao em exatamente 1', alvoFake.versaoSessao)
  }

  // --- L) desativar (ativo true→false) incrementa -----------------------------
  await resetMocks()
  {
    const versaoAntes = alvoFake.versaoSessao
    await patchColaborador(ADMIN_SESSION(), ALVO_ID, { ativo: false })
    assert(alvoFake.versaoSessao === versaoAntes + 1, 'L) desativar (true→false) incrementa versaoSessao', alvoFake.versaoSessao)
  }

  // --- M) reativar (ativo false→true) TAMBÉM incrementa (não só desativar) ---
  await resetMocks()
  {
    alvoFake.ativo = false
    const versaoAntes = alvoFake.versaoSessao
    await patchColaborador(ADMIN_SESSION(), ALVO_ID, { ativo: true })
    assert(alvoFake.versaoSessao === versaoAntes + 1, 'M) reativar (false→true) TAMBÉM incrementa versaoSessao', alvoFake.versaoSessao)
  }

  // --- N) mudar podeSerGestor incrementa --------------------------------------
  await resetMocks()
  {
    const versaoAntes = alvoFake.versaoSessao
    await patchColaborador(ADMIN_SESSION(), ALVO_ID, { podeSerGestor: true })
    assert(alvoFake.versaoSessao === versaoAntes + 1, 'N) mudar podeSerGestor incrementa versaoSessao', alvoFake.versaoSessao)
  }

  // --- O) mudar podeSolicitarParaOutro incrementa ------------------------------
  await resetMocks()
  {
    const versaoAntes = alvoFake.versaoSessao
    await patchColaborador(ADMIN_SESSION(), ALVO_ID, { podeSolicitarParaOutro: true })
    assert(alvoFake.versaoSessao === versaoAntes + 1, 'O) mudar podeSolicitarParaOutro incrementa versaoSessao', alvoFake.versaoSessao)
  }

  // --- P) resetSenha administrativo incrementa --------------------------------
  await resetMocks()
  {
    const versaoAntes = alvoFake.versaoSessao
    await patchColaborador(ADMIN_SESSION(), ALVO_ID, { resetSenha: true })
    assert(alvoFake.versaoSessao === versaoAntes + 1, 'P) resetSenha administrativo incrementa versaoSessao', alvoFake.versaoSessao)
  }

  // --- Q) mudar SÓ nome/gestorPadraoId (campos sem impacto de segurança) NÃO
  //        incrementa — nome não é campo-gatilho. --------------------------
  await resetMocks()
  {
    const versaoAntes = alvoFake.versaoSessao
    await patchColaborador(ADMIN_SESSION(), ALVO_ID, { gestorPadraoId: COLEGA_ID })
    assert(alvoFake.versaoSessao === versaoAntes, 'Q) mudar só gestorPadraoId (não é gatilho) NÃO incrementa versaoSessao', alvoFake.versaoSessao)
  }

  // --- R) reenviar o MESMO valor já vigente NÃO incrementa (sem no-op custoso) -
  await resetMocks()
  {
    alvoFake.permissao = 'patrimonio'
    const versaoAntes = alvoFake.versaoSessao
    await patchColaborador(ADMIN_SESSION(), ALVO_ID, { permissao: 'patrimonio' })
    assert(alvoFake.versaoSessao === versaoAntes, 'R) reenviar o valor JÁ vigente de permissao não incrementa (comparação real, não presença do campo)', alvoFake.versaoSessao)
  }

  // --- S) troca da PRÓPRIA senha (PATCH /api/auth/senha) incrementa a versão
  //        do próprio usuário --------------------------------------------------
  await resetMocks()
  {
    const versaoAntes = alvoFake.versaoSessao
    const res = await patchSenha(sessaoDe(alvoFake), 'senhaAlvo@123', 'novaSenhaForte@456')
    assert(res.status === 200, 'S) troca da própria senha retorna 200', res.status)
    assert(alvoFake.versaoSessao === versaoAntes + 1, 'S) troca da própria senha incrementa a própria versaoSessao', alvoFake.versaoSessao)
    const cookieSession = res.cookies.get('session')
    assert(cookieSession?.value === '', 'S) cookie "session" da sessão que trocou a senha também é limpo (força novo login)', cookieSession)
  }

  // ===========================================================================
  // Parte 2.1 — GETs "privilegiados" que ganharam revalidação seletiva nesta
  // rodada de fechamento da S5: GET /api/patrimonios (rota inteira exclusiva
  // de Patrimônio/Admin) e GET /api/solicitacoes?escopo=todas (só este ramo)
  // (V-W). Prova que um usuário rebaixado deixa de ler esses dados amplos
  // pela MESMA sessão antiga, sem esperar o JWT expirar — e que os ramos
  // COMUNS (escopo=minhas/gestor) continuam sem revalidação (sem round-trip
  // extra), confirmando que a mudança foi seletiva, não global.
  // ===========================================================================

  // --- V) GET /api/patrimonios (privilegiado — rota inteira Patrimônio/Admin)
  await resetMocks()
  {
    const sessaoPatrimonio = sessaoDe(patrimonioFake) // capturada ANTES do rebaixamento

    const resAntes = await getPatrimonios(sessaoPatrimonio)
    assert(resAntes.status === 200, 'V) GET /api/patrimonios com sessão válida de Patrimônio retorna 200', resAntes.status)

    // Admin rebaixa o usuário de Patrimônio para colaborador — dispara o
    // gatilho de versaoSessao (mesmo mecanismo de K)).
    await patchColaborador(ADMIN_SESSION(), PATRIMONIO_ID, { permissao: 'colaborador' })

    const resDepois = await getPatrimonios(sessaoPatrimonio) // MESMA sessão antiga, token ainda "vivo"
    assert(
      resDepois.status === 401,
      'V) após rebaixamento, a MESMA sessão antiga é rejeitada com 401 no GET privilegiado (não fica lendo o inventário completo até o JWT expirar)',
      resDepois.status
    )
  }

  // --- W) GET /api/solicitacoes?escopo=todas (privilegiado, só este ramo) ---
  await resetMocks()
  {
    const sessaoPatrimonio = sessaoDe(patrimonioFake) // capturada ANTES do rebaixamento

    const resAntes = await getSolicitacoes(sessaoPatrimonio, '?escopo=todas')
    assert(resAntes.status === 200, 'W) GET /api/solicitacoes?escopo=todas com sessão válida de Patrimônio retorna 200', resAntes.status)

    await patchColaborador(ADMIN_SESSION(), PATRIMONIO_ID, { permissao: 'colaborador' })

    const resDepois = await getSolicitacoes(sessaoPatrimonio, '?escopo=todas') // MESMA sessão antiga
    assert(
      resDepois.status === 401,
      'W) após rebaixamento, a MESMA sessão antiga é rejeitada com 401 em escopo=todas (não vê mais solicitações de outros usuários)',
      resDepois.status
    )

    // escopo=minhas (comum) continua servido só por getSession(), SEM
    // revalidação — mesma sessão antiga ainda funciona para os PRÓPRIOS
    // dados, confirmando que a revalidação foi seletiva (só o ramo
    // privilegiado), não global.
    const resMinhas = await getSolicitacoes(sessaoPatrimonio, '?escopo=minhas')
    assert(
      resMinhas.status === 200,
      'W) escopo=minhas (comum, não privilegiado) continua sem revalidação — mesma sessão antiga ainda acessa os PRÓPRIOS dados normalmente',
      resMinhas.status
    )
  }

  // ===========================================================================
  // Parte 3 — Fim a fim: sessão revogada por gatilho (não por expiração) para
  // de conseguir mutar em QUALQUER rota protegida (T-U)
  // ===========================================================================

  // --- T) sessão válida consegue mutar ANTES do gatilho disparar --------------
  await resetMocks()
  {
    const sessaoAlvo = sessaoDe(alvoFake) // versaoSessao=0, igual ao banco
    const res = await patchNotificacaoLida(sessaoAlvo)
    assert(res.status === 200, 'T) sessão ainda válida (nenhum gatilho disparou): PATCH notificação retorna 200', res.status)
  }

  // --- U) MESMA sessão (mesmo JWT, ainda dentro das 24h) deixa de mutar depois
  //        que um gatilho incrementa a versaoSessao do usuário no meio do
  //        caminho — prova que a revogação é imediata, não depende de esperar
  //        o token expirar. ---------------------------------------------------
  await resetMocks()
  {
    const sessaoAlvo = sessaoDe(alvoFake) // capturada ANTES do gatilho: versaoSessao=0

    // Admin desativa o alvo achando errado — dispara o gatilho (ativo muda) e
    // incrementa a versaoSessao do ALVO no banco.
    await patchColaborador(ADMIN_SESSION(), ALVO_ID, { ativo: false })
    assert(alvoFake.versaoSessao === 1, 'U) setup: gatilho disparou (versaoSessao do alvo foi para 1)', alvoFake.versaoSessao)
    alvoFake.ativo = true // reativa para isolar o efeito do incremento de versão (não do ativo=false) neste teste

    const res = await patchNotificacaoLida(sessaoAlvo) // mesma sessão de T), agora desatualizada
    assert(res.status === 401, 'U) MESMA sessão (token ainda "vivo", 24h não passaram): agora rejeitada com 401 por causa do gatilho', res.status)
    const body = await res.clone().json()
    assert(body.message === MENSAGEM_SESSAO_INVALIDA, 'U) mensagem genérica, mesma de qualquer outra rejeição de sessão', body)
  }

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) de revalidação/gatilhos de sessão (security/session-revocation) falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes de revalidação e gatilhos de versaoSessao passaram. Nenhum banco real foi acessado.')
}

main().catch((err) => {
  console.error('Falha inesperada ao executar os testes de revalidação de sessão:', err instanceof Error ? err.message : err)
  process.exit(1)
})
