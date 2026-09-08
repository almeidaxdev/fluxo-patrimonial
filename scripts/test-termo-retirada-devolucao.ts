// scripts/test-termo-retirada-devolucao.ts
//
// Testes da última funcionalidade V1: Termo de Retirada e Devolução
// (GET /api/solicitacoes/[id]/termo). Cobre autorização (reaproveita
// autorizarRelatorios — src/lib/relatorios-auth.ts), existência da
// solicitação, e o conteúdo do documento (via o componente React
// TermoRetiradaDevolucaoPdf, sem depender de parser de PDF binário — nenhuma
// dependência nova precisa ser adicionada ao projeto).
//
// Shim de módulo (obrigatório): src/lib/pdf/*.tsx fazem
// `require('react-pdf-react')`, um alias que só existe dentro do webpack do
// Next.js (next.config.js, aplicado somente no bundle server) — não existe
// pacote real com esse nome em node_modules. Fora do Next (aqui, via
// ts-node), interceptamos a resolução do Node para apontar
// 'react-pdf-react' -> 'react', reproduzindo o mesmo alias. Não altera
// nenhum arquivo do projeto; efeito local a este processo de teste.
//
// Executar com: npm run test:termo-retirada-devolucao
import Module from 'module'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ModuleAny = Module as any
const resolveOriginal = ModuleAny._resolveFilename
ModuleAny._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === 'react-pdf-react') request = 'react'
  return resolveOriginal.call(this, request, ...rest)
}

process.env.APP_URL = 'http://localhost:3000'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { prisma } = require('../src/lib/prisma')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const authModule = require('../src/lib/auth')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TermoRetiradaDevolucaoPdf } = require('../src/lib/pdf/termo-retirada-devolucao')

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

const PATRIMONIO = { id: 'user-patrimonio', nome: 'Setor Patrimônio', email: 'patrimonio@example.com', ativo: true, permissao: 'patrimonio' as const, podeSerGestor: false, podeSolicitarParaOutro: false, versaoSessao: 0 }
const COLABORADOR = { id: 'user-colaborador', nome: 'Colaborador Comum', email: 'colaborador@example.com', ativo: true, permissao: 'colaborador' as const, podeSerGestor: false, podeSolicitarParaOutro: false, versaoSessao: 0 }

function instalarMockGetSession(sessao: { id: string; nome: string; email: string; permissao: string } | null) {
  authModule.getSession = async () => (sessao ? { ...sessao, versaoSessao: 0 } : null)
}

function instalarMockPrismaUser() {
  prisma.user = {
    findUnique: async ({ where }: { where: { id: string } }) => {
      if (where.id === PATRIMONIO.id) return { ...PATRIMONIO }
      if (where.id === COLABORADOR.id) return { ...COLABORADOR }
      return null
    },
  }
}

// Base de uma solicitação interna, no shape exato de SELECT_TERMO. Nenhum
// método de mutação (update/updateMany/create/delete) é definido nos mocks
// abaixo — item H do pedido: se a rota tentasse alterar status, histórico ou
// qualquer dado, a chamada quebraria com "is not a function", provando
// estruturalmente que a geração do termo não escreve nada.
function solicitacaoInterna(overrides: Record<string, unknown> = {}) {
  return {
    numero: 58,
    tipoEmprestimo: 'interno',
    data: '2026-09-01',
    periodos: ['MANHA'],
    ambiente: 'Laboratório 3',
    finalidade: 'Aula prática',
    observacoes: null,
    atividadeExterna: null,
    local: null,
    cidade: null,
    solicitanteId: 'sol-1',
    criadoPorId: 'sol-1',
    solicitante: { nome: 'Fulano Solicitante' },
    criadoPor: { nome: 'Fulano Solicitante' },
    gestor: null,
    itensPatrimonio: [],
    itensPapelaria: [],
    itensServico: [],
    ...overrides,
  }
}

function solicitacaoExterna(overrides: Record<string, unknown> = {}) {
  return solicitacaoInterna({
    tipoEmprestimo: 'externo',
    ambiente: null,
    atividadeExterna: 'Feira de tecnologia',
    local: 'Centro de Convenções',
    cidade: 'São Paulo',
    gestor: { nome: 'Beltrano Gestor' },
    ...overrides,
  })
}

function instalarMockPrismaSolicitacao(resultado: unknown) {
  prisma.solicitacao = {
    findUnique: async () => resultado,
  }
}

// --- Extração de texto do componente (sem parser de PDF) --------------------
// Expande recursivamente apenas componentes-função PRÓPRIOS deste projeto
// (TermoRetiradaDevolucaoPdf e seus helpers internos Campo/LinhaAssinatura) —
// os primitivos do @react-pdf/renderer (Text, View, Page, Document) são
// STRINGS como `element.type` (confirmado: 'TEXT'/'VIEW'/'PAGE'/'DOCUMENT'),
// nunca funções, então nunca são "chamados" aqui — apenas atravessados via
// `props.children`, com segurança total.
//
// Dentro de um nó TEXT os filhos são concatenados SEM separador — é assim
// que interpolações JSX (`{a} — {b} unidades`) realmente renderizam lado a
// lado no PDF. Fora de um TEXT (View/Page/Document), cada filho vira um
// bloco à parte, separado por quebra de linha, só para impedir que dois
// blocos vizinhos colem acidentalmente numa substring parecida com o que um
// teste procura — nunca para representar quebra de página real.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderTexto(node: any, dentroDeText = false): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) {
    const partes = node.map((n) => renderTexto(n, dentroDeText))
    return dentroDeText ? partes.join('') : partes.join('\n')
  }
  if (typeof node === 'object' && 'type' in node) {
    let resolvido = node
    if (typeof resolvido.type === 'function') resolvido = resolvido.type(resolvido.props)
    const ehText = resolvido.type === 'TEXT'
    return renderTexto(resolvido?.props?.children, ehText)
  }
  return ''
}

function textoDoTermo(solicitacao: unknown): string {
  return renderTexto(TermoRetiradaDevolucaoPdf({ solicitacao }))
}

async function chamarRota(id: string) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rota = require('../src/app/api/solicitacoes/[id]/termo/route')
  const req = {} as unknown as Parameters<typeof rota.GET>[0]
  return rota.GET(req, { params: Promise.resolve({ id }) })
}

async function main() {
  instalarMockPrismaUser()

  // --- A) Patrimônio gera termo de solicitação interna: sucesso ------------
  instalarMockGetSession(PATRIMONIO)
  instalarMockPrismaSolicitacao(solicitacaoInterna())
  {
    const res = await chamarRota('sol-1')
    assert(res.status === 200, 'A) resposta 200 para Patrimônio em solicitação interna', res.status)
    assert(res.headers.get('content-type') === 'application/pdf', 'A) content-type application/pdf', res.headers.get('content-type'))
    assert((res.headers.get('content-disposition') || '').includes('termo-solicitacao-58.pdf'), 'A) nome de arquivo previsível no Content-Disposition', res.headers.get('content-disposition'))
    assert((res.headers.get('content-disposition') || '').startsWith('inline'), 'A) Content-Disposition inline (abrir no visualizador, não forçar download)', res.headers.get('content-disposition'))
    const buffer = Buffer.from(await res.arrayBuffer())
    assert(buffer.subarray(0, 5).toString('latin1') === '%PDF-', 'A) corpo da resposta é um PDF válido (assinatura %PDF-)', buffer.subarray(0, 8).toString('latin1'))
  }

  // --- B) Patrimônio gera termo de solicitação externa: sucesso + campos externos ---
  {
    const texto = textoDoTermo(solicitacaoExterna())
    assert(texto.includes('Feira de tecnologia'), 'B) Atividade externa aparece no termo')
    assert(texto.includes('Centro de Convenções'), 'B) Local aparece no termo')
    assert(texto.includes('São Paulo'), 'B) Cidade aparece no termo')
    assert(texto.includes('Beltrano Gestor'), 'B) Gestor responsável aparece no termo')
    assert(texto.includes('Externo'), 'B) Tipo de empréstimo exibido como "Externo"')
  }
  {
    // Confirma que os mesmos campos externos NÃO aparecem para uma solicitação interna.
    const texto = textoDoTermo(solicitacaoInterna())
    assert(!texto.includes('Feira de tecnologia'), 'B) campos externos ausentes numa solicitação interna')
    assert(texto.includes('Interno'), 'B) Tipo de empréstimo exibido como "Interno"')
  }

  // --- C) Solicitação em nome de outro colaborador: Solicitante e Criado por corretos ---
  {
    const texto = textoDoTermo(solicitacaoInterna({
      solicitanteId: 'sol-1',
      criadoPorId: 'criador-1',
      solicitante: { nome: 'Bruno Beneficiário' },
      criadoPor: { nome: 'Carla Criadora' },
    }))
    assert(texto.includes('Bruno Beneficiário'), 'C) Solicitante (beneficiário) aparece no termo')
    assert(texto.includes('Carla Criadora'), 'C) Criado por (criador) aparece quando diferente do solicitante')
  }
  {
    // criadoPorId === solicitanteId: "Criado por" não deve ser um campo à parte.
    const texto = textoDoTermo(solicitacaoInterna({
      solicitanteId: 'sol-1',
      criadoPorId: 'sol-1',
      solicitante: { nome: 'Só Uma Pessoa' },
      criadoPor: { nome: 'Só Uma Pessoa' },
    }))
    const ocorrencias = texto.split('Só Uma Pessoa').length - 1
    assert(ocorrencias === 1, 'C) quando Solicitante === Criado por, o nome aparece uma única vez (sem campo "Criado por" duplicado)', ocorrencias)
  }

  // --- D) Vários bens da mesma categoria: resumo agregado E números reais ---
  {
    const itensPatrimonio = [
      { patrimonio: { numero: '630001', categoria: { nome: 'Notebook' } } },
      { patrimonio: { numero: '614055', categoria: { nome: 'Notebook' } } },
      { patrimonio: { numero: '622974', categoria: { nome: 'Notebook' } } },
      { patrimonio: { numero: '700123', categoria: { nome: 'Projetor' } } },
    ]
    const texto = textoDoTermo(solicitacaoInterna({ itensPatrimonio }))
    assert(texto.includes('Notebook — 3 unidades'), 'D) três notebooks agregados numa única linha', texto)
    assert(texto.includes('Projetor — 1 unidade'), 'D) um projetor em unidade singular', texto)
    assert(texto.includes('Patrimônios: 614055 · 622974 · 630001'), 'D) números de patrimônio dos notebooks aparecem ordenados, plural "Patrimônios"', texto)
    assert(texto.includes('Patrimônio: 700123'), 'D) número de patrimônio do projetor aparece no singular "Patrimônio"', texto)
  }

  // --- E) Papelaria e serviço aparecem corretamente -------------------------
  {
    const texto = textoDoTermo(solicitacaoInterna({
      itensPapelaria: [{ descricao: 'Cartolina branca', quantidade: 5 }],
      itensServico: [{ tipoServico: { nome: 'Movimentação de cadeiras' }, quantidade: 10, ambiente: 'Sala 2', observacao: null }],
    }))
    assert(texto.includes('5x Cartolina branca'), 'E) item de papelaria aparece com quantidade')
    assert(texto.includes('Movimentação de cadeiras'), 'E) serviço aparece pelo nome')
    assert(texto.includes('10') && texto.includes('Sala 2'), 'E) quantidade e ambiente do serviço aparecem')
  }
  {
    const texto = textoDoTermo(solicitacaoInterna())
    assert(texto.includes('Nenhum bem patrimonial nesta solicitação'), 'E) mensagem de ausência quando não há bens')
  }

  // --- F) Usuário sem permissão tenta acessar diretamente a rota: 403 -------
  instalarMockGetSession(COLABORADOR)
  instalarMockPrismaSolicitacao(solicitacaoInterna())
  {
    const res = await chamarRota('sol-1')
    assert(res.status === 403, 'F) colaborador comum recebe 403 ao tentar gerar o termo', res.status)
  }
  {
    instalarMockGetSession(null)
    const res = await chamarRota('sol-1')
    assert(res.status === 401, 'F) sem sessão recebe 401', res.status)
  }

  // --- G) Solicitação inexistente: 404 --------------------------------------
  instalarMockGetSession(PATRIMONIO)
  instalarMockPrismaSolicitacao(null)
  {
    const res = await chamarRota('sol-inexistente')
    assert(res.status === 404, 'G) solicitação inexistente recebe 404', res.status)
  }

  // --- H) Geração do termo não altera status/histórico/dado algum ----------
  // `prisma.solicitacao` acima só define `findUnique` (nenhum update/create);
  // `prisma.historicoSolicitacao` e `prisma.notificacao` sequer são
  // definidos nestes mocks. A rota completou os cenários A-G sem lançar erro
  // algum tentando usar qualquer um desses métodos — se a rota tentasse
  // escrever, o teste já teria falhado (TypeError) muito antes deste ponto.
  // Espiona todo método de escrita plausível e repete a chamada de sucesso
  // (mesmo cenário de A) — se a rota escrevesse QUALQUER coisa, um dos
  // contadores abaixo deixaria de ser zero.
  let chamadasDeEscrita = 0
  const espiao = () => { chamadasDeEscrita++; return Promise.resolve({}) }
  instalarMockGetSession(PATRIMONIO)
  instalarMockPrismaSolicitacao(solicitacaoInterna())
  prisma.solicitacao.update = espiao
  prisma.solicitacao.updateMany = espiao
  prisma.solicitacao.delete = espiao
  prisma.historicoSolicitacao = { create: espiao }
  prisma.notificacao = { create: espiao }
  prisma.emailEvento = { create: espiao }
  prisma.$transaction = espiao
  {
    const res = await chamarRota('sol-1')
    assert(res.status === 200, 'H) chamada de controle ainda responde 200 com os espiões instalados', res.status)
    assert(chamadasDeEscrita === 0, 'H) nenhum método de escrita do Prisma foi chamado ao gerar o termo', chamadasDeEscrita)
  }

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) do Termo de Retirada e Devolução falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes do Termo de Retirada e Devolução passaram. Nenhum banco real foi acessado.')
}

main().catch((err) => {
  console.error('Falha inesperada ao executar os testes do Termo de Retirada e Devolução:', err instanceof Error ? err.message : err)
  process.exit(1)
})
