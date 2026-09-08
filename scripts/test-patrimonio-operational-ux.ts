// scripts/test-patrimonio-operational-ux.ts
//
// Etapa feat/patrimonio-operational-ux — experiência própria do perfil
// PATRIMONIO: páginas pessoais de colaborador (Nova Solicitação, Minhas
// Solicitações) deixam de estar disponíveis para quem é EXCLUSIVAMENTE
// Patrimônio, com proteção real de rota (middleware, nunca só o Sidebar) —
// acessar a URL diretamente também é bloqueado. Administrador e Colaborador/
// Gestor não são afetados por essa regra.
//
// Cobre:
//   A) middleware bloqueia PATRIMONIO em /nova-solicitacao e
//      /minhas-solicitacoes → redireciona para /lobby (nunca renderiza a
//      página pessoal só porque a URL foi digitada direto).
//   B) middleware continua liberando PATRIMONIO nas rotas operacionais já
//      existentes (ex.: /pendencias) — regressão da regra já homologada.
//   C) ADMINISTRADOR não é afetado pela nova regra — continua acessando as
//      páginas pessoais normalmente.
//   D) COLABORADOR/GESTOR não são afetados — comportamento prévio intacto
//      (inclusive a regra já existente que barra COLABORADOR de rotas
//      exclusivas de Patrimônio).
//   E) GET /api/dashboard: o novo campo `naoRetiradas` só aparece dentro de
//      `patrimonio` quando o chamador é Patrimônio/Admin — nunca para
//      colaborador comum (nenhum custo/exposição extra para quem não usa).
//   F) STATUS_PENDENCIA_PATRIMONIO (src/lib/status.ts) — homologação visual:
//      contém exatamente os status em que o Patrimônio tem uma ação real
//      disponível; NUNCA inclui AGUARDANDO_ASSINATURA (aguardando o
//      solicitante assinar) nem CONFIRMADA (inalcançável na prática).
//   G) Cada card do Painel do Patrimônio abre Todas as Solicitações já
//      filtrada pelo status correspondente (verificação estrutural do
//      arquivo-fonte — mesmo padrão já usado por
//      scripts/test-session-revalidation.ts, item AF, para middleware.ts).
//   H) Todas as Solicitações usa `useSearchParams()` (reativo) como única
//      fonte do filtro — NUNCA mais `window.location.search`/`useState`
//      paralelo, a causa raiz do bug relatado na homologação (card abria a
//      tela, mas o filtro não era aplicado — ver correção em
//      src/app/(dashboard)/todas-solicitacoes/page.tsx). Verificação
//      estrutural do arquivo-fonte.
//   I) Prova REAL (não estrutural) de que card → query string → filtro
//      aplicado funciona: usa as funções PURAS reais extraídas para
//      `filtros.ts` (`statusValidoDaUrl`, `montarParametrosBusca`) —
//      simula a URL exata que cada card do Painel gera, deriva o `status`
//      dela exatamente como o componente faz, e confirma que esse `status`
//      chega intacto aos query params do `GET /api/solicitacoes` — a
//      cadeia inteira que a homologação encontrou quebrada.
//
// Importa e chama os handlers REAIS (middleware + rota) — prisma e
// verifyToken/getSession são mocks em memória. Nenhum banco real é
// acessado, nenhum JWT real é assinado/verificado. F/G/H são checagens
// estáticas do próprio arquivo-fonte (sem DOM/renderer disponível neste
// projeto — mesmo padrão já usado para middleware.ts); I chama funções
// reais e testáveis (não precisa de DOM/renderer).
//
// Executar com: npm run test:patrimonio-operational-ux

import { readFileSync } from 'fs'
import { join } from 'path'
import type { NextRequest } from 'next/server'
import type { SessionUser } from '../src/types'

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

function fakeRequest(pathname: string, token?: string): NextRequest {
  return {
    nextUrl: { pathname },
    url: `http://localhost:3000${pathname}`,
    cookies: { get: (name: string) => (name === 'session' && token ? { value: token } : undefined) },
  } as unknown as NextRequest
}

function locationPath(res: Response): string | null {
  const loc = res.headers.get('location')
  if (!loc) return null
  return new URL(loc).pathname
}

async function main() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const authModule = require('../src/lib/auth')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { middleware } = require('../src/middleware')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { prisma } = require('../src/lib/prisma')

  const TOKENS: Record<string, SessionUser> = {
    'token-patrimonio': { id: 'user-patrimonio', nome: 'Beto Patrimônio', email: 'beto@example.com', permissao: 'patrimonio', podeSerGestor: false, podeSolicitarParaOutro: false, versaoSessao: 0 },
    'token-admin': { id: 'user-admin', nome: 'Ana Admin', email: 'ana@example.com', permissao: 'administrador', podeSerGestor: false, podeSolicitarParaOutro: false, versaoSessao: 0 },
    'token-colaborador': { id: 'user-colaborador', nome: 'Carlos Colaborador', email: 'carlos@example.com', permissao: 'colaborador', podeSerGestor: false, podeSolicitarParaOutro: false, versaoSessao: 0 },
    'token-gestor': { id: 'user-gestor', nome: 'Gina Gestora', email: 'gina@example.com', permissao: 'colaborador', podeSerGestor: true, podeSolicitarParaOutro: false, versaoSessao: 0 },
  }
  authModule.verifyToken = async (token: string) => TOKENS[token] ?? null

  // ===========================================================================
  // Parte A — PATRIMONIO bloqueado nas páginas pessoais (nunca só o Sidebar)
  // ===========================================================================

  for (const pagina of ['/nova-solicitacao', '/minhas-solicitacoes']) {
    const res = await middleware(fakeRequest(pagina, 'token-patrimonio'))
    assert(locationPath(res) === '/lobby', `A) PATRIMONIO acessando ${pagina} diretamente é redirecionado para /lobby`, locationPath(res))
  }

  // ===========================================================================
  // Parte B — PATRIMONIO continua liberado nas rotas operacionais (regressão)
  // ===========================================================================

  for (const pagina of ['/pendencias', '/todas-solicitacoes', '/atendimento-imediato', '/relatorios', '/patrimonios']) {
    const res = await middleware(fakeRequest(pagina, 'token-patrimonio'))
    assert(locationPath(res) === null, `B) PATRIMONIO continua acessando ${pagina} normalmente (sem redirect)`, locationPath(res))
  }

  // ===========================================================================
  // Parte C — ADMINISTRADOR não é afetado pela nova regra
  // ===========================================================================

  for (const pagina of ['/nova-solicitacao', '/minhas-solicitacoes']) {
    const res = await middleware(fakeRequest(pagina, 'token-admin'))
    assert(locationPath(res) === null, `C) ADMINISTRADOR continua acessando ${pagina} normalmente (sem redirect)`, locationPath(res))
  }

  // ===========================================================================
  // Parte D — COLABORADOR/GESTOR sem regressão
  // ===========================================================================

  for (const pagina of ['/nova-solicitacao', '/minhas-solicitacoes']) {
    const res = await middleware(fakeRequest(pagina, 'token-colaborador'))
    assert(locationPath(res) === null, `D) COLABORADOR continua acessando ${pagina} normalmente (sem redirect)`, locationPath(res))
  }
  {
    // Regra já existente (pré-etapa): COLABORADOR continua barrado de rota
    // exclusiva de Patrimônio — nunca regredida por esta etapa.
    const res = await middleware(fakeRequest('/pendencias', 'token-colaborador'))
    assert(locationPath(res) === '/lobby', 'D) COLABORADOR continua barrado de /pendencias (regra pré-existente intacta)', locationPath(res))
  }
  {
    // Gestor (podeSerGestor, sem ser Patrimônio) continua acessando /aprovacoes.
    const res = await middleware(fakeRequest('/aprovacoes', 'token-gestor'))
    assert(locationPath(res) === null, 'D) GESTOR continua acessando /aprovacoes normalmente', locationPath(res))
  }

  // ===========================================================================
  // Parte E — GET /api/dashboard: naoRetiradas só para Patrimônio/Admin
  // ===========================================================================

  prisma.solicitacao = {
    count: async ({ where }: { where?: { status?: string } }) => (where?.status === 'NAO_RETIRADA' ? 7 : 0),
    findMany: async () => [],
  }
  prisma.patrimonio = { count: async () => 0 }

  {
    authModule.getSession = async () => TOKENS['token-patrimonio']
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rota = require('../src/app/api/dashboard/route')
    const res = await rota.GET()
    const body = await res.json()
    assert(body.patrimonio?.naoRetiradas === 7, 'E) GET /api/dashboard devolve naoRetiradas para sessão Patrimônio', body.patrimonio)
  }
  {
    authModule.getSession = async () => TOKENS['token-colaborador']
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rota = require('../src/app/api/dashboard/route')
    const res = await rota.GET()
    const body = await res.json()
    assert(body.patrimonio === undefined, 'E) GET /api/dashboard NUNCA inclui o bloco `patrimonio` (nem naoRetiradas) para colaborador comum', body)
  }

  // ===========================================================================
  // Parte F — STATUS_PENDENCIA_PATRIMONIO: só status com ação real do Patrimônio
  // ===========================================================================

  {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { STATUS_PENDENCIA_PATRIMONIO } = require('../src/lib/status')
    const esperados = ['AGUARDANDO_PATRIMONIO', 'AGUARDANDO_ENVIO_ASSINATURA', 'ASSINATURA_CONFIRMADA', 'EM_SEPARACAO', 'PRONTA_RETIRADA', 'EM_UTILIZACAO']
    assert(
      esperados.length === STATUS_PENDENCIA_PATRIMONIO.length && esperados.every((s) => STATUS_PENDENCIA_PATRIMONIO.includes(s)),
      'F) STATUS_PENDENCIA_PATRIMONIO contém exatamente os 6 status com ação real do Patrimônio',
      STATUS_PENDENCIA_PATRIMONIO
    )
    assert(!STATUS_PENDENCIA_PATRIMONIO.includes('AGUARDANDO_ASSINATURA'), 'F) AGUARDANDO_ASSINATURA fora da lista — é o solicitante quem precisa agir, não o Patrimônio', STATUS_PENDENCIA_PATRIMONIO)
    assert(!STATUS_PENDENCIA_PATRIMONIO.includes('CONFIRMADA'), 'F) CONFIRMADA fora da lista — status inalcançável na prática', STATUS_PENDENCIA_PATRIMONIO)
  }

  // ===========================================================================
  // Parte G — cada card do Painel abre Todas as Solicitações no status certo
  // ===========================================================================
  //
  // Etapa feat/admin-dashboard-operational: os cards moraram em
  // PainelPatrimonio.tsx até esta etapa; agora vivem em
  // OperacaoPatrimonio.tsx (componente COMPARTILHADO), reaproveitado tanto
  // pelo Painel do Patrimônio (perfil PATRIMONIO) quanto pela seção
  // "Operação do Patrimônio" do Dashboard do Admin — uma única checagem
  // aqui cobre os dois consumidores, nunca duas fontes de verdade.

  {
    const painel = readFileSync(join(__dirname, '..', 'src', 'app', '(dashboard)', 'lobby', 'OperacaoPatrimonio.tsx'), 'utf8')
    const mapaEsperado: Record<string, string> = {
      'Aguardando análise': 'AGUARDANDO_PATRIMONIO',
      'Em separação': 'EM_SEPARACAO',
      'Prontas para retirada': 'PRONTA_RETIRADA',
      'Em utilização': 'EM_UTILIZACAO',
      'Não retiradas': 'NAO_RETIRADA',
    }
    for (const [label, status] of Object.entries(mapaEsperado)) {
      const regex = new RegExp(`label="${label}"[\\s\\S]{0,200}?href="/todas-solicitacoes\\?status=${status}"`)
      assert(regex.test(painel), `G) card "${label}" abre /todas-solicitacoes?status=${status}`, status)
    }
    assert(/href="\/patrimonios"/.test(painel), 'G) card de inventário ("Bens ativos") abre /patrimonios', true)
    // Nenhum card de status aponta mais para /pendencias — Todas as
    // Solicitações é a infraestrutura de filtro reaproveitada (item 1 do
    // pedido de homologação), nunca uma listagem paralela.
    assert(!/StatCard[\s\S]{0,300}?href="\/pendencias"/.test(painel), 'G) nenhum StatCard de status aponta para /pendencias (reaproveita Todas as Solicitações)', true)
  }

  // ===========================================================================
  // Parte H — Todas as Solicitações: useSearchParams reativo (correção do bug)
  // ===========================================================================

  {
    const pagina = readFileSync(join(__dirname, '..', 'src', 'app', '(dashboard)', 'todas-solicitacoes', 'page.tsx'), 'utf8')
    assert(/useSearchParams/.test(pagina), 'H) usa useSearchParams() (reativo) como fonte do filtro', true)
    assert(/router\.replace/.test(pagina), 'H) mantém a URL sincronizada com o filtro atual (router.replace)', true)
    assert(/atualizarStatus\(''\)/.test(pagina), 'H) existe uma forma de limpar o filtro (atualizarStatus(\'\'))', true)
    // Guarda de regressão: a causa raiz do bug relatado na homologação era
    // exatamente ler `window.location.search` dentro de um
    // `useState(() => ...)` — esse PADRÃO DE CÓDIGO não pode voltar (o
    // arquivo pode mencionar a string em comentário/documentação, como este
    // próprio arquivo faz ao explicar a correção — por isso o regex exige
    // a chamada de verdade, `(window.location.search)`, não a string solta).
    assert(!/new URLSearchParams\(window\.location\.search\)/.test(pagina), 'H) NUNCA mais lê window.location.search diretamente (causa raiz do bug corrigida)', true)
  }

  // ===========================================================================
  // Parte I — prova real: card → query string → filtro aplicado (funções reais)
  // ===========================================================================

  {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { statusValidoDaUrl, montarParametrosBusca } = require('../src/app/(dashboard)/todas-solicitacoes/filtros')

    // --- I1) URL com status válido → status derivado corretamente ---------
    assert(statusValidoDaUrl(new URLSearchParams('status=EM_UTILIZACAO')) === 'EM_UTILIZACAO', 'I1) status válido na URL é derivado corretamente', true)

    // --- I2) URL com status fora do enum → cai no default (sem filtro) ----
    assert(statusValidoDaUrl(new URLSearchParams('status=LIXO_INVALIDO')) === '', 'I2) status arbitrário/inválido na URL é ignorado (sem filtro), nunca repassado cru', true)

    // --- I3) URL sem status → sem filtro -----------------------------------
    assert(statusValidoDaUrl(new URLSearchParams('')) === '', 'I3) URL sem status resulta em nenhum filtro', true)

    // --- I4) Cada card do Painel: href → status derivado → query real da API
    const cardsDoPainel: Record<string, string> = {
      'Aguardando análise': 'AGUARDANDO_PATRIMONIO',
      'Em separação': 'EM_SEPARACAO',
      'Prontas para retirada': 'PRONTA_RETIRADA',
      'Em utilização': 'EM_UTILIZACAO',
      'Não retiradas': 'NAO_RETIRADA',
    }
    for (const [label, statusEsperado] of Object.entries(cardsDoPainel)) {
      // Mesma URL que o card realmente gera (ver OperacaoPatrimonio.tsx).
      const url = new URL(`http://localhost:3000/todas-solicitacoes?status=${statusEsperado}`)
      const statusDerivado = statusValidoDaUrl(url.searchParams)
      assert(statusDerivado === statusEsperado, `I4) card "${label}": status derivado da URL bate com o esperado`, statusDerivado)

      const params = montarParametrosBusca({ status: statusDerivado, tipoEmprestimo: '', numero: '', modo: 'lista', data: '', page: 1, limit: 20 })
      assert(params.get('status') === statusEsperado, `I4) card "${label}": o filtro chega intacto ao query real de GET /api/solicitacoes`, params.get('status'))
      assert(params.get('escopo') === 'todas', `I4) card "${label}": escopo continua "todas" (nunca só "minhas")`, params.get('escopo'))
    }

    // --- I5) Limpar o filtro remove `status` por completo do query (nunca "status=") ---
    const paramsLimpos = montarParametrosBusca({ status: '', tipoEmprestimo: '', numero: '', modo: 'lista', data: '', page: 1, limit: 20 })
    assert(!paramsLimpos.has('status'), 'I5) limpar o filtro remove o parâmetro status por completo do query', paramsLimpos.toString())
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
