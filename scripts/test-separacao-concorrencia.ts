// scripts/test-separacao-concorrencia.ts
//
// Teste manual (mesmo padrão de scripts/test-email-config.ts) da correção
// de precisão do histórico em /api/solicitacoes/[id]/separacao (Etapa D.2
// — correção final pós-Codex-Review): o updateMany da transição precisa
// usar o status EXATO lido (não o conjunto de origens permitidas), para
// que o histórico nunca registre um `statusAnterior` que não foi
// realmente o status de origem da transição.
//
// Importa e chama o handler POST REAL da rota (não uma reimplementação) —
// só prisma, getSession/isPatrimonioOuAdmin e processarEmailEvento (já
// coberto por outros testes) são mocks em memória. Não abre conexão real
// com o banco nem envia e-mail real.
//
// Executar com: npm run test:separacao-concorrencia

// Força este arquivo a ser tratado como módulo ES pelo TypeScript (não um
// "script" de escopo global) — sem isso, suas declarações de topo (const
// prisma, let failures, interface SolicitacaoFake etc.) colidem com as de
// scripts irmãos (test-confirmar-patrimonio-concorrencia.ts,
// test-assinatura-confirmar-concorrencia.ts, Etapa D.3.0) quando `tsc`
// verifica todo o projeto de uma vez, já que nenhum deles tem outro
// `import`/`export` de topo (usam só `require()`, de propósito).
export {}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { prisma } = require('../src/lib/prisma')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const authModule = require('../src/lib/auth')
// Mutamos os módulos ORIGINAIS (não o barrel src/lib/email/index.ts): o
// barrel reexporta via `export { x } from './y'`, que o TypeScript
// compila para uma propriedade só-leitura (getter) — não dá para
// sobrescrever ali. O getter lê `y.x` a cada acesso, então sobrescrever a
// propriedade no módulo original propaga corretamente pela reexportação.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const processarEventoModule = require('../src/lib/email/processar-evento')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const validadeEventoModule = require('../src/lib/email/validade-evento')

let failures = 0

function assert(condition: boolean, label: string, detalhe?: unknown) {
  if (condition) {
    console.log(`OK   - ${label}`)
  } else {
    failures++
    console.error(`FALHA - ${label}${detalhe !== undefined ? ` (${JSON.stringify(detalhe)})` : ''}`)
  }
}

// --- Mocks -------------------------------------------------------------

const SOL_ID = 'sol-concorrencia-1'

interface SolicitacaoFake {
  id: string
  status: string
  numero: number
  solicitanteId: string
  separadoEm: Date | null
  separadoPorId: string | null
}

let solicitacao: SolicitacaoFake
let historicoCriado: Array<Record<string, unknown>>
let notificacaoCriada: Array<Record<string, unknown>>
let emailEventoCriado: Array<Record<string, unknown>>
let updateManyCalls: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>

function resetMocks(statusInicial: string) {
  solicitacao = { id: SOL_ID, status: statusInicial, numero: 7, solicitanteId: 'user-1', separadoEm: null, separadoPorId: null }
  historicoCriado = []
  notificacaoCriada = []
  emailEventoCriado = []
  updateManyCalls = []
}

function instalarMockPrisma() {
  prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)

  prisma.solicitacao = {
    findUnique: async ({ where }: { where: { id: string } }) => (where.id === solicitacao.id ? { status: solicitacao.status } : null),
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      updateManyCalls.push({ where, data })
      if (where.id !== solicitacao.id) return { count: 0 }
      if ('status' in where && where.status !== solicitacao.status) return { count: 0 }
      Object.assign(solicitacao, data)
      return { count: 1 }
    },
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
      if (where.id !== solicitacao.id) throw new Error('Solicitação não encontrada (mock).')
      return {
        ...solicitacao,
        solicitante: { nome: 'Fulano', email: 'fulano@example.com' },
        itensPatrimonio: [],
        itensPapelaria: [],
      }
    },
  }

  prisma.historicoSolicitacao = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      historicoCriado.push(data)
      return data
    },
  }

  prisma.notificacao = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      notificacaoCriada.push(data)
      return data
    },
  }

  prisma.emailEvento = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      emailEventoCriado.push(data)
      return { id: 'evento-fake', ...data }
    },
  }

  // Etapa security/session-revocation: getValidatedMutationSession() faz
  // prisma.user.findUnique() ANTES de prisma.$transaction ser aberto — como
  // o mock de $transaction acima roda a callback direto sobre `prisma`
  // (tx === prisma), este MESMO mock também atende a chamada.
  prisma.user = {
    findUnique: async ({ where }: { where: { id: string } }) =>
      where.id === 'user-patrimonio'
        ? { id: 'user-patrimonio', nome: 'Equipe Patrimônio', email: 'patrimonio@example.com', permissao: 'patrimonio', ativo: true, podeSerGestor: false, podeSolicitarParaOutro: false, versaoSessao: 0 }
        : null,
  }
}

function instalarMockAuth() {
  authModule.getSession = async () => ({ id: 'user-patrimonio', nome: 'Equipe Patrimônio', permissao: 'patrimonio', versaoSessao: 0 })
}

function instalarMockEmail() {
  // processarEmailEvento já é coberto exaustivamente por
  // scripts/test-email-*.ts — aqui só precisamos que ele não tente enviar
  // nada de verdade nem quebre por falta de mocks de sendEmail/Resend.
  processarEventoModule.processarEmailEvento = async () => 'ENVIADO'
  validadeEventoModule.criarValidadorDeEvento = () => null
}

async function main() {
  instalarMockPrisma()
  instalarMockAuth()
  instalarMockEmail()

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rota = require('../src/app/api/solicitacoes/[id]/separacao/route')

  // --- A) Status muda entre leitura e update → 409, nada é criado ----------
  resetMocks('CONFIRMADA')
  // Simula a corrida: outra transação avança para EM_SEPARACAO depois que
  // esta rota já leu 'CONFIRMADA' — como só temos UM mock de `solicitacao`
  // (sem timeline própria), simulamos isso fazendo o *próprio* updateMany
  // mock enxergar um status diferente do que a rota vai pedir no WHERE:
  // a rota lê CONFIRMADA (via findUnique) e então tenta
  // updateMany({ where: { status: 'CONFIRMADA' } }) — nós adiantamos o
  // relógio ANTES desse updateMany rodar, trocando o status "real" para
  // EM_SEPARACAO por fora, como uma transação concorrente faria.
  {
    const findUniqueOriginal = prisma.solicitacao.findUnique
    prisma.solicitacao.findUnique = async (args: { where: { id: string } }) => {
      const resultado = await findUniqueOriginal(args)
      // Muda o estado "real" logo após a rota ler CONFIRMADA — antes do
      // updateMany, que é a próxima coisa que a rota faz.
      solicitacao.status = 'EM_SEPARACAO'
      return resultado
    }

    const res = await rota.POST(undefined, { params: Promise.resolve({ id: SOL_ID }) })
    const body = await res.json()

    assert(res.status === 409, 'A) resposta é 409 quando o status mudou entre leitura e update', res.status)
    assert(
      updateManyCalls.length === 1 && updateManyCalls[0].where.status === 'CONFIRMADA',
      'A) o updateMany foi tentado com o status EXATO lido (CONFIRMADA), não um conjunto de origens',
      updateManyCalls
    )
    assert(historicoCriado.length === 0, 'A) nenhum histórico é criado', historicoCriado)
    assert(notificacaoCriada.length === 0, 'A) nenhuma notificação é criada', notificacaoCriada)
    assert(emailEventoCriado.length === 0, 'A) nenhum EmailEvento é criado', emailEventoCriado)
    assert(solicitacao.status === 'EM_SEPARACAO', 'A) o status não é revertido nem sobrescrito por esta rota', solicitacao.status)

    prisma.solicitacao.findUnique = findUniqueOriginal
  }

  // --- B) Status não muda → transição bem-sucedida, histórico preciso ------
  resetMocks('EM_SEPARACAO')
  {
    const res = await rota.POST(undefined, { params: Promise.resolve({ id: SOL_ID }) })
    const body = await res.json()

    assert(res.status === 200, 'B) resposta é 200 quando o status não mudou', res.status)
    assert(
      updateManyCalls.length === 1 && updateManyCalls[0].where.status === 'EM_SEPARACAO',
      'B) updateMany usa o status exato (EM_SEPARACAO)',
      updateManyCalls
    )
    assert(historicoCriado.length === 1, 'B) histórico é criado', historicoCriado)
    assert(
      historicoCriado[0]?.statusAnterior === 'EM_SEPARACAO' && historicoCriado[0]?.statusNovo === 'PRONTA_RETIRADA',
      'B) histórico registra EM_SEPARACAO → PRONTA_RETIRADA (preciso, não um status "adivinhado")',
      historicoCriado[0]
    )
    assert(notificacaoCriada.length === 1, 'B) notificação é criada', notificacaoCriada)
    assert(emailEventoCriado.length === 1, 'B) EmailEvento é criado', emailEventoCriado)
    assert(solicitacao.status === 'PRONTA_RETIRADA', 'B) status final é PRONTA_RETIRADA', solicitacao.status)
    assert(body.solicitacao?.status === 'PRONTA_RETIRADA', 'B) resposta HTTP reflete o novo status', body)
  }

  // --- C) Duas chamadas concorrentes → só uma efetiva a transição ----------
  resetMocks('CONFIRMADA')
  {
    const [res1, res2] = await Promise.all([
      rota.POST(undefined, { params: Promise.resolve({ id: SOL_ID }) }),
      rota.POST(undefined, { params: Promise.resolve({ id: SOL_ID }) }),
    ])
    const statuses = [res1.status, res2.status].sort()
    assert(JSON.stringify(statuses) === JSON.stringify([200, 409]), 'C) uma chamada retorna 200 e a outra 409', statuses)
    assert(historicoCriado.length === 1, 'C) só um registro de histórico é criado', historicoCriado)
    assert(notificacaoCriada.length === 1, 'C) só uma notificação é criada', notificacaoCriada)
    assert(emailEventoCriado.length === 1, 'C) só um EmailEvento é criado', emailEventoCriado)
    assert(solicitacao.status === 'PRONTA_RETIRADA', 'C) estado final é PRONTA_RETIRADA', solicitacao.status)
  }

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) de concorrência de /separacao falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes de concorrência de /separacao passaram. Nenhum e-mail real foi enviado, nenhum banco real foi acessado.')
}

main().catch((err) => {
  console.error('Falha inesperada ao executar os testes de concorrência de /separacao:', err instanceof Error ? err.message : err)
  process.exit(1)
})
