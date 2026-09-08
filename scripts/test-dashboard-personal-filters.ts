// scripts/test-dashboard-personal-filters.ts
//
// Etapa feat/admin-dashboard-operational (homologação pós-entrega) — a
// homologação encontrou os CARDS PESSOAIS do Dashboard (Minhas solicitações
// em andamento, Assinaturas pendentes, Prontas para retirada) levando para
// /minhas-solicitacoes SEM nenhum filtro aplicado — a lista completa, não a
// fatia que o contador do card prometia. Diferente dos cards operacionais
// do Patrimônio (já homologados — ver scripts/test-patrimonio-operational-ux.ts),
// que sempre aplicaram o mesmo princípio card → URL → filtro real.
//
// Cobre:
//   A) "Em andamento": o preset semântico (`FILTRO_EM_ANDAMENTO`/
//      `filtro=em_andamento`) usa EXATAMENTE `STATUS_EM_ANDAMENTO_SOLICITANTE`
//      (src/lib/status.ts) — a MESMA lista usada pelo contador
//      (`minhasPendentes` em GET /api/dashboard, ver scripts/test-dashboard.ts)
//      — nunca um único status inventado, nunca duas listas divergentes.
//   B) "Assinaturas pendentes": filtro real é `AGUARDANDO_ASSINATURA` do
//      PRÓPRIO solicitante — nunca confundido com `AGUARDANDO_ENVIO_
//      ASSINATURA` (ação do Patrimônio, não do solicitante).
//   C) "Prontas para retirada": filtro real é `PRONTA_RETIRADA`.
//   D) F5 preserva o filtro — `useSearchParams()` é a única fonte de
//      verdade (verificação estrutural do arquivo-fonte, mesmo padrão já
//      usado para todas-solicitacoes/page.tsx).
//   E) Limpar o filtro remove o parâmetro por completo (nunca "status=").
//   F) Trocar o filtro na interface sincroniza a URL (router.replace,
//      verificação estrutural).
//   G) Dashboard do Admin: os 3 cards pessoais quantitativos usam os hrefs
//      corretos (verificação estrutural de lobby/page.tsx) — Admin também é
//      um usuário comum, mesma regra pessoal de qualquer perfil.
//   H) Dashboard do Colaborador/Gestor: MESMO arquivo-fonte (lobby/page.tsx
//      é compartilhado por todos os perfis não-Patrimônio) — os mesmos 3
//      hrefs valem igualmente, sem nenhuma implementação separada.
//   I) Gestor: card "Atividades externas" continua abrindo /aprovacoes sem
//      filtro adicional — a própria rota já restringe a
//      escopo=gestor&status=AGUARDANDO_GESTOR do usuário autenticado
//      (verificação estrutural + chamada real da rota).
//   J) GET /api/solicitacoes: prova REAL (não só o href) de que
//      `escopo=minhas&status=AGUARDANDO_ASSINATURA`,
//      `escopo=minhas&status=PRONTA_RETIRADA` e
//      `escopo=minhas&filtro=em_andamento` chegam ao `where` do Prisma
//      exatamente como esperado — chamando o handler REAL da rota com
//      Prisma mockado. Cards operacionais do Patrimônio (`?status=...` em
//      /todas-solicitacoes) continuam intactos — regressão coberta por
//      scripts/test-patrimonio-operational-ux.ts, não duplicada aqui.
//
// Importa e chama os handlers REAIS (rota + funções puras de filtros.ts) —
// prisma e getSession são mocks em memória. Nenhum banco real é acessado,
// nenhum DOM/renderer é necessário (mesmo padrão já usado por
// scripts/test-patrimonio-operational-ux.ts).
//
// Executar com: npm run test:dashboard-personal-filters

import { readFileSync } from 'fs'
import { join } from 'path'

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
  const { prisma } = require('../src/lib/prisma')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const authModule = require('../src/lib/auth')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { STATUS_EM_ANDAMENTO_SOLICITANTE } = require('../src/lib/status')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { FILTRO_EM_ANDAMENTO, filtroPessoalValidoDaUrl, montarParametrosBuscaPessoal } = require('../src/app/(dashboard)/minhas-solicitacoes/filtros')

  const lobby = readFileSync(join(__dirname, '..', 'src', 'app', '(dashboard)', 'lobby', 'page.tsx'), 'utf8')
  const minhasSolicitacoes = readFileSync(join(__dirname, '..', 'src', 'app', '(dashboard)', 'minhas-solicitacoes', 'page.tsx'), 'utf8')
  const aprovacoes = readFileSync(join(__dirname, '..', 'src', 'app', '(dashboard)', 'aprovacoes', 'page.tsx'), 'utf8')

  // ===========================================================================
  // Parte A — "Em andamento": mesma lista do contador, nunca um status inventado
  // ===========================================================================

  {
    const esperados = ['AGUARDANDO_GESTOR', 'AGUARDANDO_PATRIMONIO', 'CONFIRMADA', 'AGUARDANDO_ENVIO_ASSINATURA', 'AGUARDANDO_ASSINATURA', 'ASSINATURA_CONFIRMADA', 'EM_SEPARACAO', 'PRONTA_RETIRADA', 'EM_UTILIZACAO']
    assert(
      esperados.length === STATUS_EM_ANDAMENTO_SOLICITANTE.length && esperados.every((s) => STATUS_EM_ANDAMENTO_SOLICITANTE.includes(s)),
      'A) STATUS_EM_ANDAMENTO_SOLICITANTE contém exatamente os 9 status "não terminais/negativos" do solicitante',
      STATUS_EM_ANDAMENTO_SOLICITANTE
    )
    assert(!STATUS_EM_ANDAMENTO_SOLICITANTE.includes('NAO_RETIRADA'), 'A) NAO_RETIRADA fora da lista (mesma exclusão já aplicada pelo contador antigo)', STATUS_EM_ANDAMENTO_SOLICITANTE)
    assert(!STATUS_EM_ANDAMENTO_SOLICITANTE.includes('FINALIZADA') && !STATUS_EM_ANDAMENTO_SOLICITANTE.includes('CANCELADA'), 'A) status terminais (FINALIZADA/CANCELADA) fora da lista', STATUS_EM_ANDAMENTO_SOLICITANTE)

    const url = new URL(`http://localhost:3000/minhas-solicitacoes?status=${FILTRO_EM_ANDAMENTO}`)
    const filtroDerivado = filtroPessoalValidoDaUrl(url.searchParams)
    assert(filtroDerivado === FILTRO_EM_ANDAMENTO, 'A) URL do card "Em andamento" deriva o preset correto', filtroDerivado)
    const params = montarParametrosBuscaPessoal({ filtro: filtroDerivado, page: 1, limit: 20 })
    assert(params.get('filtro') === 'em_andamento', 'A) preset "Em andamento" vira filtro=em_andamento no query real de GET /api/solicitacoes', params.get('filtro'))
    assert(!params.has('status'), 'A) preset "Em andamento" nunca também envia um `status` (mutuamente exclusivos)', params.toString())
    assert(params.get('escopo') === 'minhas', 'A) escopo continua "minhas" (nunca "todas")', params.get('escopo'))
  }

  // ===========================================================================
  // Parte B — "Assinaturas pendentes": AGUARDANDO_ASSINATURA do solicitante
  // ===========================================================================

  {
    const url = new URL('http://localhost:3000/minhas-solicitacoes?status=AGUARDANDO_ASSINATURA')
    const filtroDerivado = filtroPessoalValidoDaUrl(url.searchParams)
    assert(filtroDerivado === 'AGUARDANDO_ASSINATURA', 'B) URL do card "Assinaturas pendentes" deriva o status correto', filtroDerivado)
    const params = montarParametrosBuscaPessoal({ filtro: filtroDerivado, page: 1, limit: 20 })
    assert(params.get('status') === 'AGUARDANDO_ASSINATURA', 'B) filtro chega intacto ao query real (nunca AGUARDANDO_ENVIO_ASSINATURA)', params.get('status'))
    assert(!params.has('filtro'), 'B) status exato nunca também envia o preset `filtro`', params.toString())
  }

  // ===========================================================================
  // Parte C — "Prontas para retirada": PRONTA_RETIRADA
  // ===========================================================================

  {
    const url = new URL('http://localhost:3000/minhas-solicitacoes?status=PRONTA_RETIRADA')
    const filtroDerivado = filtroPessoalValidoDaUrl(url.searchParams)
    assert(filtroDerivado === 'PRONTA_RETIRADA', 'C) URL do card "Prontas para retirada" deriva o status correto', filtroDerivado)
    const params = montarParametrosBuscaPessoal({ filtro: filtroDerivado, page: 1, limit: 20 })
    assert(params.get('status') === 'PRONTA_RETIRADA', 'C) filtro chega intacto ao query real', params.get('status'))
  }

  // ===========================================================================
  // Parte D/F — /minhas-solicitacoes: useSearchParams reativo (F5/troca de filtro)
  // ===========================================================================

  assert(/useSearchParams/.test(minhasSolicitacoes), 'D) minhas-solicitacoes/page.tsx usa useSearchParams() (reativo) como fonte do filtro — sobrevive a F5', true)
  assert(!/new URLSearchParams\(window\.location\.search\)/.test(minhasSolicitacoes), 'D) NUNCA lê window.location.search diretamente (mesma causa raiz já corrigida em todas-solicitacoes)', true)
  assert(/router\.replace/.test(minhasSolicitacoes), 'F) troca de filtro na interface sincroniza a URL (router.replace)', true)
  assert(/<Suspense/.test(minhasSolicitacoes), 'D) useSearchParams() está dentro de um limite de Suspense', true)

  // ===========================================================================
  // Parte E — limpar o filtro remove o parâmetro por completo
  // ===========================================================================

  {
    const paramsLimpos = montarParametrosBuscaPessoal({ filtro: '', page: 1, limit: 20 })
    assert(!paramsLimpos.has('status') && !paramsLimpos.has('filtro'), 'E) limpar o filtro remove status/filtro por completo do query (nunca "status=")', paramsLimpos.toString())
    assert(/atualizarFiltro\(''\)/.test(minhasSolicitacoes), 'E) existe uma forma de limpar o filtro na interface (atualizarFiltro(\'\'))', true)
  }

  // ===========================================================================
  // Parte G/H — Dashboard (Admin/Colaborador/Gestor): mesmo arquivo, mesmos hrefs
  // ===========================================================================
  //
  // lobby/page.tsx é o MESMO arquivo-fonte para Administrador, Colaborador e
  // Gestor (só o perfil PATRIMONIO tem uma página dedicada — PainelPatrimonio.tsx,
  // fora do escopo desta auditoria) — uma única checagem cobre os três.

  {
    // "Em andamento" usa o sentinela FILTRO_EM_ANDAMENTO interpolado (template
    // string) — nunca o literal 'EM_ANDAMENTO' hardcoded duas vezes (aqui e
    // em minhas-solicitacoes/filtros.ts).
    assert(
      /label: 'Minhas solicitações em andamento'[\s\S]{0,250}?href: `\/minhas-solicitacoes\?status=\$\{FILTRO_EM_ANDAMENTO\}`/.test(lobby),
      'G/H) card "Minhas solicitações em andamento" abre /minhas-solicitacoes já filtrado pelo preset FILTRO_EM_ANDAMENTO (Admin/Colaborador/Gestor, mesmo arquivo)',
      true
    )
    assert(
      /import \{ FILTRO_EM_ANDAMENTO \} from '\.\.\/minhas-solicitacoes\/filtros'/.test(lobby),
      'G/H) lobby/page.tsx importa o MESMO sentinela de minhas-solicitacoes/filtros.ts (nunca hardcoda "EM_ANDAMENTO" separadamente)',
      true
    )
    assert(
      /label: 'Assinaturas pendentes'[\s\S]{0,250}?href: '\/minhas-solicitacoes\?status=AGUARDANDO_ASSINATURA'/.test(lobby),
      'G/H) card "Assinaturas pendentes" abre /minhas-solicitacoes?status=AGUARDANDO_ASSINATURA (Admin/Colaborador/Gestor, mesmo arquivo)',
      true
    )
    assert(
      /label: 'Prontas para retirada'[\s\S]{0,250}?href: '\/minhas-solicitacoes\?status=PRONTA_RETIRADA'/.test(lobby),
      'G/H) card "Prontas para retirada" abre /minhas-solicitacoes?status=PRONTA_RETIRADA (Admin/Colaborador/Gestor, mesmo arquivo)',
      true
    )
    // Nenhum dos 3 cards quantitativos aponta mais para a lista sem filtro.
    assert(!/label: 'Minhas solicitações em andamento'[\s\S]{0,150}?href: '\/minhas-solicitacoes'/.test(lobby), 'G/H) "Em andamento" não aponta mais para /minhas-solicitacoes sem filtro', true)
    assert(!/label: 'Assinaturas pendentes'[\s\S]{0,150}?href: '\/minhas-solicitacoes'/.test(lobby), 'G/H) "Assinaturas pendentes" não aponta mais para /minhas-solicitacoes sem filtro', true)
    assert(!/label: 'Prontas para retirada'[\s\S]{0,150}?href: '\/minhas-solicitacoes'/.test(lobby), 'G/H) "Prontas para retirada" não aponta mais para /minhas-solicitacoes sem filtro', true)
    // "Nova Solicitação" continua sem filtro/contador (item 8 do pedido).
    assert(/label: 'Nova Solicitação'[\s\S]{0,150}?href: '\/nova-solicitacao'/.test(lobby), 'G/H) "Nova Solicitação" continua um atalho simples, nunca um filtro', true)
  }

  // ===========================================================================
  // Parte I — Gestor: "Atividades externas" já abre /aprovacoes sem filtro extra
  // ===========================================================================

  assert(/label: 'Atividades externas'[\s\S]{0,200}?href: '\/aprovacoes'/.test(lobby), 'I) card "Atividades externas" continua abrindo /aprovacoes', true)
  assert(/escopo=gestor&status=AGUARDANDO_GESTOR/.test(aprovacoes), 'I) /aprovacoes já restringe, na própria rota, ao escopo do gestor autenticado — nenhum filtro adicional necessário', true)

  {
    authModule.getSession = async () => ({ id: 'user-gestor', nome: 'Gestor', email: 'gestor@example.com', permissao: 'colaborador', podeSerGestor: true, podeSolicitarParaOutro: false, versaoSessao: 0 })
    prisma.solicitacao = {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        assert(where.gestorId === 'user-gestor' && where.status === 'AGUARDANDO_GESTOR', 'I) GET /api/solicitacoes?escopo=gestor&status=AGUARDANDO_GESTOR restringe ao gestor autenticado de verdade', where)
        return []
      },
      count: async () => 0,
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rota = require('../src/app/api/solicitacoes/route')
    const req = { url: 'http://localhost:3000/api/solicitacoes?escopo=gestor&status=AGUARDANDO_GESTOR' } as unknown as Parameters<typeof rota.GET>[0]
    const res = await rota.GET(req)
    assert(res.status === 200, 'I) GET /api/solicitacoes (escopo=gestor) retorna 200', res.status)
  }

  // ===========================================================================
  // Parte J — prova real: GET /api/solicitacoes aplica o `where` esperado
  // ===========================================================================

  authModule.getSession = async () => ({ id: 'user-colab-j', nome: 'Colaborador', email: 'colab.j@example.com', permissao: 'colaborador', podeSerGestor: false, podeSolicitarParaOutro: false, versaoSessao: 0 })

  async function chamarSolicitacoesEExtrairWhere(query: string): Promise<Record<string, unknown>> {
    let whereCapturado: Record<string, unknown> = {}
    prisma.solicitacao = {
      findMany: async ({ where }: { where: Record<string, unknown> }) => { whereCapturado = where; return [] },
      count: async ({ where }: { where: Record<string, unknown> }) => { whereCapturado = where; return 0 },
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rota = require('../src/app/api/solicitacoes/route')
    const req = { url: `http://localhost:3000/api/solicitacoes${query}` } as unknown as Parameters<typeof rota.GET>[0]
    const res = await rota.GET(req)
    assert(res.status === 200, `J) GET /api/solicitacoes${query} retorna 200`, res.status)
    return whereCapturado
  }

  {
    const where = await chamarSolicitacoesEExtrairWhere('?escopo=minhas&status=AGUARDANDO_ASSINATURA')
    assert(where.solicitanteId === 'user-colab-j' && where.status === 'AGUARDANDO_ASSINATURA', 'J) "Assinaturas pendentes": where real filtra pelo solicitante + AGUARDANDO_ASSINATURA', where)
  }
  {
    const where = await chamarSolicitacoesEExtrairWhere('?escopo=minhas&status=PRONTA_RETIRADA')
    assert(where.solicitanteId === 'user-colab-j' && where.status === 'PRONTA_RETIRADA', 'J) "Prontas para retirada": where real filtra pelo solicitante + PRONTA_RETIRADA', where)
  }
  {
    const where = await chamarSolicitacoesEExtrairWhere('?escopo=minhas&filtro=em_andamento')
    const statusFiltro = where.status as { in?: string[] } | undefined
    assert(
      where.solicitanteId === 'user-colab-j' && Array.isArray(statusFiltro?.in) && statusFiltro!.in!.length === STATUS_EM_ANDAMENTO_SOLICITANTE.length && STATUS_EM_ANDAMENTO_SOLICITANTE.every((s: string) => statusFiltro!.in!.includes(s)),
      'J) "Em andamento": where real filtra pelo solicitante + status.in = STATUS_EM_ANDAMENTO_SOLICITANTE (exatamente 9 status)',
      where
    )
  }
  {
    // Conjunto fechado (filtroSolicitacaoEnum) — um preset fora dele é
    // rejeitado com 400, nunca ignorado silenciosamente (mesmo princípio já
    // aplicado a `status`/`escopo`/`tipoEmprestimo` nesta mesma rota).
    prisma.solicitacao = { findMany: async () => [], count: async () => 0 }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rota = require('../src/app/api/solicitacoes/route')
    const req = { url: 'http://localhost:3000/api/solicitacoes?escopo=minhas&filtro=lixo_invalido' } as unknown as Parameters<typeof rota.GET>[0]
    const res = await rota.GET(req)
    const body = await res.json()
    assert(res.status === 400, 'J) filtro fora do conjunto fechado (filtroSolicitacaoEnum) retorna 400', res.status)
    assert(body.message === 'Filtro inválido.', 'J) mensagem correta', body)
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
