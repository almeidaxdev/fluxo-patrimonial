// scripts/test-input-hardening-b2.ts
//
// Etapa security/input-hardening-b2 — Schemas, limites de strings e enums.
//
//   Parte 1 (A-J): limites máximos server-side (LIMITES_INPUT) — nome,
//     e-mail, busca, papelaria, observação/motivo, categoria/título curto —
//     em isolamento, direto nos schemas de src/lib/validations.ts.
//   Parte 2 (A-G): enums explícitos — permissaoEnum/statusSolicitacaoEnum/
//     escopoSolicitacaoEnum/tipoEmprestimoEnum/tipoDominioEnum/periodoEnum,
//     em isolamento e através dos handlers REAIS das rotas que antes
//     aceitavam o valor via cast (`as Permissao`/`as StatusSolicitacao`)
//     sem checagem nenhuma.
//
// Importa e chama os handlers REAIS das rotas — prisma e getSession/
// setSession são mocks em memória (mesmo padrão de
// scripts/test-senha-hardening.ts). Nenhum banco real é acessado.
//
// Executar com: npm run test:input-hardening-b2

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
  // emailPermitidoSchema é fail-closed sem isto — precisa de pelo menos um
  // domínio configurado para os testes de e-mail abaixo fazerem sentido.
  process.env.ALLOWED_EMAIL_DOMAINS = 'example.com'

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {
    nomeColaboradorSchema,
    emailPermitidoSchema,
    buscaSchema,
    itemPapelariaSchema,
    rejeitarSchema,
    criarSolicitacaoSchema,
    categoriaSchema,
    patrimonioSchema,
    permissaoEnum,
    statusSolicitacaoEnum,
    escopoSolicitacaoEnum,
  } = require('../src/lib/validations')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { prisma } = require('../src/lib/prisma')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const authModule = require('../src/lib/auth')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { construirFiltros, FiltroRelatorioInvalidoError } = require('../src/lib/relatorios')

  authModule.setSession = async () => {}

  // ===========================================================================
  // Parte 1 — Limites de strings (LIMITES_INPUT), em isolamento (A-J)
  // ===========================================================================

  // --- A) nome com 120 caracteres → aceita --------------------------------
  {
    const r = nomeColaboradorSchema.safeParse('a'.repeat(120))
    assert(r.success === true, 'A) nome com 120 caracteres é aceito', r)
  }

  // --- B) nome com 121 caracteres → rejeita -------------------------------
  {
    const r = nomeColaboradorSchema.safeParse('a'.repeat(121))
    assert(r.success === false, 'B) nome com 121 caracteres é rejeitado', r)
  }

  // --- C) e-mail acima de 254 caracteres → rejeita ------------------------
  // Local-part só de letras (formato válido) + domínio permitido real —
  // se o teto de 254 não existisse, passaria normalmente no `.email()` e no
  // `.refine()` de domínio; falha exclusivamente pelo `.max()`.
  {
    const emailEnorme = `${'a'.repeat(250)}@example.com` // 250 + 12 = 262 caracteres
    assert(emailEnorme.length > 254, 'C) fixture tem mais de 254 caracteres', emailEnorme.length)
    const r = emailPermitidoSchema.safeParse(emailEnorme)
    assert(r.success === false, 'C) e-mail acima de 254 caracteres é rejeitado', r)
  }
  // Sanidade: e-mail de domínio permitido válido dentro do limite continua aceito.
  {
    const r = emailPermitidoSchema.safeParse('fulano@example.com')
    assert(r.success === true, 'Sanidade C) e-mail de domínio permitido válido continua aceito', r)
  }

  // --- D) busca com 120 caracteres → aceita -------------------------------
  {
    const r = buscaSchema.safeParse('a'.repeat(120))
    assert(r.success === true, 'D) busca com 120 caracteres é aceita', r)
  }

  // --- E) busca com 121 caracteres → rejeita ------------------------------
  {
    const r = buscaSchema.safeParse('a'.repeat(121))
    assert(r.success === false, 'E) busca com 121 caracteres é rejeitada', r)
  }
  // Sanidade: busca vazia continua liberada (nenhum filtro aplicado).
  {
    const r = buscaSchema.safeParse('')
    assert(r.success === true, 'Sanidade E) busca vazia continua aceita', r)
  }

  // --- F) papelaria com 1500 caracteres → aceita --------------------------
  {
    const r = itemPapelariaSchema.safeParse({ descricao: 'a'.repeat(1500), quantidade: 1 })
    assert(r.success === true, 'F) descrição de papelaria com 1500 caracteres é aceita', r)
  }

  // --- G) papelaria com 1501 caracteres → rejeita -------------------------
  {
    const r = itemPapelariaSchema.safeParse({ descricao: 'a'.repeat(1501), quantidade: 1 })
    assert(r.success === false, 'G) descrição de papelaria com 1501 caracteres é rejeitada', r)
  }

  // --- H) observação/motivo com 1000 caracteres → aceita ------------------
  {
    const r = rejeitarSchema.safeParse({ motivo: 'a'.repeat(1000) })
    assert(r.success === true, 'H) motivo de rejeição com 1000 caracteres é aceito', r)
  }
  {
    const base = criarSolicitacaoBase()
    const r = criarSolicitacaoSchema.safeParse({ ...base, observacoes: 'a'.repeat(1000) })
    assert(r.success === true, 'H) observações da solicitação com 1000 caracteres são aceitas', r)
  }

  // --- I) observação/motivo com 1001 caracteres → rejeita -----------------
  {
    const r = rejeitarSchema.safeParse({ motivo: 'a'.repeat(1001) })
    assert(r.success === false, 'I) motivo de rejeição com 1001 caracteres é rejeitado', r)
  }
  {
    const base = criarSolicitacaoBase()
    const r = criarSolicitacaoSchema.safeParse({ ...base, observacoes: 'a'.repeat(1001) })
    assert(r.success === false, 'I) observações da solicitação com 1001 caracteres são rejeitadas', r)
  }

  // --- J) categoria/título curto no limite e limite+1 ---------------------
  {
    const rOk = categoriaSchema.safeParse({ nome: 'a'.repeat(100) })
    assert(rOk.success === true, 'J) nome de categoria com 100 caracteres é aceito', rOk)
    const rFalha = categoriaSchema.safeParse({ nome: 'a'.repeat(101) })
    assert(rFalha.success === false, 'J) nome de categoria com 101 caracteres é rejeitado', rFalha)
  }
  {
    const base = { numero: 'PAT-1', marca: 'a'.repeat(120), modelo: 'X', categoriaId: 'cat-1' }
    const rOk = patrimonioSchema.safeParse(base)
    assert(rOk.success === true, 'J) marca de patrimônio com 120 caracteres é aceita', rOk)
    const rFalha = patrimonioSchema.safeParse({ ...base, marca: 'a'.repeat(121) })
    assert(rFalha.success === false, 'J) marca de patrimônio com 121 caracteres é rejeitada', rFalha)
  }

  function criarSolicitacaoBase() {
    return {
      tipoEmprestimo: 'interno',
      ambiente: 'Sala 1',
      data: '2026-09-01',
      periodos: ['MANHA'],
      patrimonioIds: ['patrimonio-1'],
    }
  }

  // ===========================================================================
  // Parte 2 — Enums explícitos, em isolamento (A-E)
  // ===========================================================================

  // --- A) permissao válida → aceita ---------------------------------------
  {
    for (const valor of ['colaborador', 'patrimonio', 'administrador']) {
      const r = permissaoEnum.safeParse(valor)
      assert(r.success === true, `A) permissao válida "${valor}" é aceita`, r)
    }
  }

  // --- B) permissao arbitrária → rejeitada --------------------------------
  {
    const r = permissaoEnum.safeParse('SUPER_ADMIN_DO_MUNDO')
    assert(r.success === false, 'B) permissao arbitrária "SUPER_ADMIN_DO_MUNDO" é rejeitada (schema)', r)
  }

  // --- C) periodo inválido → rejeita (via criarSolicitacaoSchema) ---------
  {
    const base = criarSolicitacaoBase()
    const r = criarSolicitacaoSchema.safeParse({ ...base, periodos: ['MADRUGADA'] })
    assert(r.success === false, 'C) período inválido "MADRUGADA" é rejeitado', r)
  }

  // --- D) tipoEmprestimo inválido → rejeita (via criarSolicitacaoSchema) --
  {
    const base = criarSolicitacaoBase()
    const r = criarSolicitacaoSchema.safeParse({ ...base, tipoEmprestimo: 'hibrido' })
    assert(r.success === false, 'D) tipoEmprestimo inválido "hibrido" é rejeitado', r)
  }

  // --- E) tipoDominio inválido → rejeita (via criarSolicitacaoSchema) -----
  {
    const base = criarSolicitacaoBase()
    const r = criarSolicitacaoSchema.safeParse({ ...base, tipoDominio: 'MISTO' })
    assert(r.success === false, 'E) tipoDominio inválido "MISTO" é rejeitado', r)
  }

  // ===========================================================================
  // Parte 3 — Enums através das rotas REAIS (F-G e além)
  // ===========================================================================

  const ADMIN_ID = 'user-admin-b2-1'
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
  function logarComoAdmin() {
    authModule.getSession = async () => ({
      id: adminFake.id,
      nome: adminFake.nome,
      email: adminFake.email,
      permissao: adminFake.permissao,
      podeSerGestor: adminFake.podeSerGestor,
      podeSolicitarParaOutro: adminFake.podeSolicitarParaOutro,
      versaoSessao: adminFake.versaoSessao,
    })
  }

  // --- B, real) POST /api/colaboradores com permissao arbitrária → 400 ----
  {
    prisma.user = {
      findUnique: async ({ where }: { where: { id?: string; email?: string } }) => {
        if (where.id === ADMIN_ID) return { ...adminFake }
        return null
      },
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'novo-colab-b2-1', ...data }),
    }
    logarComoAdmin()
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rota = require('../src/app/api/colaboradores/route')
    const req = {
      json: async () => ({
        nome: 'Fulano de Tal',
        email: 'fulano.b2@example.com',
        senha: 'SenhaValida123',
        permissao: 'SUPER_ADMIN_DO_MUNDO',
      }),
    } as unknown as Parameters<typeof rota.POST>[0]
    const res = await rota.POST(req)
    const body = await res.json()
    assert(res.status === 400, 'B, real) POST /api/colaboradores com permissao arbitrária retorna 400', res.status)
    assert(body.message === 'Valor de permissão inválido.', 'B, real) mensagem correta', body)
  }

  // --- B, real) PATCH /api/colaboradores/[id] com permissao arbitrária → 400
  {
    const alvoFake = {
      id: 'user-alvo-b2-1',
      nome: 'Alvo',
      email: 'alvo.b2@example.com',
      permissao: 'colaborador' as const,
      ativo: true,
      podeSerGestor: false,
      podeSolicitarParaOutro: false,
      versaoSessao: 0,
    }
    prisma.user = {
      findUnique: async ({ where }: { where: { id?: string } }) => {
        if (where.id === ADMIN_ID) return { ...adminFake }
        if (where.id === alvoFake.id) return { ...alvoFake }
        return null
      },
    }
    logarComoAdmin()
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rota = require('../src/app/api/colaboradores/[id]/route')
    const req = { json: async () => ({ permissao: 'SUPER_ADMIN_DO_MUNDO' }) } as unknown as Parameters<typeof rota.PATCH>[0]
    const res = await rota.PATCH(req, { params: Promise.resolve({ id: alvoFake.id }) })
    const body = await res.json()
    assert(res.status === 400, 'B, real) PATCH /api/colaboradores/[id] com permissao arbitrária retorna 400', res.status)
    assert(body.message === 'Valor de permissão inválido.', 'B, real) mensagem correta (PATCH)', body)
  }

  // --- F) GET /api/solicitacoes com status inválido → rejeita (400) -------
  {
    authModule.getSession = async () => ({
      id: 'user-comum-b2-1',
      nome: 'Comum',
      email: 'comum.b2@example.com',
      permissao: 'colaborador',
      podeSerGestor: false,
      podeSolicitarParaOutro: false,
      versaoSessao: 0,
    })
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rota = require('../src/app/api/solicitacoes/route')
    const req = { url: 'http://localhost:3000/api/solicitacoes?status=STATUS_INEXISTENTE' } as unknown as Parameters<typeof rota.GET>[0]
    const res = await rota.GET(req)
    const body = await res.json()
    assert(res.status === 400, 'F) GET /api/solicitacoes com status inválido retorna 400', res.status)
    assert(body.message === 'Status inválido.', 'F) mensagem correta', body)
  }

  // --- G) GET /api/solicitacoes com escopo inválido → rejeita (400) -------
  {
    authModule.getSession = async () => ({
      id: 'user-comum-b2-1',
      nome: 'Comum',
      email: 'comum.b2@example.com',
      permissao: 'colaborador',
      podeSerGestor: false,
      podeSolicitarParaOutro: false,
      versaoSessao: 0,
    })
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rota = require('../src/app/api/solicitacoes/route')
    const req = { url: 'http://localhost:3000/api/solicitacoes?escopo=ESCOPO_INEXISTENTE' } as unknown as Parameters<typeof rota.GET>[0]
    const res = await rota.GET(req)
    const body = await res.json()
    assert(res.status === 400, 'G) GET /api/solicitacoes com escopo inválido retorna 400', res.status)
    assert(body.message === 'Escopo inválido.', 'G) mensagem correta', body)
  }

  // --- G extra) GET /api/solicitacoes com tipoEmprestimo inválido → 400 ---
  {
    authModule.getSession = async () => ({
      id: 'user-comum-b2-1',
      nome: 'Comum',
      email: 'comum.b2@example.com',
      permissao: 'colaborador',
      podeSerGestor: false,
      podeSolicitarParaOutro: false,
      versaoSessao: 0,
    })
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rota = require('../src/app/api/solicitacoes/route')
    const req = { url: 'http://localhost:3000/api/solicitacoes?tipoEmprestimo=hibrido' } as unknown as Parameters<typeof rota.GET>[0]
    const res = await rota.GET(req)
    const body = await res.json()
    assert(res.status === 400, 'G extra) GET /api/solicitacoes com tipoEmprestimo inválido retorna 400', res.status)
    assert(body.message === 'Tipo de empréstimo inválido.', 'G extra) mensagem correta', body)
  }

  // --- extra) GET /api/patrimonios/disponibilidade com período inválido ---
  {
    authModule.getSession = async () => ({
      id: 'user-comum-b2-1',
      nome: 'Comum',
      email: 'comum.b2@example.com',
      permissao: 'colaborador',
      podeSerGestor: false,
      podeSolicitarParaOutro: false,
      versaoSessao: 0,
    })
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rota = require('../src/app/api/patrimonios/disponibilidade/route')
    const req = {
      url: 'http://localhost:3000/api/patrimonios/disponibilidade?categoriaId=cat-1&data=2026-09-01&periodo=MADRUGADA',
    } as unknown as Parameters<typeof rota.GET>[0]
    const res = await rota.GET(req)
    const body = await res.json()
    assert(res.status === 400, 'extra) GET disponibilidade com período inválido retorna 400', res.status)
    assert(body.message === 'Período inválido.', 'extra) mensagem correta', body)
  }

  // --- extra) GET /api/patrimonios/disponibilidade com modo inválido ------
  {
    authModule.getSession = async () => ({
      id: 'user-comum-b2-1',
      nome: 'Comum',
      email: 'comum.b2@example.com',
      permissao: 'colaborador',
      podeSerGestor: false,
      podeSolicitarParaOutro: false,
      versaoSessao: 0,
    })
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rota = require('../src/app/api/patrimonios/disponibilidade/route')
    const req = {
      url: 'http://localhost:3000/api/patrimonios/disponibilidade?categoriaId=cat-1&modo=turbo',
    } as unknown as Parameters<typeof rota.GET>[0]
    const res = await rota.GET(req)
    const body = await res.json()
    assert(res.status === 400, 'extra) GET disponibilidade com modo inválido retorna 400', res.status)
    assert(body.message === 'Modo inválido.', 'extra) mensagem correta', body)
  }

  // --- extra) busca acima do limite → 400 (GET /api/colaboradores/busca) --
  {
    authModule.getSession = async () => ({
      id: 'user-comum-b2-1',
      nome: 'Comum',
      email: 'comum.b2@example.com',
      permissao: 'colaborador',
      podeSerGestor: false,
      podeSolicitarParaOutro: false,
      versaoSessao: 0,
    })
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rota = require('../src/app/api/colaboradores/busca/route')
    const req = { url: `http://localhost:3000/api/colaboradores/busca?busca=${'a'.repeat(121)}` } as unknown as Parameters<typeof rota.GET>[0]
    const res = await rota.GET(req)
    const body = await res.json()
    assert(res.status === 400, 'extra) GET /api/colaboradores/busca com busca > 120 retorna 400', res.status)
    assert(body.message === 'Busca deve ter no máximo 120 caracteres.', 'extra) mensagem correta', body)
  }

  // --- extra) construirFiltros (relatórios) com status inválido → lança ---
  {
    const params = new URLSearchParams({ status: 'STATUS_INEXISTENTE' })
    let lancou = false
    let ehTipoCorreto = false
    try {
      construirFiltros(params)
    } catch (e) {
      lancou = true
      ehTipoCorreto = e instanceof FiltroRelatorioInvalidoError
    }
    assert(lancou, 'extra) construirFiltros com status inválido lança um erro', undefined)
    assert(ehTipoCorreto, 'extra) o erro lançado é FiltroRelatorioInvalidoError', undefined)
  }

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) de S6-B2 (schemas/strings/enums) falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes de S6-B2 (schemas/strings/enums) passaram. Nenhum banco real acessado.')
}

main().catch((err) => {
  console.error('Falha inesperada ao executar os testes de S6-B2:', err instanceof Error ? err.message : err)
  process.exit(1)
})
