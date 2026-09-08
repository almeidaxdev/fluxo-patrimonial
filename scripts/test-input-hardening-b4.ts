// scripts/test-input-hardening-b4.ts
//
// Etapa security/input-hardening-b4 — fronteiras de input.
//
//   Parte 1 (A-H): `.strict()` nos schemas que recebem um objeto inteiro do
//     cliente — um campo extra não previsto é rejeitado explicitamente, em
//     vez de silenciosamente descartado. Testado em isolamento, direto nos
//     schemas de src/lib/validations.ts. Inclui uma sanidade por schema
//     (payload exato, sem campo extra, continua aceito).
//   Parte 2 (I-L): `enviarAssinaturaSchema` rejeita esquemas de URL que não
//     sejam http/https (ex.: `javascript:`) — o link é renderizado como
//     `href` na tela da solicitação para o SOLICITANTE clicar, não para
//     quem o cadastrou (Patrimônio/Admin).
//   Parte 3 (M-P): corpo JSON malformado devolve 400 controlado (nunca 500)
//     nas rotas REAIS que usam `parseJsonBody` (src/lib/http.ts) — testado
//     através dos handlers reais de POST /api/categorias, PATCH
//     /api/colaboradores/[id], POST /api/solicitacoes e POST
//     /api/solicitacoes/[id]/rejeitar-gestor. Inclui uma sanidade de que o
//     fluxo normal (JSON válido, porém com dados de negócio inválidos)
//     continua respondendo como antes.
//
// Importa e chama os handlers REAIS das rotas — prisma e getSession/
// getValidatedMutationSession são mocks em memória (mesmo padrão de
// scripts/test-input-hardening-b2.ts e scripts/test-input-hardening-b3.ts).
// Nenhum banco real é acessado.
//
// Executar com: npm run test:input-hardening-b4

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
  const {
    categoriaSchema,
    patrimonioSchema,
    rejeitarSchema,
    devolucaoSchema,
    retiradaSchema,
    itemPapelariaSchema,
    itemServicoSchema,
    criarSolicitacaoSchema,
    enviarAssinaturaSchema,
  } = require('../src/lib/validations')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { prisma } = require('../src/lib/prisma')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const authModule = require('../src/lib/auth')

  authModule.setSession = async () => {}

  // ===========================================================================
  // Parte 1 — `.strict()`: campo extra não previsto é rejeitado (A-H)
  // ===========================================================================

  // --- A) categoriaSchema com campo extra → rejeita -----------------------
  {
    const r = categoriaSchema.safeParse({ nome: 'Notebooks', permissao: 'administrador' })
    assert(r.success === false, 'A) categoriaSchema com campo extra "permissao" é rejeitado', r)
  }
  {
    const r = categoriaSchema.safeParse({ nome: 'Notebooks' })
    assert(r.success === true, 'Sanidade A) categoriaSchema sem campo extra continua aceito', r)
  }

  // --- B) patrimonioSchema com campo extra → rejeita -----------------------
  {
    const base = { numero: 'PAT-1', marca: 'Dell', modelo: 'X', categoriaId: 'cat-1' }
    const r = patrimonioSchema.safeParse({ ...base, versaoSessao: 99 })
    assert(r.success === false, 'B) patrimonioSchema com campo extra "versaoSessao" é rejeitado', r)
    const rOk = patrimonioSchema.safeParse(base)
    assert(rOk.success === true, 'Sanidade B) patrimonioSchema sem campo extra continua aceito', rOk)
  }

  // --- C) rejeitarSchema com campo extra → rejeita -------------------------
  {
    const r = rejeitarSchema.safeParse({ motivo: 'Motivo válido aqui', status: 'CANCELADA' })
    assert(r.success === false, 'C) rejeitarSchema com campo extra "status" é rejeitado', r)
  }

  // --- D) devolucaoSchema com campo extra → rejeita ------------------------
  {
    const r = devolucaoSchema.safeParse({ condicao: 'SEM_AVARIAS', devolucaoPorId: 'user-x' })
    assert(r.success === false, 'D) devolucaoSchema com campo extra "devolucaoPorId" é rejeitado', r)
  }

  // --- E) retiradaSchema com campo extra → rejeita -------------------------
  {
    const r = retiradaSchema.safeParse({ observacoes: 'ok', retiradaPorId: 'user-x' })
    assert(r.success === false, 'E) retiradaSchema com campo extra "retiradaPorId" é rejeitado', r)
  }

  // --- F) itemPapelariaSchema com campo extra → rejeita --------------------
  {
    const r = itemPapelariaSchema.safeParse({ descricao: 'Cartolina', quantidade: 2, preco: 10 })
    assert(r.success === false, 'F) itemPapelariaSchema com campo extra "preco" é rejeitado', r)
  }

  // --- G) itemServicoSchema com campo extra → rejeita -----------------------
  {
    const r = itemServicoSchema.safeParse({ tipoServicoId: 'ts-1', quantidade: 1, ambiente: 'Sala 1', aprovado: true })
    assert(r.success === false, 'G) itemServicoSchema com campo extra "aprovado" é rejeitado', r)
  }

  // --- H) criarSolicitacaoSchema: campo extra é descartado (NUNCA lido pela
  // rota) — este schema é DELIBERADAMENTE não-strict (ver comentário em
  // src/lib/validations.ts e scripts/test-solicitacoes-para-outro.ts,
  // cenário G): a rota nunca usa `status`/`criadoPorId`/`podeSolicitarParaOutro`
  // vindos do body em lugar nenhum — a autorização depende só da sessão
  // validada — então um campo extra aqui é inofensivo mesmo sem `.strict()`,
  // e mantê-lo tolerante preserva o contrato de status já testado (403 do
  // gate de autorização, nunca 400 de validação estrutural).
  {
    const base = {
      tipoEmprestimo: 'interno',
      ambiente: 'Sala 1',
      data: '2026-09-01',
      periodos: ['MANHA'],
      patrimonioIds: ['patrimonio-1'],
    }
    const r = criarSolicitacaoSchema.safeParse({ ...base, criadoPorId: 'user-outro', status: 'FINALIZADA' })
    assert(r.success === true, 'H) criarSolicitacaoSchema com campos extras é aceito (descartados, nunca lidos pela rota)', r)
    assert(
      !('criadoPorId' in r.data) && !('status' in r.data),
      'H) campos extras não sobrevivem ao parse (não chegam a `parsed.data`)',
      r.data
    )
  }

  // ===========================================================================
  // Parte 2 — enviarAssinaturaSchema: esquema de URL restrito a http(s) (I-L)
  // ===========================================================================

  // --- I) link com esquema "javascript:" → rejeita --------------------------
  {
    const r = enviarAssinaturaSchema.safeParse({ link: 'javascript:alert(1)' })
    assert(r.success === false, 'I) link com esquema "javascript:" é rejeitado', r)
  }

  // --- J) link "data:" → rejeita ---------------------------------------------
  {
    const r = enviarAssinaturaSchema.safeParse({ link: 'data:text/html,<script>alert(1)</script>' })
    assert(r.success === false, 'J) link com esquema "data:" é rejeitado', r)
  }

  // --- K) link http:// → aceita -----------------------------------------------
  {
    const r = enviarAssinaturaSchema.safeParse({ link: 'http://exemplo.com.br/assinar' })
    assert(r.success === true, 'K) link http:// é aceito', r)
  }

  // --- L) link https:// → aceita -----------------------------------------------
  {
    const r = enviarAssinaturaSchema.safeParse({ link: 'https://exemplo.com.br/assinar' })
    assert(r.success === true, 'L) link https:// é aceito', r)
  }

  // ===========================================================================
  // Parte 3 — JSON malformado → 400 controlado nas rotas REAIS (M-P)
  // ===========================================================================

  const ADMIN = {
    id: 'user-admin-b4',
    nome: 'Admin B4',
    email: 'admin.b4@example.com',
    permissao: 'administrador' as const,
    ativo: true,
    podeSerGestor: false,
    podeSolicitarParaOutro: false,
    versaoSessao: 0,
  }

  function jsonQuebrado() {
    return async () => {
      throw new SyntaxError('Unexpected token in JSON')
    }
  }

  // --- M) POST /api/categorias com JSON malformado → 400 --------------------
  {
    prisma.user = { findUnique: async ({ where }: { where: { id: string } }) => (where.id === ADMIN.id ? { ...ADMIN } : null) }
    authModule.getSession = async () => ({ ...ADMIN })
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rota = require('../src/app/api/categorias/route')
    const req = { json: jsonQuebrado() } as unknown as Parameters<typeof rota.POST>[0]
    const res = await rota.POST(req)
    assert(res.status === 400, 'M) POST /api/categorias com JSON malformado retorna 400 (nunca 500)', res.status)
  }

  // --- N) PATCH /api/colaboradores/[id] com JSON malformado → 400 -----------
  {
    prisma.user = { findUnique: async ({ where }: { where: { id: string } }) => (where.id === ADMIN.id ? { ...ADMIN } : null) }
    authModule.getSession = async () => ({ ...ADMIN })
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rota = require('../src/app/api/colaboradores/[id]/route')
    const req = { json: jsonQuebrado() } as unknown as Parameters<typeof rota.PATCH>[0]
    const res = await rota.PATCH(req, { params: Promise.resolve({ id: 'outro-user' }) })
    assert(res.status === 400, 'N) PATCH /api/colaboradores/[id] com JSON malformado retorna 400 (nunca 500)', res.status)
  }

  // --- O) POST /api/solicitacoes com JSON malformado → 400 -------------------
  {
    const COMUM = {
      id: 'user-comum-b4',
      nome: 'Comum B4',
      email: 'comum.b4@example.com',
      permissao: 'colaborador' as const,
      ativo: true,
      podeSerGestor: false,
      podeSolicitarParaOutro: false,
      versaoSessao: 0,
    }
    prisma.user = { findUnique: async ({ where }: { where: { id: string } }) => (where.id === COMUM.id ? { ...COMUM } : null) }
    authModule.getSession = async () => ({ ...COMUM })
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rota = require('../src/app/api/solicitacoes/route')
    const req = { json: jsonQuebrado() } as unknown as Parameters<typeof rota.POST>[0]
    const res = await rota.POST(req)
    assert(res.status === 400, 'O) POST /api/solicitacoes com JSON malformado retorna 400 (nunca 500)', res.status)
  }

  // --- P) POST /api/solicitacoes/[id]/rejeitar-gestor com JSON malformado → 400
  {
    const GESTOR = {
      id: 'user-gestor-b4',
      nome: 'Gestor B4',
      email: 'gestor.b4@example.com',
      permissao: 'colaborador' as const,
      ativo: true,
      podeSerGestor: true,
      podeSolicitarParaOutro: false,
      versaoSessao: 0,
    }
    prisma.user = { findUnique: async ({ where }: { where: { id: string } }) => (where.id === GESTOR.id ? { ...GESTOR } : null) }
    authModule.getSession = async () => ({ ...GESTOR })
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rota = require('../src/app/api/solicitacoes/[id]/rejeitar-gestor/route')
    const req = { json: jsonQuebrado() } as unknown as Parameters<typeof rota.POST>[0]
    const res = await rota.POST(req, { params: Promise.resolve({ id: 'solicitacao-fake' }) })
    assert(res.status === 400, 'P) POST rejeitar-gestor com JSON malformado retorna 400 (nunca 500)', res.status)
  }

  // --- Sanidade) POST /api/categorias com JSON válido mas dado de negócio inválido
  // continua 400 com a mensagem de validação usual (parseJsonBody não muda o
  // caminho de erro de negócio, só o de corpo malformado).
  {
    prisma.user = { findUnique: async ({ where }: { where: { id: string } }) => (where.id === ADMIN.id ? { ...ADMIN } : null) }
    authModule.getSession = async () => ({ ...ADMIN })
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rota = require('../src/app/api/categorias/route')
    const req = { json: async () => ({ nome: '' }) } as unknown as Parameters<typeof rota.POST>[0]
    const res = await rota.POST(req)
    const body = await res.json()
    assert(res.status === 400, 'Sanidade) POST /api/categorias com nome vazio continua 400', res.status)
    assert(body.message === 'Nome é obrigatório.', 'Sanidade) mensagem de validação de negócio preservada', body)
  }

  console.log('')
  if (failures > 0) {
    console.error(`${failures} verificação(ões) falharam.`)
    process.exit(1)
  } else {
    console.log('Todas as verificações passaram.')
  }
}

main().catch((e) => {
  console.error('Erro inesperado ao rodar os testes:', e)
  process.exit(1)
})
