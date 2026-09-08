// scripts/test-solicitacoes-para-outro.ts
//
// Etapa security/request-for-another (+ ajuste "capacidade") — valida o
// gate de autorização de "solicitar para outro colaborador" em
// POST /api/solicitacoes, incluindo a CAPACIDADE individual
// `User.podeSolicitarParaOutro` (não é um perfil/role novo — nunca
// reaproveita podeSerGestor, nunca amplia isPatrimonioOuAdmin). Regra final:
//
//   - Patrimônio/Administrador: sempre podem solicitar para outro.
//   - Gestor (podeSerGestor): sempre pode solicitar para outro.
//   - Colaborador comum: só pode solicitar para si.
//   - Colaborador com podeSolicitarParaOutro=true: pode solicitar para
//     outro, sem ganhar NENHUMA outra permissão (aprovação de gestor,
//     Patrimônio, Administração, Atendimento Imediato continuam bloqueados).
//
// Chama os handlers REAIS de POST /api/solicitacoes,
// POST /api/solicitacoes/[id]/aprovar-gestor, POST /api/categorias e
// PATCH /api/colaboradores/[id] (prisma e getSession mockados em memória,
// mesmo padrão de scripts/test-solicitacoes-ambiente-interno.ts) — nunca
// reimplementa a regra separadamente.
//
// Executar com: npm run test:solicitacoes-para-outro

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
  // emailPermitidoSchema (usado por POST /api/colaboradores, testado abaixo)
  // é fail-closed sem isto.
  process.env.ALLOWED_EMAIL_DOMAINS = 'example.com'
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { prisma } = require('../src/lib/prisma')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const authModule = require('../src/lib/auth')

  // --- Usuários fixture -------------------------------------------------
  // Etapa security/session-revocation: `versaoSessao` abaixo é usado tanto
  // pela sessão mockada (sessionDe(), logo adiante) quanto pelo registro
  // "de banco" devolvido por prisma.user.findUnique() nos mocks desta
  // rota — getValidatedMutationSession() exige que os dois batam.
  const COLABORADOR = { id: 'user-colab', nome: 'Colaborador', email: 'colab@example.com', ativo: true, permissao: 'colaborador', podeSerGestor: false, podeSolicitarParaOutro: false, versaoSessao: 0 }
  // Capacidade concedida individualmente (ex.: apoio técnico) — NUNCA
  // chamada de "role" no código: é só um colaborador comum com o campo
  // ligado.
  const COLABORADOR_AUTORIZADO = { id: 'user-colab-autorizado', nome: 'Colaborador Autorizado', email: 'colab-aut@example.com', ativo: true, permissao: 'colaborador', podeSerGestor: false, podeSolicitarParaOutro: true, versaoSessao: 0 }
  const OUTRO = { id: 'user-outro', nome: 'Outro Colaborador', email: 'outro@example.com', ativo: true, permissao: 'colaborador', podeSerGestor: false, podeSolicitarParaOutro: false, versaoSessao: 0 }
  const OUTRO_INATIVO = { id: 'user-outro-inativo', nome: 'Inativo', email: 'inativo@example.com', ativo: false, permissao: 'colaborador', podeSerGestor: false, podeSolicitarParaOutro: false, versaoSessao: 0 }
  const GESTOR = { id: 'user-gestor', nome: 'Gestor', email: 'gestor@example.com', ativo: true, permissao: 'colaborador', podeSerGestor: true, podeSolicitarParaOutro: false, versaoSessao: 0 }
  const PATRIMONIO = { id: 'user-patrimonio', nome: 'Patrimônio', email: 'patrimonio@example.com', ativo: true, permissao: 'patrimonio', podeSerGestor: false, podeSolicitarParaOutro: false, versaoSessao: 0 }
  const ADMIN = { id: 'user-admin', nome: 'Admin', email: 'admin@example.com', ativo: true, permissao: 'administrador', podeSerGestor: false, podeSolicitarParaOutro: false, versaoSessao: 0 }

  type Usuario = typeof COLABORADOR

  const USUARIOS: Record<string, Usuario> = {
    [COLABORADOR.id]: COLABORADOR,
    [COLABORADOR_AUTORIZADO.id]: COLABORADOR_AUTORIZADO,
    [OUTRO.id]: OUTRO,
    [OUTRO_INATIVO.id]: OUTRO_INATIVO,
    [GESTOR.id]: GESTOR,
    [PATRIMONIO.id]: PATRIMONIO,
    [ADMIN.id]: ADMIN,
  }

  function sessionDe(u: Usuario) {
    return {
      id: u.id,
      nome: u.nome,
      email: u.email,
      permissao: u.permissao as 'colaborador' | 'patrimonio' | 'administrador',
      podeSerGestor: u.podeSerGestor,
      podeSolicitarParaOutro: u.podeSolicitarParaOutro,
      versaoSessao: u.versaoSessao,
    }
  }

  function logarComo(u: Usuario) {
    // Ponto e vírgula obrigatório (mesma ambiguidade de ASI documentada em
    // scripts/test-solicitacoes-ambiente-interno.ts).
    authModule.getSession = async () => (sessionDe(u));
  }

  // =====================================================================
  // Bloco 1 — POST /api/solicitacoes (criação em nome de outro)
  // =====================================================================

  const chamadas = { transaction: 0, solicitacaoCreate: 0, historicoCreate: 0, notificacaoCreate: 0, emailEventoCreate: 0 }
  function resetarContadores() {
    chamadas.transaction = 0
    chamadas.solicitacaoCreate = 0
    chamadas.historicoCreate = 0
    chamadas.notificacaoCreate = 0
    chamadas.emailEventoCreate = 0
  }

  function instalarMockSolicitacoes() {
    prisma.user = {
      findUnique: async ({ where }: { where: { id: string } }) => (USUARIOS[where.id] ? { ...USUARIOS[where.id] } : null),
    }
    prisma.patrimonio = { findMany: async () => [] }
    const tx = {
      patrimonio: { findMany: async () => [] },
      solicitacao: {
        create: async ({ data }: { data: Record<string, any> }) => {
          chamadas.solicitacaoCreate++
          return {
            id: 'sol-h1',
            numero: 701,
            tipoEmprestimo: data.tipoEmprestimo,
            ambiente: data.ambiente,
            data: data.data,
            periodos: data.periodos,
            finalidade: data.finalidade,
            observacoes: data.observacoes,
            notebooksComDominio: data.notebooksComDominio,
            tipoDominio: data.tipoDominio,
            gestorId: data.gestorId,
            solicitanteId: data.solicitanteId,
            solicitante: USUARIOS[data.solicitanteId] ? { id: data.solicitanteId, nome: USUARIOS[data.solicitanteId].nome, email: USUARIOS[data.solicitanteId].email } : null,
            criadoPor: { id: data.criadoPorId, nome: 'x', email: 'x@example.com' },
            gestor: null,
            itensPatrimonio: [],
            itensPapelaria: data.itensPapelaria?.create ?? [],
            itensServico: [],
          }
        },
      },
      historicoSolicitacao: { create: async () => { chamadas.historicoCreate++; return {} } },
      notificacao: { create: async () => { chamadas.notificacaoCreate++; return {} } },
      user: { findMany: async () => [] },
      emailEvento: { create: async ({ data }: { data: Record<string, unknown> }) => { chamadas.emailEventoCreate++; return { id: 'evt-1', ...data } } },
    }
    prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
      chamadas.transaction++
      return fn(tx)
    }
    prisma.solicitacao = { findUnique: async () => ({ status: 'AGUARDANDO_PATRIMONIO' }) }
    prisma.emailEvento = {
      updateMany: async () => ({ count: 0 }),
      findUniqueOrThrow: async () => ({ destinatario: 'x@example.com' }),
      update: async () => ({}),
    }
  }

  function corpoInterno(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      tipoEmprestimo: 'interno',
      origem: 'RESERVA',
      ambiente: 'Laboratório 3',
      data: '2026-09-01',
      periodos: ['MANHA'],
      patrimonioIds: [],
      itensPapelaria: [{ descricao: 'Caneta', quantidade: 5 }],
      servicos: [],
      ...overrides,
    }
  }

  async function postarSolicitacao(body: Record<string, unknown>) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rota = require('../src/app/api/solicitacoes/route')
    const req = { json: async () => body } as unknown as Parameters<typeof rota.POST>[0]
    return rota.POST(req)
  }

  instalarMockSolicitacoes()

  // --- A) colaborador comum, sem solicitanteId → cria para si ------------
  {
    logarComo(COLABORADOR)
    resetarContadores()
    const corpo = corpoInterno()
    delete corpo.solicitanteId
    const res = await postarSolicitacao(corpo)
    const body = await res.json()
    assert(res.status === 201, 'A) colaborador comum sem solicitanteId → 201 (cria para si)', res.status)
    assert(body.solicitacao?.solicitanteId === COLABORADOR.id, 'A) solicitanteId persistido é o próprio usuário autenticado', body.solicitacao?.solicitanteId)
  }

  // --- B) colaborador comum → para outro → 403 ----------------------------
  {
    logarComo(COLABORADOR)
    resetarContadores()
    const res = await postarSolicitacao(corpoInterno({ solicitanteId: OUTRO.id }))
    const body = await res.json()
    assert(res.status === 403, 'B) colaborador comum com solicitanteId de outro → 403', res.status)
    assert(
      typeof body.message === 'string' && !body.message.toLowerCase().includes('prisma') && !body.message.toLowerCase().includes('stack'),
      'B) mensagem de erro não revela detalhe interno',
      body.message
    )
    assert(chamadas.transaction === 0 && chamadas.solicitacaoCreate === 0, 'B) nenhum efeito colateral (sem $transaction, sem Solicitacao)', chamadas)
  }

  // --- C) colaborador com podeSolicitarParaOutro=true → para outro → 201 --
  {
    logarComo(COLABORADOR_AUTORIZADO)
    resetarContadores()
    const res = await postarSolicitacao(corpoInterno({ solicitanteId: OUTRO.id }))
    const body = await res.json()
    assert(res.status === 201, 'C) colaborador com a CAPACIDADE podeSolicitarParaOutro=true → 201', res.status)
    assert(body.solicitacao?.solicitanteId === OUTRO.id, 'C) solicitanteId persistido é o colaborador alvo', body.solicitacao?.solicitanteId)
  }

  // --- D) gestor → para outro → permitido ----------------------------------
  {
    logarComo(GESTOR)
    resetarContadores()
    const res = await postarSolicitacao(corpoInterno({ solicitanteId: OUTRO.id }))
    assert(res.status === 201, 'D) gestor solicitando para outro colaborador → 201', res.status)
  }

  // --- E) patrimônio → para outro → permitido ------------------------------
  {
    logarComo(PATRIMONIO)
    resetarContadores()
    const res = await postarSolicitacao(corpoInterno({ solicitanteId: OUTRO.id }))
    assert(res.status === 201, 'E) Patrimônio solicitando para outro colaborador → 201', res.status)
  }

  // --- F) administrador → para outro → permitido ---------------------------
  {
    logarComo(ADMIN)
    resetarContadores()
    const res = await postarSolicitacao(corpoInterno({ solicitanteId: OUTRO.id }))
    assert(res.status === 201, 'F) Administrador solicitando para outro colaborador → 201', res.status)
  }

  // --- G) colaborador comum tenta mandar podeSolicitarParaOutro=true no ---
  // BODY da criação de solicitação — nunca ganha permissão, porque a
  // decisão usa exclusivamente session.podeSolicitarParaOutro (claim do JWT
  // já emitido no login), nunca um campo do corpo desta requisição
  // (criarSolicitacaoSchema nem define esse campo — é descartado pelo Zod).
  {
    logarComo(COLABORADOR)
    resetarContadores()
    const res = await postarSolicitacao(corpoInterno({ solicitanteId: OUTRO.id, podeSolicitarParaOutro: true }))
    assert(res.status === 403, 'G) colaborador comum enviando podeSolicitarParaOutro=true no body → ainda 403', res.status)
    assert(chamadas.solicitacaoCreate === 0, 'G) nenhuma Solicitacao foi criada (payload manipulado não eleva permissão)', chamadas)
  }

  // --- alvo inexistente / inativo (ator autorizado) — contrato preservado -
  {
    logarComo(GESTOR)
    resetarContadores()
    const res = await postarSolicitacao(corpoInterno({ solicitanteId: 'user-nao-existe' }))
    const body = await res.json()
    assert(res.status === 400 && body.message === 'Solicitante inválido.', 'alvo inexistente (ator autorizado) → 400 "Solicitante inválido." (contrato preservado)', { status: res.status, message: body.message })
  }
  {
    logarComo(GESTOR)
    resetarContadores()
    const res = await postarSolicitacao(corpoInterno({ solicitanteId: OUTRO_INATIVO.id }))
    const body = await res.json()
    assert(res.status === 400 && body.message === 'Solicitante inválido.', 'alvo inativo (ator autorizado) → 400 "Solicitante inválido." (contrato preservado)', { status: res.status, message: body.message })
  }

  // --- J) tentativa 403 → ZERO efeitos colaterais (reforço com colaborador
  // autorizado tentando usar o ID de alguém e outro colaborador SEM a
  // capacidade tentando o mesmo — só o segundo caso deve falhar) ----------
  {
    logarComo(COLABORADOR)
    resetarContadores()
    const res = await postarSolicitacao(corpoInterno({ solicitanteId: OUTRO_INATIVO.id }))
    assert(res.status === 403, 'J) colaborador comum tentando usar ID de terceiro (mesmo inativo) → 403, não 400 (gate roda antes da checagem de existência)', res.status)
    assert(chamadas.solicitacaoCreate === 0 && chamadas.transaction === 0, 'J) nenhuma Solicitacao/`$transaction` para a tentativa negada', chamadas)
  }

  // =====================================================================
  // Bloco 2 — capacidade NÃO vaza para outras permissões (K, L)
  // =====================================================================

  // --- K) colaborador com podeSolicitarParaOutro=true continua NÃO --------
  // podendo aprovar como gestor (POST /aprovar-gestor exige
  // solicitacao.gestorId === session.id — nunca reaproveita
  // podeSolicitarParaOutro).
  {
    logarComo(COLABORADOR_AUTORIZADO)
    const txAprovar = {
      solicitacao: {
        findUnique: async () => ({ id: 'sol-x', status: 'AGUARDANDO_GESTOR', gestorId: GESTOR.id, numero: 900, solicitanteId: OUTRO.id }),
      },
    }
    prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(txAprovar)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rotaAprovar = require('../src/app/api/solicitacoes/[id]/aprovar-gestor/route')
    const req = {} as Parameters<typeof rotaAprovar.POST>[0]
    const res = await rotaAprovar.POST(req, { params: Promise.resolve({ id: 'sol-x' }) })
    const body = await res.json()
    assert(res.status === 403, 'K) colaborador com podeSolicitarParaOutro=true NÃO pode aprovar como gestor de outrem → 403', res.status)
    assert(body.message === 'Você não possui permissão para aprovar esta solicitação.', 'K) mensagem de negação de aprovação preservada', body.message)
  }

  // --- L) colaborador com podeSolicitarParaOutro=true continua NÃO --------
  // podendo acessar funcionalidades de Patrimônio/Admin (POST /api/categorias
  // exige isAdmin — nunca reaproveita podeSolicitarParaOutro).
  {
    logarComo(COLABORADOR_AUTORIZADO)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rotaCategorias = require('../src/app/api/categorias/route')
    const req = { json: async () => ({ nome: 'Categoria Teste' }) } as unknown as Parameters<typeof rotaCategorias.POST>[0]
    const res = await rotaCategorias.POST(req)
    assert(res.status === 403, 'L) colaborador com podeSolicitarParaOutro=true NÃO pode criar categoria (rota exige Administrador) → 403', res.status)
  }

  // Restaura o mock de /api/solicitacoes para o bloco 3.
  instalarMockSolicitacoes()

  // =====================================================================
  // Bloco 3 — administração da capacidade (H, I) — PATCH/POST /api/colaboradores
  // =====================================================================

  function instalarMockColaboradores() {
    prisma.user = {
      findUnique: async ({ where }: { where: { id?: string; email?: string } }) => {
        if (where.id) return USUARIOS[where.id] ? { ...USUARIOS[where.id] } : null
        return null // e-mail nunca colide nestes testes
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
        id: where.id,
        nome: 'x',
        email: 'x@example.com',
        permissao: (data.permissao as string) ?? 'colaborador',
        ativo: data.ativo ?? true,
        podeSerGestor: !!data.podeSerGestor,
        podeSolicitarParaOutro: !!data.podeSolicitarParaOutro,
        gestorPadraoId: null,
        createdAt: new Date().toISOString(),
      }),
      create: async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'user-novo',
        nome: data.nome,
        email: data.email,
        permissao: data.permissao,
        ativo: true,
        podeSerGestor: !!data.podeSerGestor,
        podeSolicitarParaOutro: !!data.podeSolicitarParaOutro,
        gestorPadraoId: data.gestorPadraoId ?? null,
        createdAt: new Date().toISOString(),
      }),
    }
  }

  async function patchColaborador(id: string, body: Record<string, unknown>) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rota = require('../src/app/api/colaboradores/[id]/route')
    const req = { json: async () => body } as unknown as Parameters<typeof rota.PATCH>[0]
    return rota.PATCH(req, { params: Promise.resolve({ id }) })
  }

  async function postColaborador(body: Record<string, unknown>) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rota = require('../src/app/api/colaboradores/route')
    const req = { json: async () => body } as unknown as Parameters<typeof rota.POST>[0]
    return rota.POST(req)
  }

  instalarMockColaboradores()

  // --- H) alteração da capacidade pela API administrativa: somente Admin --
  {
    logarComo(COLABORADOR)
    const res = await patchColaborador(OUTRO.id, { podeSolicitarParaOutro: true })
    assert(res.status === 403, 'H) colaborador comum tentando alterar podeSolicitarParaOutro de outro usuário → 403 (rota admin-only)', res.status)
  }
  {
    // Reforço: nem mesmo tentando alterar a PRÓPRIA capacidade um
    // colaborador comum consegue — a rota é 403 para qualquer `id` quando
    // session.permissao !== 'administrador', antes mesmo de olhar o alvo.
    logarComo(COLABORADOR)
    const res = await patchColaborador(COLABORADOR.id, { podeSolicitarParaOutro: true })
    assert(res.status === 403, 'H) colaborador comum tentando ligar a PRÓPRIA capacidade → 403 (autoedição bloqueada)', res.status)
  }
  {
    logarComo(ADMIN)
    const res = await patchColaborador(OUTRO.id, { podeSolicitarParaOutro: true })
    const body = await res.json()
    assert(res.status === 200, 'H) Administrador altera podeSolicitarParaOutro de outro usuário → 200', res.status)
    assert(body.user?.podeSolicitarParaOutro === true, 'H) capacidade refletida na resposta', body.user?.podeSolicitarParaOutro)
  }

  // --- I) capacidade FALSE por padrão (criação sem informar o campo) ------
  {
    logarComo(ADMIN)
    // E-mail precisa estar num domínio permitido (ALLOWED_EMAIL_DOMAINS) —
    // POST /api/colaboradores valida o domínio.
    const res = await postColaborador({ nome: 'Novo Colaborador', email: 'novo@example.com', senha: 'SenhaForte123', permissao: 'colaborador' })
    const body = await res.json()
    assert(res.status === 201, 'I) criação de colaborador sem informar podeSolicitarParaOutro → 201', res.status)
    assert(body.user?.podeSolicitarParaOutro === false, 'I) podeSolicitarParaOutro é false por padrão quando omitido', body.user?.podeSolicitarParaOutro)
  }

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) de autorização de "solicitar para outro colaborador" falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes de autorização de "solicitar para outro colaborador" (perfil + capacidade) passaram. Nenhum e-mail real foi enviado, nenhum banco real foi acessado.')
}

main().catch((err) => {
  console.error('Falha inesperada ao executar os testes de autorização de "solicitar para outro colaborador":', err instanceof Error ? err.message : err)
  process.exit(1)
})
