// scripts/test-confirmar-patrimonio-concorrencia.ts
//
// Teste manual (mesmo padrão de scripts/test-separacao-concorrencia.ts) da
// correção de concorrência em /api/solicitacoes/[id]/confirmar-patrimonio
// (Etapa D.3.0 — análise de robustez para RESERVA_CONFIRMADA): o updateMany
// da transição precisa usar o status EXATO lido (não um update incondicional
// depois de um findUnique separado), para que o histórico nunca registre um
// `statusAnterior` que não foi realmente o status de origem, e para que
// duas requisições concorrentes nunca ambas acreditem ter efetuado a
// transição.
//
// Importa e chama o handler POST REAL da rota (não uma reimplementação) —
// prisma, getSession/isPatrimonioOuAdmin e processarEmailEvento são mocks
// em memória. Desde a Etapa D.3.4, o fluxo INTERNO desta rota cria
// EmailEvento RESERVA_CONFIRMADA e chama processarEmailEvento() — mockado
// aqui (mesmo padrão de scripts/test-separacao-concorrencia.ts) porque o
// escopo deste arquivo é só a concorrência da transição de status; o
// comportamento completo do envio (papel por destinatário, dedup, falha de
// APP_URL/provedor, rollback) é coberto por
// scripts/test-confirmar-patrimonio-reserva-confirmada.ts. Não abre conexão
// real com o banco nem envia e-mail real.
//
// Executar com: npm run test:confirmar-patrimonio-concorrencia

// Força este arquivo a ser tratado como módulo ES pelo TypeScript (não um
// "script" de escopo global) — sem isso, suas declarações de topo (const
// prisma, let failures, interface SolicitacaoFake etc.) colidiriam com as
// de scripts irmãos (test-separacao-concorrencia.ts,
// test-assinatura-confirmar-concorrencia.ts) quando `tsc` verifica todo o
// projeto de uma vez, já que nenhum deles tem outro `import`/`export` de
// topo (usam só `require()`, de propósito — ver comentário mais abaixo).
export {}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { prisma } = require('../src/lib/prisma')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const authModule = require('../src/lib/auth')
// Mutamos o módulo ORIGINAL (não o barrel src/lib/email/index.ts) — ver
// scripts/test-separacao-concorrencia.ts para a explicação completa.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const processarEventoModule = require('../src/lib/email/processar-evento')

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

const SOL_ID = 'sol-confirmar-patrimonio-1'

interface SolicitacaoFake {
  id: string
  status: string
  numero: number
  solicitanteId: string
  tipoEmprestimo: 'interno' | 'externo'
  patrimonioDecisaoEm: Date | null
  patrimonioDecisorId: string | null
}

let solicitacao: SolicitacaoFake
let historicoCriado: Array<Record<string, unknown>>
let notificacaoCriada: Array<Record<string, unknown>>
let emailEventoCriado: Array<Record<string, unknown>>
let updateManyCalls: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>

function resetMocks(statusInicial: string, tipoEmprestimo: 'interno' | 'externo' = 'interno') {
  solicitacao = {
    id: SOL_ID,
    status: statusInicial,
    numero: 42,
    solicitanteId: 'user-1',
    tipoEmprestimo,
    patrimonioDecisaoEm: null,
    patrimonioDecisorId: null,
  }
  historicoCriado = []
  notificacaoCriada = []
  emailEventoCriado = []
  updateManyCalls = []
}

function instalarMockPrisma() {
  prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)

  prisma.solicitacao = {
    findUnique: async ({ where }: { where: { id: string } }) => (where.id === solicitacao.id ? { ...solicitacao } : null),
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
        data: new Date('2026-08-20T00:00:00.000Z'),
        periodos: ['TARDE'],
        ambiente: null,
        finalidade: null,
        atividadeExterna: null,
        local: null,
        cidade: null,
        observacoes: null,
        solicitante: { nome: 'Fulano', email: 'fulano@example.com' },
        itensPatrimonio: [],
        itensPapelaria: [],
        itensServico: [],
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

  // Fluxo interno (Etapa D.3.4): sem equipe Patrimônio configurada aqui —
  // fora de escopo deste arquivo (ver test-confirmar-patrimonio-reserva-confirmada.ts).
  // `findFirst` (Etapa email-patrimonio-caixa-grupo): buscarDestinatariosReservaConfirmada()
  // agora usa findFirst como gate de existência, não findMany.
  //
  // `findUnique` (Etapa security/session-revocation): getValidatedMutationSession()
  // consulta o usuário AUTENTICADO (fora da transação, antes de
  // prisma.$transaction abrir) — como o mock de $transaction roda a
  // callback direto sobre `prisma` (tx === prisma), este mesmo objeto
  // também atende essa chamada.
  prisma.user = {
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async ({ where }: { where: { id: string } }) =>
      where.id === 'user-patrimonio'
        ? { id: 'user-patrimonio', nome: 'Equipe Patrimônio', email: 'patrimonio@example.com', permissao: 'patrimonio', ativo: true, podeSerGestor: false, podeSolicitarParaOutro: false, versaoSessao: 0 }
        : null,
  }

  prisma.emailEvento = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      emailEventoCriado.push(data)
      return { id: `evento-fake-${emailEventoCriado.length}`, ...data }
    },
  }
}

function instalarMockAuth() {
  authModule.getSession = async () => ({ id: 'user-patrimonio', nome: 'Equipe Patrimônio', permissao: 'patrimonio', versaoSessao: 0 })
}

function instalarMockEmail() {
  // processarEmailEvento já é coberto exaustivamente por scripts/test-email-*.ts
  // e por test-confirmar-patrimonio-reserva-confirmada.ts — aqui só
  // precisamos que ele não tente enviar nada de verdade nem quebre por
  // falta de mocks de sendEmail/Resend/APP_URL.
  processarEventoModule.processarEmailEvento = async () => 'ENVIADO'
}

async function main() {
  instalarMockPrisma()
  instalarMockAuth()
  instalarMockEmail()

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rota = require('../src/app/api/solicitacoes/[id]/confirmar-patrimonio/route')

  // --- A) INTERNO: duas chamadas simultâneas --------------------------------
  resetMocks('AGUARDANDO_PATRIMONIO', 'interno')
  {
    const [res1, res2] = await Promise.all([
      rota.POST(undefined, { params: Promise.resolve({ id: SOL_ID }) }),
      rota.POST(undefined, { params: Promise.resolve({ id: SOL_ID }) }),
    ])
    const statuses = [res1.status, res2.status].sort()
    assert(JSON.stringify(statuses) === JSON.stringify([200, 409]), 'A) uma chamada retorna 200 e a outra 409', statuses)
    assert(historicoCriado.length === 1, 'A) só um registro de histórico é criado', historicoCriado)
    assert(notificacaoCriada.length === 1, 'A) só uma notificação é criada (sem duplicação)', notificacaoCriada)
    assert(emailEventoCriado.length === 1, 'A) só um EmailEvento RESERVA_CONFIRMADA é criado (sem duplicação pela corrida)', emailEventoCriado)
    assert(solicitacao.status === 'EM_SEPARACAO', 'A) estado final é EM_SEPARACAO (fluxo interno)', solicitacao.status)
    assert(
      historicoCriado[0]?.statusAnterior === 'AGUARDANDO_PATRIMONIO' && historicoCriado[0]?.statusNovo === 'EM_SEPARACAO',
      'A) histórico registra AGUARDANDO_PATRIMONIO → EM_SEPARACAO',
      historicoCriado[0]
    )
  }

  // --- B) EXTERNO: mesmo cenário --------------------------------------------
  resetMocks('AGUARDANDO_PATRIMONIO', 'externo')
  {
    const [res1, res2] = await Promise.all([
      rota.POST(undefined, { params: Promise.resolve({ id: SOL_ID }) }),
      rota.POST(undefined, { params: Promise.resolve({ id: SOL_ID }) }),
    ])
    const statuses = [res1.status, res2.status].sort()
    assert(JSON.stringify(statuses) === JSON.stringify([200, 409]), 'B) uma chamada retorna 200 e a outra 409', statuses)
    assert(historicoCriado.length === 1, 'B) só um registro de histórico é criado', historicoCriado)
    assert(notificacaoCriada.length === 1, 'B) só uma notificação é criada (sem duplicação)', notificacaoCriada)
    assert(emailEventoCriado.length === 0, 'B) fluxo externo não cria RESERVA_CONFIRMADA nesta rodada', emailEventoCriado)
    assert(
      solicitacao.status === 'AGUARDANDO_ENVIO_ASSINATURA',
      'B) estado final é AGUARDANDO_ENVIO_ASSINATURA (fluxo externo)',
      solicitacao.status
    )
    assert(
      historicoCriado[0]?.statusAnterior === 'AGUARDANDO_PATRIMONIO' &&
        historicoCriado[0]?.statusNovo === 'AGUARDANDO_ENVIO_ASSINATURA',
      'B) histórico registra AGUARDANDO_PATRIMONIO → AGUARDANDO_ENVIO_ASSINATURA',
      historicoCriado[0]
    )
  }

  // --- C) Status muda entre leitura e update → 409, nada é criado ----------
  resetMocks('AGUARDANDO_PATRIMONIO', 'interno')
  {
    const findUniqueOriginal = prisma.solicitacao.findUnique
    prisma.solicitacao.findUnique = async (args: { where: { id: string } }) => {
      const resultado = await findUniqueOriginal(args)
      // Simula uma transação concorrente que já cancelou a solicitação
      // entre esta rota ler AGUARDANDO_PATRIMONIO e o updateMany rodar.
      solicitacao.status = 'CANCELADA'
      return resultado
    }

    const res = await rota.POST(undefined, { params: Promise.resolve({ id: SOL_ID }) })

    assert(res.status === 409, 'C) resposta é 409 quando o status mudou entre leitura e update', res.status)
    assert(
      updateManyCalls.length === 1 && updateManyCalls[0].where.status === 'AGUARDANDO_PATRIMONIO',
      'C) o updateMany foi tentado com o status EXATO lido (AGUARDANDO_PATRIMONIO), não incondicional',
      updateManyCalls
    )
    assert(historicoCriado.length === 0, 'C) nenhum histórico é criado', historicoCriado)
    assert(notificacaoCriada.length === 0, 'C) nenhuma notificação é criada', notificacaoCriada)
    assert(emailEventoCriado.length === 0, 'C) nenhum EmailEvento é criado', emailEventoCriado)
    assert(solicitacao.status === 'CANCELADA', 'C) o status não é revertido nem sobrescrito por esta rota', solicitacao.status)

    prisma.solicitacao.findUnique = findUniqueOriginal
  }

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) de concorrência de /confirmar-patrimonio falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes de concorrência de /confirmar-patrimonio passaram. Nenhum e-mail real foi enviado, nenhum banco real foi acessado.')
}

main().catch((err) => {
  console.error('Falha inesperada ao executar os testes de concorrência de /confirmar-patrimonio:', err instanceof Error ? err.message : err)
  process.exit(1)
})
