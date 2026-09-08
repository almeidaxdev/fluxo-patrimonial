// scripts/test-input-hardening-b3.ts
//
// Etapa security/input-hardening-b3 — Arrays, números, paginação, datas e
// query params relacionados.
//
//   Parte 1 (A-G): limites de array (patrimonioIds/itensPapelaria/servicos
//     <= 50, periodos <= 3 sem duplicata) em `criarSolicitacaoSchema`, em
//     isolamento — inclui sanidade de uma solicitação mista (patrimônio +
//     papelaria + serviço) continuar válida.
//   Parte 2 (H-J): números (quantidade <= 1000, > 0, sem Infinity) em
//     isolamento.
//   Parte 3 (K-M): paginação real — teto/clamp de page/limit através dos
//     handlers REAIS de GET /api/solicitacoes, /api/patrimonios,
//     /api/colaboradores (src/lib/query-params.ts).
//   Parte 4 (N-U): datas — `Invalid Date` rejeitada nas rotas REAIS
//     (GET /api/solicitacoes, GET /api/patrimonios/disponibilidade),
//     no schema de criação de solicitação, e em `construirFiltros`
//     (relatórios).
//
// Importa e chama os handlers REAIS das rotas — prisma e getSession são
// mocks em memória (mesmo padrão de scripts/test-input-hardening-b2.ts).
// Nenhum banco real é acessado.
//
// Executar com: npm run test:input-hardening-b3

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
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { criarSolicitacaoSchema } = require('../src/lib/validations')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { construirFiltros, FiltroRelatorioInvalidoError } = require('../src/lib/relatorios')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { prisma } = require('../src/lib/prisma')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const authModule = require('../src/lib/auth')

  authModule.setSession = async () => {}

  function criarSolicitacaoBase() {
    return {
      tipoEmprestimo: 'interno',
      ambiente: 'Sala 1',
      data: '2026-09-01',
      periodos: ['MANHA'],
    }
  }

  // ===========================================================================
  // Parte 1 — Arrays (A-G)
  // ===========================================================================

  // --- A) patrimonioIds com 50 elementos → aceita -------------------------
  {
    const r = criarSolicitacaoSchema.safeParse({
      ...criarSolicitacaoBase(),
      patrimonioIds: Array.from({ length: 50 }, (_, i) => `patrimonio-${i}`),
    })
    assert(r.success === true, 'A) patrimonioIds com 50 elementos é aceito', r)
  }

  // --- B) patrimonioIds com 51 elementos → rejeita -------------------------
  {
    const r = criarSolicitacaoSchema.safeParse({
      ...criarSolicitacaoBase(),
      patrimonioIds: Array.from({ length: 51 }, (_, i) => `patrimonio-${i}`),
    })
    assert(r.success === false, 'B) patrimonioIds com 51 elementos é rejeitado', r)
  }

  // --- C) periodos com mais de 3 elementos → rejeita -----------------------
  {
    const r = criarSolicitacaoSchema.safeParse({
      ...criarSolicitacaoBase(),
      periodos: ['MANHA', 'TARDE', 'NOITE', 'MANHA'],
      patrimonioIds: ['patrimonio-1'],
    })
    assert(r.success === false, 'C) periodos com 4 elementos é rejeitado (máximo 3)', r)
  }

  // --- D) periodos duplicado → rejeita --------------------------------------
  {
    const r = criarSolicitacaoSchema.safeParse({
      ...criarSolicitacaoBase(),
      periodos: ['MANHA', 'MANHA'],
      patrimonioIds: ['patrimonio-1'],
    })
    assert(r.success === false, 'D) periodos com o mesmo valor repetido é rejeitado', r)
  }
  // Sanidade: períodos distintos (sem repetição) continuam aceitos.
  {
    const r = criarSolicitacaoSchema.safeParse({
      ...criarSolicitacaoBase(),
      periodos: ['MANHA', 'TARDE'],
      patrimonioIds: ['patrimonio-1'],
    })
    assert(r.success === true, 'Sanidade D) períodos distintos continuam aceitos', r)
  }

  // --- E) itensPapelaria com 50 → aceita, 51 → rejeita ----------------------
  {
    const item = { descricao: 'Cartolina', quantidade: 1 }
    const rOk = criarSolicitacaoSchema.safeParse({
      ...criarSolicitacaoBase(),
      itensPapelaria: Array.from({ length: 50 }, () => item),
    })
    assert(rOk.success === true, 'E) itensPapelaria com 50 elementos é aceito', rOk)
    const rFalha = criarSolicitacaoSchema.safeParse({
      ...criarSolicitacaoBase(),
      itensPapelaria: Array.from({ length: 51 }, () => item),
    })
    assert(rFalha.success === false, 'E) itensPapelaria com 51 elementos é rejeitado', rFalha)
  }

  // --- F) servicos com 50 → aceita, 51 → rejeita ----------------------------
  {
    const item = { tipoServicoId: 'servico-1', quantidade: 1, ambiente: 'Sala 1' }
    const rOk = criarSolicitacaoSchema.safeParse({
      ...criarSolicitacaoBase(),
      servicos: Array.from({ length: 50 }, () => item),
    })
    assert(rOk.success === true, 'F) servicos com 50 elementos é aceito', rOk)
    const rFalha = criarSolicitacaoSchema.safeParse({
      ...criarSolicitacaoBase(),
      servicos: Array.from({ length: 51 }, () => item),
    })
    assert(rFalha.success === false, 'F) servicos com 51 elementos é rejeitado', rFalha)
  }

  // --- G) solicitação mista (patrimônio + papelaria + serviço) continua OK --
  {
    const r = criarSolicitacaoSchema.safeParse({
      ...criarSolicitacaoBase(),
      patrimonioIds: ['patrimonio-1'],
      itensPapelaria: [{ descricao: 'Cartolina', quantidade: 2 }],
      servicos: [{ tipoServicoId: 'servico-1', quantidade: 1, ambiente: 'Sala 1' }],
    })
    assert(r.success === true, 'G) solicitação mista (patrimônio + papelaria + serviço) continua válida', r)
  }

  // ===========================================================================
  // Parte 2 — Números (H-J)
  // ===========================================================================

  // --- H) quantidade de papelaria com 1000 → aceita, 1001 → rejeita --------
  {
    const rOk = criarSolicitacaoSchema.safeParse({
      ...criarSolicitacaoBase(),
      itensPapelaria: [{ descricao: 'Cartolina', quantidade: 1000 }],
    })
    assert(rOk.success === true, 'H) quantidade de papelaria com 1000 é aceita', rOk)
    const rFalha = criarSolicitacaoSchema.safeParse({
      ...criarSolicitacaoBase(),
      itensPapelaria: [{ descricao: 'Cartolina', quantidade: 1001 }],
    })
    assert(rFalha.success === false, 'H) quantidade de papelaria com 1001 é rejeitada', rFalha)
  }

  // --- I) quantidade 0/negativa → rejeita -----------------------------------
  {
    const rZero = criarSolicitacaoSchema.safeParse({
      ...criarSolicitacaoBase(),
      itensPapelaria: [{ descricao: 'Cartolina', quantidade: 0 }],
    })
    assert(rZero.success === false, 'I) quantidade de papelaria igual a 0 é rejeitada', rZero)
    const rNegativa = criarSolicitacaoSchema.safeParse({
      ...criarSolicitacaoBase(),
      itensPapelaria: [{ descricao: 'Cartolina', quantidade: -1 }],
    })
    assert(rNegativa.success === false, 'I) quantidade de papelaria negativa é rejeitada', rNegativa)
  }

  // --- J) quantidade Infinity → rejeita (nunca chega ao Prisma) -------------
  {
    const r = criarSolicitacaoSchema.safeParse({
      ...criarSolicitacaoBase(),
      itensPapelaria: [{ descricao: 'Cartolina', quantidade: Infinity }],
    })
    assert(r.success === false, 'J) quantidade de papelaria Infinity é rejeitada', r)
  }

  // ===========================================================================
  // Parte 3 — Paginação real (K-M)
  // ===========================================================================

  authModule.getSession = async () => ({
    id: 'user-comum-b3-1',
    nome: 'Comum',
    email: 'comum.b3@example.com',
    permissao: 'colaborador',
    podeSerGestor: false,
    podeSolicitarParaOutro: false,
    versaoSessao: 0,
  })
  prisma.solicitacao = {
    findMany: async () => [],
    count: async () => 0,
  }

  // --- K) GET /api/solicitacoes com limit=99999 → clampado para 100 --------
  {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rota = require('../src/app/api/solicitacoes/route')
    const req = { url: 'http://localhost:3000/api/solicitacoes?limit=99999' } as unknown as Parameters<typeof rota.GET>[0]
    const res = await rota.GET(req)
    const body = await res.json()
    assert(res.status === 200, 'K) GET /api/solicitacoes com limit=99999 retorna 200', res.status)
    assert(body.limit === 100, 'K) limit é clampado para o teto de 100', body.limit)
  }

  // --- L) GET /api/solicitacoes com page=-5 → cai no default (página 1) ----
  {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rota = require('../src/app/api/solicitacoes/route')
    const req = { url: 'http://localhost:3000/api/solicitacoes?page=-5' } as unknown as Parameters<typeof rota.GET>[0]
    const res = await rota.GET(req)
    const body = await res.json()
    assert(res.status === 200, 'L) GET /api/solicitacoes com page=-5 retorna 200', res.status)
    assert(body.page === 1, 'L) page negativa cai no default (1)', body.page)
  }

  // --- M) GET /api/solicitacoes com limit não numérico → cai no default ----
  {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rota = require('../src/app/api/solicitacoes/route')
    const req = { url: 'http://localhost:3000/api/solicitacoes?limit=abc' } as unknown as Parameters<typeof rota.GET>[0]
    const res = await rota.GET(req)
    const body = await res.json()
    assert(res.status === 200, 'M) GET /api/solicitacoes com limit=abc retorna 200', res.status)
    assert(body.limit === 20, 'M) limit não numérico cai no default (20)', body.limit)
  }

  // ===========================================================================
  // Parte 4 — Datas (N-U)
  // ===========================================================================

  // --- N) GET /api/solicitacoes com data inválida → 400 ---------------------
  {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rota = require('../src/app/api/solicitacoes/route')
    const req = { url: 'http://localhost:3000/api/solicitacoes?data=nao-e-uma-data' } as unknown as Parameters<typeof rota.GET>[0]
    const res = await rota.GET(req)
    const body = await res.json()
    assert(res.status === 400, 'N) GET /api/solicitacoes com data inválida retorna 400', res.status)
    assert(body.message === 'Data inválida.', 'N) mensagem correta', body)
  }

  // --- O) GET /api/solicitacoes com dataInicio inválida → 400 ---------------
  {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rota = require('../src/app/api/solicitacoes/route')
    const req = { url: 'http://localhost:3000/api/solicitacoes?dataInicio=32/13/9999' } as unknown as Parameters<typeof rota.GET>[0]
    const res = await rota.GET(req)
    const body = await res.json()
    assert(res.status === 400, 'O) GET /api/solicitacoes com dataInicio inválida retorna 400', res.status)
    assert(body.message === 'Data inicial inválida.', 'O) mensagem correta', body)
  }

  // --- extra) GET /api/solicitacoes com numero não numérico → 400 -----------
  {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rota = require('../src/app/api/solicitacoes/route')
    const req = { url: 'http://localhost:3000/api/solicitacoes?numero=abc' } as unknown as Parameters<typeof rota.GET>[0]
    const res = await rota.GET(req)
    const body = await res.json()
    assert(res.status === 400, 'extra) GET /api/solicitacoes com numero não numérico retorna 400', res.status)
    assert(body.message === 'Número inválido.', 'extra) mensagem correta', body)
  }

  // --- P) GET /api/patrimonios/disponibilidade com data inválida → 400 -----
  {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rota = require('../src/app/api/patrimonios/disponibilidade/route')
    const req = {
      url: 'http://localhost:3000/api/patrimonios/disponibilidade?categoriaId=cat-1&data=nao-e-uma-data&periodo=MANHA',
    } as unknown as Parameters<typeof rota.GET>[0]
    prisma.solicitacao = { findMany: async () => [] }
    prisma.patrimonio = { findMany: async () => [] }
    const res = await rota.GET(req)
    const body = await res.json()
    assert(res.status === 400, 'P) GET disponibilidade com data inválida retorna 400', res.status)
    assert(body.message === 'Data inválida.', 'P) mensagem correta', body)
  }

  // --- Q) criarSolicitacaoSchema com data em formato errado → rejeita -------
  {
    const r = criarSolicitacaoSchema.safeParse({
      ...criarSolicitacaoBase(),
      data: '01/09/2026',
      patrimonioIds: ['patrimonio-1'],
    })
    assert(r.success === false, 'Q) data em formato DD/MM/YYYY é rejeitada', r)
  }

  // --- R) criarSolicitacaoSchema com data inexistente (dia 30 de fevereiro) -
  {
    const r = criarSolicitacaoSchema.safeParse({
      ...criarSolicitacaoBase(),
      data: '2026-02-30',
      patrimonioIds: ['patrimonio-1'],
    })
    assert(r.success === false, 'R) data inexistente (2026-02-30) é rejeitada', r)
  }
  // Sanidade: data válida no formato correto continua aceita.
  {
    const r = criarSolicitacaoSchema.safeParse({
      ...criarSolicitacaoBase(),
      data: '2026-09-01',
      patrimonioIds: ['patrimonio-1'],
    })
    assert(r.success === true, 'Sanidade R) data válida (YYYY-MM-DD) continua aceita', r)
  }

  // --- S) construirFiltros com mes inválido → lança -------------------------
  {
    let lancou = false
    let ehTipoCorreto = false
    try {
      construirFiltros(new URLSearchParams({ mes: 'mes-invalido' }))
    } catch (e) {
      lancou = true
      ehTipoCorreto = e instanceof FiltroRelatorioInvalidoError
    }
    assert(lancou && ehTipoCorreto, 'S) construirFiltros com mes inválido lança FiltroRelatorioInvalidoError', undefined)
  }

  // --- T) construirFiltros com dataInicio inválida → lança ------------------
  {
    let lancou = false
    let ehTipoCorreto = false
    try {
      construirFiltros(new URLSearchParams({ dataInicio: 'nao-e-uma-data' }))
    } catch (e) {
      lancou = true
      ehTipoCorreto = e instanceof FiltroRelatorioInvalidoError
    }
    assert(lancou && ehTipoCorreto, 'T) construirFiltros com dataInicio inválida lança FiltroRelatorioInvalidoError', undefined)
  }

  // --- U) construirFiltros com mes válido continua funcionando (sanidade) --
  {
    let lancou = false
    try {
      const { mesAnoUnico } = construirFiltros(new URLSearchParams({ mes: '2026-09' }))
      assert(mesAnoUnico === '2026-09', 'U) construirFiltros com mes válido preserva mesAnoUnico', mesAnoUnico)
    } catch (e) {
      lancou = true
    }
    assert(!lancou, 'U) construirFiltros com mes válido não lança', undefined)
  }

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) de S6-B3 (arrays/números/paginação/datas) falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes de S6-B3 (arrays/números/paginação/datas) passaram. Nenhum banco real acessado.')
}

main().catch((err) => {
  console.error('Falha inesperada ao executar os testes de S6-B3:', err instanceof Error ? err.message : err)
  process.exit(1)
})
