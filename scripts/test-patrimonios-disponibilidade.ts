// scripts/test-patrimonios-disponibilidade.ts
//
// Teste manual (mesmo padrão dos demais scripts/test-*.ts) da Etapa
// perf/system-optimization: GET /api/patrimonios/disponibilidade passou a
// buscar a lista de conflitos (quem já está ocupado/em uso) e o catálogo de
// bens ativos da categoria em PARALELO (Promise.all), em vez de
// sequencialmente — as duas consultas são independentes (tabelas e
// filtros diferentes; nenhuma usa o resultado da outra).
//
// Importa e chama o handler GET REAL da rota — prisma e getSession são
// mocks em memória, cada um registrando a ORDEM DE INÍCIO (não só de
// término) das duas consultas, para provar que ambas começam antes de
// qualquer uma terminar (só Promise.all garante isso; duas chamadas
// sequenciais `await a(); await b()` nunca teriam essa propriedade). Também
// cobre a equivalência funcional do resultado (mesmos bens filtrados) nos
// dois modos (normal e Atendimento Imediato).
//
// Não abre conexão real com o banco.
//
// Executar com: npm run test:patrimonios-disponibilidade

// Torna este arquivo um MÓDULO aos olhos do TypeScript — ver o mesmo
// comentário em scripts/test-dashboard.ts (evita colisão de escopo global
// entre scripts sem `import` quando `npx tsc --noEmit` compila o projeto
// inteiro de uma vez; irrelevante para `ts-node`, que roda um de cada vez).
export {}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { prisma } = require('../src/lib/prisma')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const authModule = require('../src/lib/auth')

let failures = 0

function assert(condition: boolean, label: string, detalhe?: unknown) {
  if (condition) {
    console.log(`OK   - ${label}`)
  } else {
    failures++
    console.error(`FALHA - ${label}${detalhe !== undefined ? ` (${JSON.stringify(detalhe)})` : ''}`)
  }
}

const SESSAO = { id: 'user-1', nome: 'Fulano', email: 'fulano@example.com', permissao: 'colaborador' as const }

let ordemInicio: string[]

function instalarMockPrisma() {
  ordemInicio = []
  authModule.getSession = async () => ({ ...SESSAO })

  prisma.solicitacao = {
    findMany: async () => {
      ordemInicio.push('solicitacao.findMany:inicio')
      // Atraso artificial — se a rota estivesse chamando isto e o
      // patrimonio.findMany SEQUENCIALMENTE, "patrimonio.findMany:inicio"
      // só apareceria em ordemInicio DEPOIS deste atraso terminar. Com
      // Promise.all, "patrimonio.findMany:inicio" aparece ANTES deste
      // return resolver, mesmo com o atraso.
      await new Promise((r) => setTimeout(r, 30))
      ordemInicio.push('solicitacao.findMany:fim')
      return [{ itensPatrimonio: [{ patrimonioId: 'pat-ocupado' }] }]
    },
  }

  prisma.patrimonio = {
    findMany: async () => {
      ordemInicio.push('patrimonio.findMany:inicio')
      return [
        { id: 'pat-ocupado', numero: 'PAT-1', categoria: { nome: 'Notebook' } },
        { id: 'pat-livre', numero: 'PAT-2', categoria: { nome: 'Notebook' } },
      ]
    },
  }
}

async function chamar(query: string) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rota = require('../src/app/api/patrimonios/disponibilidade/route')
  const req = { url: `http://localhost/api/patrimonios/disponibilidade?${query}` } as unknown as Parameters<typeof rota.GET>[0]
  const res = await rota.GET(req)
  return { res, body: await res.json() }
}

async function main() {
  // --- A) modo normal (data+período): as duas queries rodam em paralelo ---
  instalarMockPrisma()
  {
    const { res, body } = await chamar('categoriaId=cat-1&data=2026-09-01&periodo=MANHA')
    assert(res.status === 200, 'A) resposta 200', res.status)

    // A prova de paralelismo: patrimonio.findMany começa ANTES de
    // solicitacao.findMany terminar — impossível com `await a(); await b()`.
    const idxInicioConflitos = ordemInicio.indexOf('solicitacao.findMany:inicio')
    const idxFimConflitos = ordemInicio.indexOf('solicitacao.findMany:fim')
    const idxInicioPatrimonios = ordemInicio.indexOf('patrimonio.findMany:inicio')
    assert(idxInicioPatrimonios > -1 && idxInicioPatrimonios < idxFimConflitos, 'A) patrimonio.findMany começa ANTES de solicitacao.findMany terminar (Promise.all, não sequencial)', ordemInicio)
    assert(idxInicioConflitos < idxInicioPatrimonios, 'A) mesmo em paralelo, ambas as chamadas foram de fato disparadas nesta requisição', ordemInicio)

    // Equivalência funcional: o bem ocupado (conflito) é filtrado; o livre aparece.
    const numeros = (body.patrimonios as { numero: string }[]).map((p) => p.numero)
    assert(!numeros.includes('PAT-1'), 'A) bem com conflito (PAT-1) é excluído do resultado', numeros)
    assert(numeros.includes('PAT-2'), 'A) bem livre (PAT-2) aparece no resultado', numeros)
  }

  // --- B) modo Atendimento Imediato: mesma paralelização --------------------
  instalarMockPrisma()
  {
    const { res, body } = await chamar('categoriaId=cat-1&modo=imediato')
    assert(res.status === 200, 'B) resposta 200 no modo imediato', res.status)
    const idxFimConflitos = ordemInicio.indexOf('solicitacao.findMany:fim')
    const idxInicioPatrimonios = ordemInicio.indexOf('patrimonio.findMany:inicio')
    assert(idxInicioPatrimonios > -1 && idxInicioPatrimonios < idxFimConflitos, 'B) paralelização também vale no modo imediato', ordemInicio)
    const numeros = (body.patrimonios as { numero: string }[]).map((p) => p.numero)
    assert(!numeros.includes('PAT-1') && numeros.includes('PAT-2'), 'B) mesmo resultado funcional no modo imediato', numeros)
  }

  // --- C) categoria ausente → 400, nenhuma query é disparada -----------------
  instalarMockPrisma()
  {
    const { res } = await chamar('data=2026-09-01&periodo=MANHA')
    assert(res.status === 400, 'C) categoria ausente retorna 400', res.status)
    assert(ordemInicio.length === 0, 'C) nenhuma query é disparada quando falta a categoria', ordemInicio)
  }

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) de GET /api/patrimonios/disponibilidade falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes de GET /api/patrimonios/disponibilidade passaram. Nenhum banco real foi acessado.')
}

main().catch((err) => {
  console.error('Falha inesperada ao executar os testes de disponibilidade:', err instanceof Error ? err.message : err)
  process.exit(1)
})
