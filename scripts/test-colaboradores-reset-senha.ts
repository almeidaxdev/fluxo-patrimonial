// scripts/test-colaboradores-reset-senha.ts
//
// Teste manual (mesmo padrão de scripts/test-solicitacoes-rejeicoes.ts) da
// Etapa fix/secure-password-reset: PATCH /api/colaboradores/[id] com
// { resetSenha: true } deixou de gravar a senha fixa "SenhaAntiga123@" e passou a
// gerar uma senha temporária por chamada — prefixo fixo "Flx@9" + 8
// caracteres aleatórios via crypto.randomInt() (alfabeto sem ambíguos, sem
// hífen/espaço — ex.: Flx@9K7M4Q2RX) — nunca persistida em texto puro, nunca
// logada.
//
// Importa e chama o handler PATCH REAL da rota (não uma reimplementação) —
// prisma e getSession/setSession são mocks em memória; bcryptjs roda DE
// VERDADE (mesma lib usada em produção) para validar o hash de ponta a
// ponta. Também chama o handler POST REAL de /api/auth/login para provar
// que a senha temporária autentica e que a antiga deixa de autenticar após
// o reset. Não abre conexão real com o banco nem envia e-mail.
//
// Cobre os itens A-K da Etapa 11 do plano de correção. O item L (duplo
// clique/loading não dispara duas requisições simultâneas) é uma guarda de
// UI (ref síncrona + botão disabled em
// src/app/(dashboard)/colaboradores/page.tsx) e não é testável por este
// script, que só chama o handler de rota diretamente — foi verificado por
// leitura de código e depende de homologação manual no navegador (ver
// roteiro entregue junto com esta mudança). O teste de "sanidade" no final
// cobre o que É testável neste nível: duas chamadas concorrentes ao handler
// de rota não corrompem o estado nem colidem em senha.
//
// Executar com: npm run test:colaboradores-reset-senha

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

const SENHA_ANTIGA = 'SenhaAntiga@123'
const USER_ID = 'user-colaborador-1'

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
  versaoSessao: number
}

const ADMIN_ID = 'user-admin-1'
const COLEGA_ID = 'user-colega-1'

let userFake: UserFake
let adminFake: UserFake
let colegaFake: UserFake
let updateCalls: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>

async function resetMocks() {
  userFake = {
    id: USER_ID,
    nome: 'Fulano Colaborador',
    email: 'fulano.colaborador@example.com',
    senha: await bcrypt.hash(SENHA_ANTIGA, 12),
    permissao: 'colaborador',
    ativo: true,
    podeSerGestor: false,
    podeSolicitarParaOutro: false,
    gestorPadraoId: null,
    versaoSessao: 0,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  }
  // Etapa security/session-revocation: getValidatedMutationSession()
  // reconsulta o usuário AUTENTICADO (não só o alvo) — o mock precisa de um
  // registro para o admin e para o colega usados nas sessões de teste,
  // senão a revalidação falharia com 401 antes mesmo de chegar na checagem
  // de permissão (403) que os testes J) esperam.
  adminFake = {
    id: ADMIN_ID,
    nome: 'Admin',
    email: 'admin@example.com',
    senha: await bcrypt.hash('qualquer', 12),
    permissao: 'administrador',
    ativo: true,
    podeSerGestor: false,
    podeSolicitarParaOutro: false,
    gestorPadraoId: null,
    versaoSessao: 0,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  }
  colegaFake = {
    id: COLEGA_ID,
    nome: 'Colega',
    email: 'colega@example.com',
    senha: await bcrypt.hash('qualquer', 12),
    permissao: 'colaborador',
    ativo: true,
    podeSerGestor: false,
    podeSolicitarParaOutro: false,
    gestorPadraoId: null,
    versaoSessao: 0,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  }
  updateCalls = []
}

function usuarioPorId(id: string): UserFake | null {
  if (id === userFake.id) return userFake
  if (id === adminFake.id) return adminFake
  if (id === colegaFake.id) return colegaFake
  return null
}

function instalarMockPrisma() {
  prisma.user = {
    findUnique: async ({ where }: { where: { id?: string; email?: string } }) => {
      if (where.id) {
        const u = usuarioPorId(where.id)
        return u ? { ...u } : null
      }
      if (where.email) {
        const todos = [userFake, adminFake, colegaFake]
        const u = todos.find((x) => x.email === where.email)
        return u ? { ...u } : null
      }
      return null
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      updateCalls.push({ where, data })
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
}

function instalarMockAuth(sessao: SessaoFake | null) {
  authModule.getSession = async () => (sessao ? { ...sessao } : null)
  // login chama setSession(), que usa cookies() do next/headers — fora de um
  // request real isso lançaria; noop é suficiente para este teste (só
  // validamos autenticação bem-sucedida via status/body, não o cookie).
  authModule.setSession = async () => {}
}

async function capturarConsole<T>(fn: () => Promise<T>): Promise<{ resultado: T; saida: string[] }> {
  const saida: string[] = []
  const logOriginal = console.log
  const errorOriginal = console.error
  console.log = (...args: unknown[]) => { saida.push(args.map(String).join(' ')) }
  console.error = (...args: unknown[]) => { saida.push(args.map(String).join(' ')) }
  try {
    const resultado = await fn()
    return { resultado, saida }
  } finally {
    console.log = logOriginal
    console.error = errorOriginal
  }
}

async function patchReset(sessao: SessaoFake | null) {
  instalarMockAuth(sessao)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rota = require('../src/app/api/colaboradores/[id]/route')
  const req = { json: async () => ({ resetSenha: true }) } as unknown as Parameters<typeof rota.PATCH>[0]
  return rota.PATCH(req, { params: Promise.resolve({ id: USER_ID }) })
}

async function login(senha: string) {
  instalarMockAuth(null) // login não depende de sessão prévia
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rota = require('../src/app/api/auth/login/route')
  const req = { json: async () => ({ email: userFake.email, senha }) } as unknown as Parameters<typeof rota.POST>[0]
  return rota.POST(req)
}

// Mesmo padrão gerado por gerarSenhaTemporaria() em
// src/app/api/colaboradores/[id]/route.ts: prefixo fixo "Flx@9" + 8
// caracteres do alfabeto sem ambíguos (sem I/O/0/1), sem hífen, sem espaço.
const PREFIXO_SENHA_TEMPORARIA = 'Flx@9'
const ALFABETO_SUFIXO_SENHA_TEMPORARIA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const REGEX_SENHA_TEMPORARIA = new RegExp(`^Flx@9[${ALFABETO_SUFIXO_SENHA_TEMPORARIA}]{8}$`)

const ADMIN_SESSION: SessaoFake = { id: ADMIN_ID, nome: 'Admin', email: 'admin@example.com', permissao: 'administrador', versaoSessao: 0 }
const COLABORADOR_SESSION: SessaoFake = { id: COLEGA_ID, nome: 'Colega', email: 'colega@example.com', permissao: 'colaborador', versaoSessao: 0 }

async function main() {
  instalarMockPrisma()

  // --- A) reset gera senha temporária / D) atende à política atual (>= 8) ---
  await resetMocks()
  {
    const res = await patchReset(ADMIN_SESSION)
    const body = await res.json()
    assert(res.status === 200, 'A) reset bem-sucedido retorna 200', res.status)
    assert(typeof body.senhaTemporaria === 'string' && body.senhaTemporaria.length > 0, 'A) resposta traz senhaTemporaria não vazia', body.senhaTemporaria)
    assert(
      body.senhaTemporaria.length >= 8,
      'D) senha temporária atende à política mínima atual (>= 8 caracteres, mesma regra de /api/auth/senha)',
      body.senhaTemporaria.length
    )
    assert(
      REGEX_SENHA_TEMPORARIA.test(body.senhaTemporaria),
      'D) formato exato: prefixo "Flx@9" + 8 caracteres do alfabeto sem ambíguos, sem hífen/espaço (ex.: Flx@9K7M4Q2RX)',
      body.senhaTemporaria
    )
    assert(body.senhaTemporaria.startsWith(PREFIXO_SENHA_TEMPORARIA), 'D) senha começa com o prefixo fixo "Flx@9"', body.senhaTemporaria)
    assert(!body.senhaTemporaria.includes('-'), 'D) senha não contém hífen', body.senhaTemporaria)
    assert(!/\s/.test(body.senhaTemporaria), 'D) senha não contém espaço', body.senhaTemporaria)
    assert(body.senhaTemporaria.length === PREFIXO_SENHA_TEMPORARIA.length + 8, 'D) comprimento total é prefixo + 8 caracteres', body.senhaTemporaria.length)

    // --- B) senha não é SenhaAntiga123@ ---
    assert(body.senhaTemporaria !== 'SenhaAntiga123@', 'B) senha temporária NÃO é a senha fixa antiga (SenhaAntiga123@)', body.senhaTemporaria)

    // --- E) persistida hasheada / F) hash válido contra a senha retornada ---
    assert(userFake.senha !== body.senhaTemporaria, 'E) valor persistido no "banco" não é o texto puro da senha temporária', userFake.senha)
    assert(/^\$2[aby]\$/.test(userFake.senha), 'E) valor persistido tem formato de hash bcrypt', userFake.senha)
    const hashValido = await bcrypt.compare(body.senhaTemporaria, userFake.senha)
    assert(hashValido === true, 'F) bcrypt.compare(senhaTemporaria, hashPersistido) é true', hashValido)

    // --- K) resposta nunca retorna hash/dados internos ---
    const bodyStr = JSON.stringify(body)
    assert(!bodyStr.includes(userFake.senha), 'K) resposta da API não contém o hash bcrypt', bodyStr)
    assert(!('senha' in body.user), 'K) objeto "user" da resposta não tem campo senha', body.user)
  }

  // --- C) dois resets consecutivos geram senhas diferentes ---
  await resetMocks()
  {
    const res1 = await patchReset(ADMIN_SESSION)
    const body1 = await res1.json()
    const res2 = await patchReset(ADMIN_SESSION)
    const body2 = await res2.json()
    assert(
      body1.senhaTemporaria !== body2.senhaTemporaria,
      'C) dois resets consecutivos geram senhas temporárias diferentes',
      [body1.senhaTemporaria, body2.senhaTemporaria]
    )
  }

  // --- G) senha temporária não aparece em logs (console.log/error) nem no payload gravado além do hash ---
  await resetMocks()
  {
    const { resultado: res, saida } = await capturarConsole(() => patchReset(ADMIN_SESSION))
    const body = await res.json()
    const logsConcatenados = saida.join('\n')
    assert(!logsConcatenados.includes(body.senhaTemporaria), 'G) senha temporária não aparece em nenhuma linha logada durante o reset', saida)
    const ultimoUpdate = updateCalls[updateCalls.length - 1]
    assert(
      Object.keys(ultimoUpdate.data).every((k) => k !== 'senhaTemporaria'),
      'G) payload gravado no banco (data do update) não tem campo de senha em texto puro, só "senha" (hash)',
      ultimoUpdate.data
    )
  }

  // --- H) autentica com a nova senha temporária / I) senha antiga para de funcionar ---
  await resetMocks()
  {
    const resReset = await patchReset(ADMIN_SESSION)
    const bodyReset = await resReset.json()

    const resLoginNova = await login(bodyReset.senhaTemporaria)
    assert(resLoginNova.status === 200, 'H) login com a senha temporária nova retorna 200', resLoginNova.status)
    const bodyLoginNova = await resLoginNova.json()
    assert(bodyLoginNova.user?.id === USER_ID, 'H) login autentica o usuário correto', bodyLoginNova.user)

    const resLoginAntiga = await login(SENHA_ANTIGA)
    assert(resLoginAntiga.status === 401, 'I) login com a senha antiga (pré-reset) retorna 401', resLoginAntiga.status)
  }

  // --- J) usuário não autorizado recebe erro ---
  await resetMocks()
  {
    const resSemSessao = await patchReset(null)
    assert(resSemSessao.status === 401, 'J) sem sessão: reset retorna 401', resSemSessao.status)

    const resSemPermissao = await patchReset(COLABORADOR_SESSION)
    assert(resSemPermissao.status === 403, 'J) sessão sem permissão de administrador: reset retorna 403', resSemPermissao.status)
    assert(updateCalls.length === 0, 'J) nenhum update ao banco ocorre quando o reset é negado', updateCalls.length)
  }

  // --- Sanidade extra (não é o item L — ver cabeçalho): duas chamadas
  //     concorrentes ao handler de rota não corrompem o estado nem colidem
  //     em senha. A proteção real contra duplo clique é a guarda de UI. ---
  await resetMocks()
  {
    const [res1, res2] = await Promise.all([patchReset(ADMIN_SESSION), patchReset(ADMIN_SESSION)])
    assert(res1.status === 200 && res2.status === 200, 'Sanidade) duas chamadas concorrentes de reset não quebram a rota', [res1.status, res2.status])
    const body1 = await res1.json()
    const body2 = await res2.json()
    assert(
      body1.senhaTemporaria !== body2.senhaTemporaria,
      'Sanidade) mesmo concorrentes, cada chamada gera uma senha própria',
      [body1.senhaTemporaria, body2.senhaTemporaria]
    )
  }

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) de reset seguro de senha falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes de reset seguro de senha passaram. Nenhum banco real foi acessado, nenhuma senha real foi exposta.')
}

main().catch((err) => {
  console.error('Falha inesperada ao executar os testes de reset seguro de senha:', err instanceof Error ? err.message : err)
  process.exit(1)
})
