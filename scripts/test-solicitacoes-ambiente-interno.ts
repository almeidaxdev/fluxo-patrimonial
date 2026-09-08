// scripts/test-solicitacoes-ambiente-interno.ts
//
// Teste manual da Etapa fix/internal-environment-validation: "Ambiente ou
// sala" já era obrigatório na UI de Nova Solicitação (validarEtapa() em
// nova-solicitacao/page.tsx), mas o schema Zod (criarSolicitacaoSchema, em
// src/lib/validations.ts) deixava passar vazio/só-espaço/ausente — nada
// impedia um payload manipulado direto contra a API. Cobre a regra
// condicional adicionada: ambiente obrigatório SOMENTE quando
// tipoEmprestimo='interno' E origem !== 'ATENDIMENTO_IMEDIATO' (aquele
// formulário nunca teve — e continua sem ter — um campo de ambiente da
// solicitação como um todo).
//
// Parte 1 — testa criarSolicitacaoSchema.safeParse() diretamente: função
// pura (sem Prisma, sem I/O, sem rede) — mesmo padrão dos demais testes de
// payload/schema deste projeto.
//
// Parte 2 — chama o handler POST REAL de /api/solicitacoes (prisma e
// getSession mockados em memória, mesmo padrão de
// scripts/test-solicitacoes-post-aguardando-gestor.ts) para confirmar que
// a rota realmente usa esse schema e devolve 400 para um payload
// manipulado, e que a criação interna normal (com ambiente) continua
// funcionando de ponta a ponta.
//
// Executar com: npm run test:solicitacoes-ambiente-interno

import { criarSolicitacaoSchema } from '../src/lib/validations'

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

function corpoInterno(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tipoEmprestimo: 'interno',
    origem: 'RESERVA',
    solicitanteId: 'user-solicitante',
    ambiente: 'Laboratório 3',
    data: '2026-09-01',
    periodos: ['MANHA'],
    patrimonioIds: [],
    itensPapelaria: [{ descricao: 'Caneta', quantidade: 5 }],
    servicos: [],
    ...overrides,
  }
}

function corpoExterno(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tipoEmprestimo: 'externo',
    origem: 'RESERVA',
    solicitanteId: 'user-solicitante',
    gestorId: 'user-gestor',
    atividadeExterna: 'Feira de tecnologia',
    local: 'Centro de Convenções',
    cidade: 'São Paulo',
    data: '2026-09-01',
    periodos: ['MANHA'],
    patrimonioIds: [],
    itensPapelaria: [{ descricao: 'Caneta', quantidade: 5 }],
    servicos: [],
    ...overrides,
  }
}

function corpoAtendimentoImediato(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tipoEmprestimo: 'interno',
    origem: 'ATENDIMENTO_IMEDIATO',
    solicitanteId: 'user-solicitante',
    // Deliberadamente SEM `ambiente` — este formulário nunca teve esse
    // campo (só "ambiente" por item de serviço, dentro de `servicos[]`,
    // que é outro campo, já validado por itemServicoSchema).
    data: '2026-09-01',
    periodos: ['MANHA'],
    patrimonioIds: [],
    itensPapelaria: [{ descricao: 'Caneta', quantidade: 5 }],
    servicos: [],
    ...overrides,
  }
}

function mensagemAmbiente(resultado: ReturnType<typeof criarSolicitacaoSchema.safeParse>): string | undefined {
  if (resultado.success) return undefined
  return resultado.error.errors.find((e) => e.path[0] === 'ambiente')?.message
}

async function main() {
  // ============================== Parte 1 — schema puro ==============================

  // --- A) interna + ambiente válido → sucesso ---------------------------------------
  {
    const r = criarSolicitacaoSchema.safeParse(corpoInterno())
    assert(r.success, 'A) interna com ambiente válido passa na validação', r.success ? undefined : r.error.errors)
  }

  // --- B) interna + ambiente vazio → erro -------------------------------------------
  {
    const r = criarSolicitacaoSchema.safeParse(corpoInterno({ ambiente: '' }))
    assert(!r.success, 'B) interna com ambiente vazio ("") falha na validação', r)
    assert(mensagemAmbiente(r) === 'Informe o ambiente ou sala.', 'B) mensagem de erro é a mesma já usada no frontend (validarEtapa)', mensagemAmbiente(r))
  }

  // --- C) interna + ambiente só espaços → erro ---------------------------------------
  {
    const r = criarSolicitacaoSchema.safeParse(corpoInterno({ ambiente: '   ' }))
    assert(!r.success, 'C) interna com ambiente só espaços ("   ") falha na validação', r)
    assert(mensagemAmbiente(r) === 'Informe o ambiente ou sala.', 'C) mensagem de erro correta para ambiente só-espaço', mensagemAmbiente(r))
  }

  // --- D) interna + ambiente ausente → erro -------------------------------------------
  {
    const corpo = corpoInterno()
    delete corpo.ambiente
    const r = criarSolicitacaoSchema.safeParse(corpo)
    assert(!r.success, 'D) interna sem o campo ambiente (ausente, não só vazio) falha na validação', r)
    assert(mensagemAmbiente(r) === 'Informe o ambiente ou sala.', 'D) mensagem de erro correta para ambiente ausente', mensagemAmbiente(r))
  }

  // --- null explícito também é rejeitado (payload manipulado) ------------------------
  {
    const r = criarSolicitacaoSchema.safeParse(corpoInterno({ ambiente: null }))
    assert(!r.success, 'interna com ambiente=null (payload manipulado) falha na validação', r)
  }

  // --- E) externa sem ambiente → continua válida (campos externos presentes) ----------
  {
    const corpo = corpoExterno()
    delete corpo.ambiente
    const r = criarSolicitacaoSchema.safeParse(corpo)
    assert(r.success, 'E) externa sem o campo ambiente continua válida', r.success ? undefined : r.error.errors)
  }

  // --- F) externa NÃO passa a exigir ambiente (mesmo enviando vazio) -------------------
  {
    const r = criarSolicitacaoSchema.safeParse(corpoExterno({ ambiente: '' }))
    assert(r.success, 'F) externa com ambiente="" continua válida — regra é exclusiva de interna', r.success ? undefined : r.error.errors)
  }

  // --- G) ambiente válido é trimado pelo schema ----------------------------------------
  {
    const r = criarSolicitacaoSchema.safeParse(corpoInterno({ ambiente: '  Sala 7  ' }))
    assert(r.success, 'G) interna com ambiente com espaços nas bordas passa na validação', r.success ? undefined : (r as { error?: unknown }).error)
    if (r.success) {
      assert(r.data.ambiente === 'Sala 7', 'G) ambiente é trimado pelo schema (z.string().trim())', r.data.ambiente)
    }
  }

  // --- Atendimento Imediato (origem=ATENDIMENTO_IMEDIATO) é a EXCEÇÃO deliberada -------
  // Sempre tipoEmprestimo='interno' (ver POST /api/solicitacoes), mas SEM
  // campo de ambiente no formulário — a regra desta etapa não pode quebrar
  // esse fluxo (item 8 do pedido).
  {
    const r = criarSolicitacaoSchema.safeParse(corpoAtendimentoImediato())
    assert(r.success, 'Atendimento Imediato (interno, sem ambiente) continua válido — exceção deliberada da regra', r.success ? undefined : r.error.errors)
  }
  {
    // Ainda assim, se alguém enviar ambiente preenchido no Atendimento
    // Imediato (não acontece na UI atual, mas não deve quebrar), o schema
    // aceita e trima normalmente — não é um campo proibido, só não
    // obrigatório para esse `origem`.
    const r = criarSolicitacaoSchema.safeParse(corpoAtendimentoImediato({ ambiente: '  Balcão  ' }))
    assert(r.success && r.data.ambiente === 'Balcão', 'Atendimento Imediato com ambiente preenchido também é aceito e trimado', r)
  }

  // ============================== Parte 2 — rota real ==============================

  process.env.APP_URL = 'http://localhost:3000'
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { prisma } = require('../src/lib/prisma')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const authModule = require('../src/lib/auth')

  // Etapa security/session-revocation: getValidatedMutationSession() faz UMA
  // consulta a prisma.user.findUnique() para revalidar o usuário AUTENTICADO
  // — como SESSION.id === SOLICITANTE.id e SESSION_ADMIN.id === ADMIN.id
  // aqui, os MESMOS registros abaixo já atendem as duas finalidades
  // (revalidação de sessão + lookup de negócio da rota).
  const SOLICITANTE = { id: 'user-solicitante', nome: 'Fulano Solicitante', email: 'fulano@example.com', ativo: true, permissao: 'colaborador' as const, podeSerGestor: false, podeSolicitarParaOutro: false, versaoSessao: 0 }
  const GESTOR = { id: 'user-gestor', nome: 'Beltrano Gestor', email: 'beltrano.gestor@example.com', ativo: true, podeSerGestor: true, permissao: 'colaborador' as const, podeSolicitarParaOutro: false, versaoSessao: 0 }
  const ADMIN = { id: 'user-admin', nome: 'Admin', email: 'admin@example.com', ativo: true, permissao: 'administrador' as const, podeSerGestor: false, podeSolicitarParaOutro: false, versaoSessao: 0 }
  const SESSION = { id: SOLICITANTE.id, nome: SOLICITANTE.nome, email: SOLICITANTE.email, permissao: 'colaborador' as const, versaoSessao: 0 }
  // Atendimento Imediato só pode ser registrado por Patrimônio/admin (ver
  // POST /api/solicitacoes) — sessão dedicada só para esse cenário.
  const SESSION_ADMIN = { id: ADMIN.id, nome: ADMIN.nome, email: ADMIN.email, permissao: 'administrador' as const, versaoSessao: 0 }

  function instalarMockPrisma() {
    prisma.user = {
      findUnique: async ({ where }: { where: { id: string } }) => {
        if (where.id === SOLICITANTE.id) return { ...SOLICITANTE }
        if (where.id === GESTOR.id) return { ...GESTOR }
        if (where.id === ADMIN.id) return { ...ADMIN }
        return null
      },
    }
    prisma.patrimonio = {
      findMany: async () => [],
    }
    const tx = {
      patrimonio: { findMany: async () => [] },
      solicitacao: {
        create: async ({ data }: { data: Record<string, any> }) => ({
          id: 'sol-h1',
          numero: 501,
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
          solicitante: { id: SOLICITANTE.id, nome: SOLICITANTE.nome, email: SOLICITANTE.email },
          criadoPor: { id: SOLICITANTE.id, nome: SOLICITANTE.nome, email: SOLICITANTE.email },
          gestor: data.gestorId === GESTOR.id ? { id: GESTOR.id, nome: GESTOR.nome, email: GESTOR.email } : null,
          itensPatrimonio: [],
          itensPapelaria: data.itensPapelaria?.create ?? [],
          itensServico: [],
        }),
      },
      historicoSolicitacao: { create: async () => ({}) },
      notificacao: { create: async () => ({}) },
      user: { findMany: async () => [] },
      emailEvento: { create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'evt-1', ...data }) },
    }
    prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)
    prisma.solicitacao = { findUnique: async () => ({ status: 'AGUARDANDO_PATRIMONIO' }) }
    prisma.emailEvento = {
      updateMany: async () => ({ count: 0 }),
      findUniqueOrThrow: async () => ({ destinatario: 'x@example.com' }),
      update: async () => ({}),
    }
  }

  async function postar(body: Record<string, unknown>) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rota = require('../src/app/api/solicitacoes/route')
    const req = { json: async () => body } as unknown as Parameters<typeof rota.POST>[0]
    return rota.POST(req)
  }

  instalarMockPrisma()
  // Ponto e vírgula obrigatório aqui: sem ele, o parser do TS tenta juntar
  // `({ ...SESSION })` com o bloco `{` da linha seguinte como se fosse uma
  // arrow function `(params) { corpo }` sem `=>` — mesmo ambiguidade clássica
  // de ASI antes de `(`, mas com objeto parenteizado + bloco solto.
  authModule.getSession = async () => ({ ...SESSION });

  // --- H) nenhuma regressão na criação interna normal (ponta a ponta, rota real) -------
  {
    const res = await postar(corpoInterno())
    const body = await res.json()
    assert(res.status === 201, 'H) POST real /api/solicitacoes: criação interna com ambiente continua respondendo 201', res.status)
    assert(body.solicitacao?.ambiente === 'Laboratório 3', 'H) ambiente persistido corretamente na resposta', body.solicitacao?.ambiente)
  }

  // --- rota real rejeita payload manipulado com 400 (não só a UI) ----------------------
  {
    const res = await postar(corpoInterno({ ambiente: '' }))
    const body = await res.json()
    assert(res.status === 400, 'rota real: payload manipulado com ambiente="" recebe 400 (não confia só em validarEtapa do frontend)', res.status)
    assert(body.message === 'Informe o ambiente ou sala.', 'rota real: mensagem de erro correta no corpo da resposta 400', body.message)
  }

  // --- rota real: Atendimento Imediato sem ambiente continua funcionando (regressão) ----
  authModule.getSession = async () => ({ ...SESSION_ADMIN });
  {
    const res = await postar(corpoAtendimentoImediato())
    assert(res.status === 201, 'rota real: Atendimento Imediato sem ambiente continua respondendo 201 (sem regressão)', res.status)
  }
  authModule.getSession = async () => ({ ...SESSION });

  // --- rota real: externa sem ambiente continua funcionando (regressão) -----------------
  {
    const res = await postar(corpoExterno())
    assert(res.status === 201, 'rota real: solicitação externa sem ambiente continua respondendo 201 (sem regressão)', res.status)
  }

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) de ambiente obrigatório (fluxo interno) falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes de ambiente obrigatório (fluxo interno) passaram. Nenhum e-mail real foi enviado, nenhum banco real foi acessado.')
}

main().catch((err) => {
  console.error('Falha inesperada ao executar os testes de ambiente obrigatório:', err instanceof Error ? err.message : err)
  process.exit(1)
})
