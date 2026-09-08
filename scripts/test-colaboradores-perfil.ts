// scripts/test-colaboradores-perfil.ts
//
// Teste manual (mesmo padrão de scripts/test-colaboradores-reset-senha.ts e
// scripts/test-session-revalidation.ts) da Etapa fix/collaborator-session-sync:
//
//   Parte 1 (A-K): edição de nome/e-mail via PATCH /api/colaboradores/[id] —
//     validação de domínio permitido (@example.com), normalização
//     (trim + lowercase), unicidade, e a regra de UM ÚNICO incremento de
//     versaoSessao por chamada mesmo quando vários campos sensíveis mudam
//     juntos.
//   Parte 2 (L-P): status da conta (ativo) — gatilhos de versaoSessao,
//     comparação por VALOR (não reincrementa reenviando o mesmo valor),
//     proteção contra auto-desativação, e login bloqueado para inativo.
//   Parte 3 (Q-R): caminhos de CRIAÇÃO de User (POST /api/colaboradores,
//     POST /api/auth/cadastro) rejeitando e-mail fora do domínio.
//   Parte 4 (S): normalização de e-mail no LOGIN (maiúsculas/espaços).
//   Parte 5 (T): cenário de regressão fim-a-fim — capacidade removida em
//     sessão já aberta é detectada e força novo login com os dados corretos.
//
// Importa e chama os handlers REAIS das rotas — só prisma e
// getSession/setSession são mocks em memória (mesma técnica de
// scripts/test-colaboradores-reset-senha.ts). Não abre conexão real com o
// banco, não roda nenhum SQL/migração.
//
// Executar com: npm run test:colaboradores-perfil

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

// --- Fixtures ----------------------------------------------------------

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

const ADMIN_ID = 'user-admin-1'
const ALVO_ID = 'user-alvo-1'
const OUTRO_ID = 'user-outro-1'
const LEGADO_ID = 'user-legado-1'
const SENHA_ALVO = 'SenhaAlvo@123'

let adminFake: UserFake
let alvoFake: UserFake
let outroFake: UserFake
let legadoFake: UserFake
let usuariosCriados: UserFake[]
let updateCalls: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>

function usuarioBase(overrides: Partial<UserFake> & { id: string; email: string }): UserFake {
  return {
    nome: 'Fulano',
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
  adminFake = usuarioBase({ id: ADMIN_ID, nome: 'Admin', email: 'admin@example.com', permissao: 'administrador', senha: await bcrypt.hash('senhaAdmin@123', 12) })
  alvoFake = usuarioBase({ id: ALVO_ID, nome: 'Everton Apoio', email: 'everton@example.com', senha: await bcrypt.hash(SENHA_ALVO, 12), podeSolicitarParaOutro: true, versaoSessao: 5 })
  outroFake = usuarioBase({ id: OUTRO_ID, nome: 'Outro Colega', email: 'outro@example.com' })
  // Conta LEGADA — e-mail pré-existente a esta etapa, fora do domínio
  // configurado em ALLOWED_EMAIL_DOMAINS (@example.com). Representa um
  // usuário já cadastrado antes da regra existir (ou antes da configuração
  // atual do domínio).
  legadoFake = usuarioBase({ id: LEGADO_ID, nome: 'Apoio Legado', email: 'apoio@dominio-antigo.com' })
  usuariosCriados = []
  updateCalls = []
}

function todosOsUsuarios(): UserFake[] {
  return [adminFake, alvoFake, outroFake, legadoFake, ...usuariosCriados]
}

function usuarioPorId(id: string): UserFake | null {
  return todosOsUsuarios().find((u) => u.id === id) ?? null
}

function usuarioPorEmail(email: string): UserFake | null {
  return todosOsUsuarios().find((u) => u.email === email) ?? null
}

function instalarMockPrisma() {
  prisma.user = {
    findUnique: async ({ where }: { where: { id?: string; email?: string }; select?: Record<string, boolean> }) => {
      const u = where.id ? usuarioPorId(where.id) : where.email ? usuarioPorEmail(where.email) : null
      return u ? { ...u } : null
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      updateCalls.push({ where, data })
      const u = usuarioPorId(where.id)
      if (!u) throw new Error('Usuário não encontrado (mock).')
      // Simula a unique constraint do banco em "email" — mesma autoridade
      // final que o P2002 real captura na rota.
      if (typeof data.email === 'string') {
        const conflito = todosOsUsuarios().find((x) => x.email === data.email && x.id !== u.id)
        if (conflito) {
          const erro = new Error('Unique constraint failed on the fields: (`email`)') as Error & { code?: string }
          erro.code = 'P2002'
          throw erro
        }
      }
      const { versaoSessao, ...resto } = data
      Object.assign(u, resto)
      if (versaoSessao && typeof versaoSessao === 'object' && 'increment' in (versaoSessao as Record<string, unknown>)) {
        u.versaoSessao += (versaoSessao as { increment: number }).increment
      }
      return { ...u }
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const email = data.email as string
      if (usuarioPorEmail(email)) {
        const erro = new Error('Unique constraint failed on the fields: (`email`)') as Error & { code?: string }
        erro.code = 'P2002'
        throw erro
      }
      const novo = usuarioBase({
        id: `user-novo-${usuariosCriados.length + 1}`,
        nome: data.nome as string,
        email,
        senha: data.senha as string,
        permissao: (data.permissao as UserFake['permissao']) ?? 'colaborador',
        podeSerGestor: !!data.podeSerGestor,
        podeSolicitarParaOutro: !!data.podeSolicitarParaOutro,
      })
      usuariosCriados.push(novo)
      return { ...novo }
    },
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

const ADMIN_SESSION = () => sessaoDe(adminFake)

async function patchColaborador(sessao: SessaoFake | null, alvoId: string, body: Record<string, unknown>) {
  instalarMockAuth(sessao)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rota = require('../src/app/api/colaboradores/[id]/route')
  const req = { json: async () => body } as unknown as Parameters<typeof rota.PATCH>[0]
  return rota.PATCH(req, { params: Promise.resolve({ id: alvoId }) })
}

async function postColaborador(sessao: SessaoFake | null, body: Record<string, unknown>) {
  instalarMockAuth(sessao)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rota = require('../src/app/api/colaboradores/route')
  const req = { json: async () => body } as unknown as Parameters<typeof rota.POST>[0]
  return rota.POST(req)
}

async function postCadastro(body: Record<string, unknown>) {
  instalarMockAuth(null) // cadastro público não depende de sessão
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rota = require('../src/app/api/auth/cadastro/route')
  // `headers` real (Headers vazio) — a rota chama extrairIpCliente(req) (ver
  // src/lib/rate-limit.ts) ANTES de qualquer validação, que precisa de
  // `req.headers.get(...)`; sem isso o mock quebraria com TypeError antes
  // de sequer chegar na validação de domínio que este teste está exercendo.
  const req = { json: async () => body, headers: new Headers() } as unknown as Parameters<typeof rota.POST>[0]
  return rota.POST(req)
}

async function postLogin(email: string, senha: string) {
  instalarMockAuth(null)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rota = require('../src/app/api/auth/login/route')
  const req = { json: async () => ({ email, senha }) } as unknown as Parameters<typeof rota.POST>[0]
  return rota.POST(req)
}

async function getAuthMe(sessao: SessaoFake | null) {
  instalarMockAuth(sessao)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rota = require('../src/app/api/auth/me/route')
  return rota.GET()
}

async function main() {
  // emailPermitidoSchema (chamado pelas rotas reais abaixo) é fail-closed
  // sem isto — só "example.com" é aceito nos testes deste arquivo.
  process.env.ALLOWED_EMAIL_DOMAINS = 'example.com'

  instalarMockPrisma()

  // ===========================================================================
  // Parte 1 — Edição de nome/e-mail via PATCH /api/colaboradores/[id] (A-K)
  // ===========================================================================

  // --- A) editar SÓ o nome: sucesso, versaoSessao NÃO muda --------------------
  await resetMocks()
  {
    const versaoAntes = alvoFake.versaoSessao
    const res = await patchColaborador(ADMIN_SESSION(), ALVO_ID, { nome: 'Everton Silva' })
    const body = await res.json()
    assert(res.status === 200, 'A) editar só o nome retorna 200', res.status)
    assert(alvoFake.nome === 'Everton Silva', 'A) nome foi atualizado', alvoFake.nome)
    assert(alvoFake.versaoSessao === versaoAntes, 'A) versaoSessao NÃO muda ao editar só o nome', alvoFake.versaoSessao)
    assert(body.revogouSessao === false, 'A) resposta sinaliza revogouSessao=false', body.revogouSessao)
  }

  // --- B) editar e-mail válido (com espaços/maiúsculas): normaliza, +1 --------
  await resetMocks()
  {
    const versaoAntes = alvoFake.versaoSessao
    const res = await patchColaborador(ADMIN_SESSION(), ALVO_ID, { email: '  Everton.Novo@EXAMPLE.COM  ' })
    const body = await res.json()
    assert(res.status === 200, 'B) editar e-mail válido retorna 200', res.status)
    assert(alvoFake.email === 'everton.novo@example.com', 'B) e-mail persistido já normalizado (trim + lowercase)', alvoFake.email)
    assert(alvoFake.versaoSessao === versaoAntes + 1, 'B) versaoSessao incrementa em +1 ao mudar e-mail', alvoFake.versaoSessao)
    assert(body.revogouSessao === true, 'B) resposta sinaliza revogouSessao=true', body.revogouSessao)
  }

  // --- C) e-mail de outro domínio (@gmail.com) → rejeitado --------------------
  await resetMocks()
  {
    const res = await patchColaborador(ADMIN_SESSION(), ALVO_ID, { email: 'everton@gmail.com' })
    assert(res.status === 400, 'C) e-mail fora do domínio permitido (@gmail.com) é rejeitado com 400', res.status)
    assert(alvoFake.email === 'everton@example.com', 'C) e-mail NÃO foi alterado', alvoFake.email)
  }

  // --- D) domínio plausível mas fora da lista configurada → rejeitado ---------
  await resetMocks()
  {
    const res = await patchColaborador(ADMIN_SESSION(), ALVO_ID, { email: 'everton@example.org' })
    assert(res.status === 400, 'D) e-mail de domínio não incluído em ALLOWED_EMAIL_DOMAINS é rejeitado com 400', res.status)
  }

  // --- E) domínio "parecido" mas não igual → rejeitado -------------------------
  await resetMocks()
  {
    const casosInvalidos = ['everton@edu.example.com', 'everton@example.com.br', 'everton@example.com.evil.com']
    for (const email of casosInvalidos) {
      const res = await patchColaborador(ADMIN_SESSION(), ALVO_ID, { email })
      assert(res.status === 400, `E) domínio "parecido" mas não EXATO é rejeitado: ${email}`, res.status)
    }
  }

  // --- F) e-mail duplicado (já usado por outro colaborador) → rejeitado -------
  await resetMocks()
  {
    const res = await patchColaborador(ADMIN_SESSION(), ALVO_ID, { email: outroFake.email })
    const body = await res.json()
    assert(res.status === 409, 'F) e-mail já usado por outro colaborador é rejeitado com 409', res.status)
    assert(body.message === 'Já existe um colaborador cadastrado com este e-mail.', 'F) mensagem amigável, sem stack/Prisma exposto', body.message)
    assert(alvoFake.email !== outroFake.email, 'F) e-mail do alvo NÃO foi alterado', alvoFake.email)
  }

  // --- G) manter o próprio e-mail atual (mesmo valor, variando caixa) --------
  await resetMocks()
  {
    const versaoAntes = alvoFake.versaoSessao
    const res = await patchColaborador(ADMIN_SESSION(), ALVO_ID, { email: alvoFake.email.toUpperCase() })
    assert(res.status === 200, 'G) reenviar o próprio e-mail (variando caixa) é permitido', res.status)
    assert(alvoFake.versaoSessao === versaoAntes, 'G) sem incremento — representação normalizada já é a mesma persistida', alvoFake.versaoSessao)
  }

  // --- H) nome + e-mail na MESMA chamada → só +1 -------------------------------
  await resetMocks()
  {
    const versaoAntes = alvoFake.versaoSessao
    await patchColaborador(ADMIN_SESSION(), ALVO_ID, { nome: 'Novo Nome', email: 'novo.email@example.com' })
    assert(alvoFake.versaoSessao === versaoAntes + 1, 'H) nome + e-mail juntos: incrementa +1 (não +2)', alvoFake.versaoSessao)
  }

  // --- I) e-mail + permissao + podeSolicitarParaOutro juntos → só +1 ----------
  await resetMocks()
  {
    const versaoAntes = alvoFake.versaoSessao
    await patchColaborador(ADMIN_SESSION(), ALVO_ID, {
      email: 'novo2@example.com',
      permissao: 'patrimonio',
      podeSolicitarParaOutro: false,
    })
    assert(alvoFake.versaoSessao === versaoAntes + 1, 'I) e-mail + permissao + capacidade juntos: incrementa +1 (não +3)', alvoFake.versaoSessao)
  }

  // --- J) Admin altera o PRÓPRIO e-mail → sucesso + revogouSessao=true --------
  await resetMocks()
  {
    const versaoAntes = adminFake.versaoSessao
    const res = await patchColaborador(ADMIN_SESSION(), ADMIN_ID, { email: 'admin.novo@example.com' })
    const body = await res.json()
    assert(res.status === 200, 'J) Admin altera o próprio e-mail: sucesso', res.status)
    assert(adminFake.versaoSessao === versaoAntes + 1, 'J) própria versaoSessao incrementa', adminFake.versaoSessao)
    assert(body.revogouSessao === true, 'J) resposta sinaliza revogouSessao=true (frontend força revalidação/logout)', body.revogouSessao)
  }

  // --- K) editar nome/e-mail de usuário INATIVO não reativa --------------------
  await resetMocks()
  {
    alvoFake.ativo = false
    await patchColaborador(ADMIN_SESSION(), ALVO_ID, { email: 'novo3@example.com' })
    assert(alvoFake.ativo === false, 'K) editar e-mail de usuário inativo NÃO reativa a conta (ativo continua false)', alvoFake.ativo)
  }

  // ===========================================================================
  // Parte 1.1 — Migração gradual de e-mail LEGADO (auditoria S5.1: conta
  // pré-existente com e-mail fora de @example.com, ex.: "apoio@dominio-antigo.com")
  // (U-W). O frontend SEMPRE envia `email` no body do PATCH, mesmo quando o
  // Admin só mexeu em ativo/permissão/capacidade — a rota só exige o
  // domínio permitido quando o valor normalizado REALMENTE muda em
  // relação ao já persistido; mantendo o valor legado como está, passa.
  // ===========================================================================

  // --- U) reenviar o e-mail legado JÁ persistido, mudando só `ativo` ----------
  await resetMocks()
  {
    assert(legadoFake.email === 'apoio@dominio-antigo.com', 'U) fixture: conta legada começa com e-mail fora do domínio novo', legadoFake.email)
    const versaoAntes = legadoFake.versaoSessao
    const res = await patchColaborador(ADMIN_SESSION(), LEGADO_ID, { email: legadoFake.email, ativo: false })
    const body = await res.json()
    assert(res.status === 200, 'U) desativar a conta legada reenviando o MESMO e-mail (como o frontend sempre faz) não é bloqueado pela regra de domínio', res.status)
    assert(legadoFake.email === 'apoio@dominio-antigo.com', 'U) e-mail legado permanece EXATAMENTE igual (nenhuma tentativa de "corrigir" silenciosamente)', legadoFake.email)
    assert(legadoFake.ativo === false, 'U) ativo foi de fato alterado', legadoFake.ativo)
    assert(legadoFake.versaoSessao === versaoAntes + 1, 'U) versaoSessao incrementa por causa do ativo (não do e-mail, que não mudou)', legadoFake.versaoSessao)
    assert(body.revogouSessao === true, 'U) revogouSessao=true (causado por ativo, não por e-mail)', body.revogouSessao)
  }

  // --- V) mudar SÓ permissao numa conta legada, reenviando o e-mail antigo ----
  await resetMocks()
  {
    const versaoAntes = legadoFake.versaoSessao
    const res = await patchColaborador(ADMIN_SESSION(), LEGADO_ID, { email: legadoFake.email, permissao: 'patrimonio' })
    assert(res.status === 200, 'V) mudar permissao de conta legada (reenviando e-mail antigo) é permitido', res.status)
    assert(legadoFake.permissao === 'patrimonio', 'V) permissao foi alterada', legadoFake.permissao)
    assert(legadoFake.email === 'apoio@dominio-antigo.com', 'V) e-mail legado continua intocado', legadoFake.email)
    assert(legadoFake.versaoSessao === versaoAntes + 1, 'V) versaoSessao incrementa por causa da permissao', legadoFake.versaoSessao)
  }

  // --- W) mudar SÓ podeSolicitarParaOutro numa conta legada --------------------
  await resetMocks()
  {
    const res = await patchColaborador(ADMIN_SESSION(), LEGADO_ID, { email: legadoFake.email, podeSolicitarParaOutro: true })
    assert(res.status === 200, 'W) ligar capacidade de conta legada (reenviando e-mail antigo) é permitido', res.status)
    assert(legadoFake.podeSolicitarParaOutro === true, 'W) capacidade foi alterada', legadoFake.podeSolicitarParaOutro)
    assert(legadoFake.email === 'apoio@dominio-antigo.com', 'W) e-mail legado continua intocado', legadoFake.email)
  }

  // --- X) conta legada tenta migrar para OUTRO e-mail fora do domínio → rejeitado
  await resetMocks()
  {
    const versaoAntes = legadoFake.versaoSessao
    const res = await patchColaborador(ADMIN_SESSION(), LEGADO_ID, { email: 'apoio.novo@outrodominio.com' })
    assert(res.status === 400, 'X) mudar o e-mail legado para OUTRO endereço fora de @example.com é rejeitado (é uma mudança REAL, domínio obrigatório)', res.status)
    assert(legadoFake.email === 'apoio@dominio-antigo.com', 'X) e-mail NÃO foi alterado', legadoFake.email)
    assert(legadoFake.versaoSessao === versaoAntes, 'X) versaoSessao não muda numa tentativa rejeitada', legadoFake.versaoSessao)
  }

  // --- Y) conta legada MIGRA de verdade para @example.com → aceito, incrementa -
  await resetMocks()
  {
    const versaoAntes = legadoFake.versaoSessao
    const res = await patchColaborador(ADMIN_SESSION(), LEGADO_ID, { email: 'apoio@example.com' })
    assert(res.status === 200, 'Y) migrar o e-mail legado para um endereço @example.com de verdade é aceito', res.status)
    assert(legadoFake.email === 'apoio@example.com', 'Y) e-mail migrado com sucesso', legadoFake.email)
    assert(legadoFake.versaoSessao === versaoAntes + 1, 'Y) versaoSessao incrementa (mudança real de e-mail)', legadoFake.versaoSessao)
  }

  // ===========================================================================
  // Parte 2 — Status da conta (ativo) (L-P)
  // ===========================================================================

  // --- L) Admin desativa colaborador → ativo=false, versaoSessao +1 -----------
  await resetMocks()
  {
    const versaoAntes = alvoFake.versaoSessao
    const res = await patchColaborador(ADMIN_SESSION(), ALVO_ID, { ativo: false })
    assert(res.status === 200, 'L) desativar colaborador retorna 200', res.status)
    assert(alvoFake.ativo === false, 'L) ativo passou para false', alvoFake.ativo)
    assert(alvoFake.versaoSessao === versaoAntes + 1, 'L) versaoSessao incrementa ao desativar', alvoFake.versaoSessao)
  }

  // --- M) Admin reativa colaborador → ativo=true, versaoSessao +1 -------------
  await resetMocks()
  {
    alvoFake.ativo = false
    const versaoAntes = alvoFake.versaoSessao
    const res = await patchColaborador(ADMIN_SESSION(), ALVO_ID, { ativo: true })
    assert(res.status === 200, 'M) reativar colaborador retorna 200', res.status)
    // Boolean(...) força um tipo `boolean` fresco — sem isso, o TS mantém
    // `alvoFake.ativo` "congelado" como literal `false` na análise de fluxo
    // (herdado da atribuição síncrona `alvoFake.ativo = false` logo acima),
    // mesmo depois do PATCH real (via await) já ter mudado o objeto em
    // runtime, e reclama de comparar contra `true` como se fosse impossível.
    assert(Boolean(alvoFake.ativo) === true, 'M) ativo voltou para true', alvoFake.ativo)
    assert(alvoFake.versaoSessao === versaoAntes + 1, 'M) versaoSessao incrementa ao reativar', alvoFake.versaoSessao)
  }

  // --- N) salvar "ativo" com o MESMO valor → NÃO incrementa --------------------
  await resetMocks()
  {
    const versaoAntes = alvoFake.versaoSessao
    await patchColaborador(ADMIN_SESSION(), ALVO_ID, { ativo: true }) // já era true
    assert(alvoFake.versaoSessao === versaoAntes, 'N) reenviar ativo=true (já era true) NÃO incrementa', alvoFake.versaoSessao)
  }

  // --- O) Admin tenta desativar A SI MESMO → rejeitado -------------------------
  await resetMocks()
  {
    const versaoAntes = adminFake.versaoSessao
    const res = await patchColaborador(ADMIN_SESSION(), ADMIN_ID, { ativo: false })
    const body = await res.json()
    assert(res.status === 400, 'O) Admin tentando se auto-desativar recebe 400', res.status)
    assert(body.message === 'Você não pode desativar sua própria conta.', 'O) mensagem correta', body.message)
    assert(adminFake.ativo === true, 'O) admin continua ativo (nenhuma escrita ocorreu)', adminFake.ativo)
    assert(adminFake.versaoSessao === versaoAntes, 'O) versaoSessao do admin NÃO muda (rejeitado antes de qualquer update)', adminFake.versaoSessao)
    assert(updateCalls.length === 0, 'O) nenhum update ao banco ocorre quando a auto-desativação é bloqueada', updateCalls.length)
  }

  // --- P) usuário INATIVO não consegue autenticar ------------------------------
  await resetMocks()
  {
    alvoFake.ativo = false
    const res = await postLogin(alvoFake.email, SENHA_ALVO)
    assert(res.status === 401, 'P) login de usuário desativado retorna 401 (mesmo com senha correta)', res.status)
    const body = await res.json()
    assert(body.message === 'E-mail ou senha inválidos.', 'P) mensagem genérica — não revela "conta desativada" (evita enumeração)', body.message)
  }

  // ===========================================================================
  // Parte 3 — Caminhos de CRIAÇÃO de User rejeitam domínio fora de @example.com
  // (Q-R)
  // ===========================================================================

  // --- Q) POST /api/colaboradores (Admin cria colaborador) --------------------
  await resetMocks()
  {
    const res = await postColaborador(ADMIN_SESSION(), {
      nome: 'Novo Colaborador',
      email: 'novo@gmail.com',
      senha: 'SenhaForte@123',
      permissao: 'colaborador',
    })
    assert(res.status === 400, 'Q) criação de colaborador com e-mail fora do domínio permitido é rejeitada', res.status)
    assert(usuariosCriados.length === 0, 'Q) nenhum usuário foi criado', usuariosCriados.length)
  }

  // --- R) POST /api/auth/cadastro (cadastro público) ---------------------------
  await resetMocks()
  {
    const res = await postCadastro({ nome: 'Auto Cadastro', email: 'pessoal@hotmail.com', senha: 'SenhaForte@123' })
    assert(res.status === 400, 'R) cadastro público com e-mail fora do domínio permitido é rejeitado', res.status)
    assert(usuariosCriados.length === 0, 'R) nenhum usuário foi criado', usuariosCriados.length)
  }

  // ===========================================================================
  // Parte 4 — Normalização de e-mail no LOGIN (S)
  // ===========================================================================

  // --- S) login com e-mail em maiúsculas/com espaços continua funcionando -----
  await resetMocks()
  {
    const res = await postLogin(`  ${alvoFake.email.toUpperCase()}  `, SENHA_ALVO)
    assert(res.status === 200, 'S) login com e-mail em maiúsculas/espaços funciona após normalização (trim+lowercase)', res.status)
    const body = await res.json()
    assert(body.user?.id === ALVO_ID, 'S) autentica o usuário correto', body.user)
  }

  // ===========================================================================
  // Parte 5 — Regressão fim-a-fim: capacidade removida em sessão já aberta (T)
  // ===========================================================================

  // --- T) Cenário completo do item 8 do pedido original -----------------------
  await resetMocks()
  {
    // 1) Everton "loga" com podeSolicitarParaOutro=true, versão N.
    const versaoNoLogin = alvoFake.versaoSessao
    const sessaoEverton = sessaoDe(alvoFake) // versaoSessao=N, podeSolicitarParaOutro=true

    // 2) A tela mostraria a opção — confirmado indiretamente por
    //    podeSolicitarParaOutro=true na claim capturada acima.
    assert(sessaoEverton.podeSolicitarParaOutro === true, 'T.1) sessão original tem podeSolicitarParaOutro=true', sessaoEverton)

    // 3) Admin remove a capacidade.
    await patchColaborador(ADMIN_SESSION(), ALVO_ID, { podeSolicitarParaOutro: false })

    // 4) Banco passa para N+1.
    assert(alvoFake.versaoSessao === versaoNoLogin + 1, 'T.2) versaoSessao do banco foi para N+1', alvoFake.versaoSessao)

    // 5-6-7-8) Everton "volta para a aba" — frontend chama /api/auth/me com a
    // sessão antiga (versão N, capacidade ainda true na claim).
    const resMe = await getAuthMe(sessaoEverton)
    assert(resMe.status === 401, 'T.3) GET /api/auth/me com a sessão antiga (versão N) retorna 401', resMe.status)

    // 9) (Everton seria redirecionado para login pelo AuthProvider — coberto
    //    pela implementação do componente, não testável neste nível de
    //    handler de rota.)

    // 10-11) Após novo login, o JWT contém N+1 e a capacidade atualizada.
    const resLogin = await postLogin(alvoFake.email, SENHA_ALVO)
    assert(resLogin.status === 200, 'T.4) novo login funciona normalmente', resLogin.status)
    const bodyLogin = await resLogin.json()
    assert(bodyLogin.user?.versaoSessao === versaoNoLogin + 1, 'T.5) novo JWT contém a versão ATUALIZADA (N+1)', bodyLogin.user)
    assert(bodyLogin.user?.podeSolicitarParaOutro === false, 'T.6) novo JWT reflete a capacidade JÁ REMOVIDA (false)', bodyLogin.user)

    // Sessão NOVA (pós-login) volta a funcionar normalmente em /auth/me.
    const sessaoNova = sessaoDe(alvoFake)
    const resMeNova = await getAuthMe(sessaoNova)
    assert(resMeNova.status === 200, 'T.7) sessão NOVA (pós-login) é aceita normalmente por /api/auth/me', resMeNova.status)
  }

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) de perfil/status de colaborador (fix/collaborator-session-sync) falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes de edição de perfil, status de conta e domínio permitido passaram. Nenhum banco real foi acessado.')
}

main().catch((err) => {
  console.error('Falha inesperada ao executar os testes de perfil de colaborador:', err instanceof Error ? err.message : err)
  process.exit(1)
})
