// scripts/test-assinatura-confirmar-concorrencia.ts
//
// Teste manual (mesmo padrão de scripts/test-separacao-concorrencia.ts) da
// correção de concorrência em /api/solicitacoes/[id]/assinatura/confirmar
// (Etapa D.3.0 — análise de robustez para RESERVA_CONFIRMADA): o updateMany
// da transição AGUARDANDO_ASSINATURA → ASSINATURA_CONFIRMADA precisa usar o
// status EXATO lido, e o registro de Assinatura só pode ser marcado como
// confirmado depois de garantido que ESTA requisição venceu a corrida —
// nunca um registro de assinatura confirmada "órfão" sem a transição de
// status correspondente.
//
// Importa e chama o handler POST REAL da rota (não uma reimplementação) —
// prisma, getSession/isPatrimonioOuAdmin e processarEmailEvento são mocks
// em memória. Desde a Etapa D.3.5, esta rota (gatilho do fluxo EXTERNO)
// cria EmailEvento RESERVA_CONFIRMADA e chama processarEmailEvento() —
// mockado aqui (mesmo padrão de scripts/test-confirmar-patrimonio-concorrencia.ts)
// porque o escopo deste arquivo é só a concorrência da transição de
// status; o comportamento completo do envio (papel por destinatário,
// dedup, falha de APP_URL/provedor, rollback) é coberto por
// scripts/test-assinatura-confirmar-reserva-confirmada.ts. Não abre
// conexão real com o banco nem envia e-mail real.
//
// Executar com: npm run test:assinatura-confirmar-concorrencia

// Força este arquivo a ser tratado como módulo ES pelo TypeScript — ver
// comentário equivalente em scripts/test-confirmar-patrimonio-concorrencia.ts.
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

const SOL_ID = 'sol-assinatura-confirmar-1'

interface SolicitacaoFake {
  id: string
  status: string
  numero: number
  solicitanteId: string
}

interface AssinaturaFake {
  solicitacaoId: string
  confirmadaPorId: string | null
  confirmadaEm: Date | null
}

let solicitacao: SolicitacaoFake
let assinatura: AssinaturaFake
let historicoCriado: Array<Record<string, unknown>>
let notificacaoCriada: Array<Record<string, unknown>>
let emailEventoCriado: Array<Record<string, unknown>>
let assinaturaUpdateCalls: number
let updateManyCalls: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>

function resetMocks(statusInicial: string) {
  solicitacao = { id: SOL_ID, status: statusInicial, numero: 99, solicitanteId: 'user-1' }
  assinatura = { solicitacaoId: SOL_ID, confirmadaPorId: null, confirmadaEm: null }
  historicoCriado = []
  notificacaoCriada = []
  emailEventoCriado = []
  assinaturaUpdateCalls = 0
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
        tipoEmprestimo: 'externo',
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

  prisma.assinatura = {
    update: async ({ where, data }: { where: { solicitacaoId: string }; data: Record<string, unknown> }) => {
      if (where.solicitacaoId !== assinatura.solicitacaoId) throw new Error('Assinatura não encontrada (mock).')
      assinaturaUpdateCalls++
      Object.assign(assinatura, data)
      return { ...assinatura }
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

  // select: { id: true } → notificações internas (código já existente);
  // select: { email: true } → buscarDestinatariosReservaConfirmada (D.3.5).
  // Sem equipe Patrimônio configurada aqui — fora de escopo deste arquivo
  // (ver test-assinatura-confirmar-reserva-confirmada.ts).
  // `findUnique` (Etapa security/session-revocation): getValidatedMutationSession()
  // consulta o usuário AUTENTICADO (fora da transação, antes de
  // prisma.$transaction abrir) — como o mock de $transaction roda a
  // callback direto sobre `prisma` (tx === prisma), este mesmo objeto
  // também atende essa chamada.
  prisma.user = {
    findMany: async ({ select }: { select?: { id?: boolean; email?: boolean } } = {}) =>
      select?.email ? [] : [{ id: 'user-patrimonio-1' }, { id: 'user-patrimonio-2' }],
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
  // e por test-assinatura-confirmar-reserva-confirmada.ts — aqui só
  // precisamos que ele não tente enviar nada de verdade nem quebre por
  // falta de mocks de sendEmail/Resend/APP_URL.
  processarEventoModule.processarEmailEvento = async () => 'ENVIADO'
}

async function main() {
  instalarMockPrisma()
  instalarMockAuth()
  instalarMockEmail()

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rota = require('../src/app/api/solicitacoes/[id]/assinatura/confirmar/route')

  // --- D) Duas chamadas simultâneas -----------------------------------------
  resetMocks('AGUARDANDO_ASSINATURA')
  {
    const [res1, res2] = await Promise.all([
      rota.POST(undefined, { params: Promise.resolve({ id: SOL_ID }) }),
      rota.POST(undefined, { params: Promise.resolve({ id: SOL_ID }) }),
    ])
    const statuses = [res1.status, res2.status].sort()
    assert(JSON.stringify(statuses) === JSON.stringify([200, 409]), 'D) uma chamada retorna 200 e a outra 409', statuses)
    assert(historicoCriado.length === 1, 'D) só um registro de histórico é criado', historicoCriado)
    // Duas notificações por execução vencedora (2 membros do Patrimônio no
    // mock) — nunca 4, o que indicaria duplicação pela tentativa perdedora.
    assert(notificacaoCriada.length === 2, 'D) só um conjunto de notificações Patrimônio é criado (sem duplicação)', notificacaoCriada)
    assert(emailEventoCriado.length === 1, 'D) só um EmailEvento RESERVA_CONFIRMADA é criado (sem duplicação pela corrida)', emailEventoCriado)
    assert(assinaturaUpdateCalls === 1, 'D) assinatura é marcada como confirmada só uma vez', assinaturaUpdateCalls)
    assert(solicitacao.status === 'ASSINATURA_CONFIRMADA', 'D) estado final é ASSINATURA_CONFIRMADA', solicitacao.status)
    assert(
      historicoCriado[0]?.statusAnterior === 'AGUARDANDO_ASSINATURA' && historicoCriado[0]?.statusNovo === 'ASSINATURA_CONFIRMADA',
      'D) histórico registra AGUARDANDO_ASSINATURA → ASSINATURA_CONFIRMADA',
      historicoCriado[0]
    )
  }

  // --- E) Status muda entre leitura e update → 409, nada é criado ----------
  resetMocks('AGUARDANDO_ASSINATURA')
  {
    const findUniqueOriginal = prisma.solicitacao.findUnique
    prisma.solicitacao.findUnique = async (args: { where: { id: string } }) => {
      const resultado = await findUniqueOriginal(args)
      // Simula uma transação concorrente que já cancelou a solicitação
      // entre esta rota ler AGUARDANDO_ASSINATURA e o updateMany rodar.
      solicitacao.status = 'CANCELADA'
      return resultado
    }

    const res = await rota.POST(undefined, { params: Promise.resolve({ id: SOL_ID }) })

    assert(res.status === 409, 'E) resposta é 409 quando o status mudou entre leitura e update', res.status)
    assert(
      updateManyCalls.length === 1 && updateManyCalls[0].where.status === 'AGUARDANDO_ASSINATURA',
      'E) o updateMany foi tentado com o status EXATO lido (AGUARDANDO_ASSINATURA)',
      updateManyCalls
    )
    assert(historicoCriado.length === 0, 'E) nenhum histórico é criado', historicoCriado)
    assert(notificacaoCriada.length === 0, 'E) nenhuma notificação Patrimônio é criada', notificacaoCriada)
    assert(emailEventoCriado.length === 0, 'E) nenhum EmailEvento é criado', emailEventoCriado)
    assert(assinaturaUpdateCalls === 0, 'E) assinatura não é marcada como confirmada (evita registro órfão)', assinaturaUpdateCalls)
    assert(solicitacao.status === 'CANCELADA', 'E) o status não é revertido nem sobrescrito por esta rota', solicitacao.status)

    prisma.solicitacao.findUnique = findUniqueOriginal
  }

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) de concorrência de /assinatura/confirmar falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes de concorrência de /assinatura/confirmar passaram. Nenhum e-mail real foi enviado, nenhum banco real foi acessado.')
}

main().catch((err) => {
  console.error('Falha inesperada ao executar os testes de concorrência de /assinatura/confirmar:', err instanceof Error ? err.message : err)
  process.exit(1)
})
