// scripts/test-demo-dataset-reset.ts
//
// Teste da LÓGICA de resetarDatasetDemo() (src/lib/demo/dataset.ts) — chama
// a função REAL contra um mock relacional em memória (Maps por "tabela"),
// nunca uma reimplementação e nunca contra banco real. Complementa
// scripts/test-demo-reset-middleware.ts (que mocka resetarDatasetDemo()
// como no-op para isolar o gate de autenticação da rota) — aqui é o
// oposto: a rota/middleware não entram em cena, só a função de dados.
//
// Motivação: um teste de estado real (contagens/valores após a chamada),
// não baseado em texto/regex sobre o código-fonte — a forma mais adequada
// de verificar que o reset de fato limpa e recria o dataset esperado.
//
// Cobre:
//   - Dados MUTÁVEIS (solicitações e dependentes) são apagados por
//     inteiro e recriados no volume canônico (15 solicitações, 4
//     notificações) — uma solicitação/notificação "extra" (divergência
//     fictícia, mesmo padrão do teste manual feito contra o banco real)
//     desaparece.
//   - Dados MESTRES (usuários) são RESTAURADOS aos valores canônicos via
//     upsert (nome divergente volta ao original) — nunca apagados.
//   - `resetarDatasetDemo()` sempre apaga os dados mutáveis ANTES de
//     recriar (ordem observável: nenhuma solicitação nova é criada antes
//     do `deleteMany` de solicitações rodar).
//
// Executar com: npm run test:demo-dataset-reset

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
  const { resetarDatasetDemo } = require('../src/lib/demo/dataset')

  // --- "Banco" em memória — um Map por tabela ------------------------------
  const users = new Map<string, any>()
  const categorias = new Map<string, any>()
  const tiposServico = new Map<string, any>()
  const patrimonios = new Map<string, any>()
  const solicitacoes = new Map<string, any>()
  const notificacoes = new Map<string, any>()
  const historico = new Map<string, any>()
  const assinaturas = new Map<string, any>()
  const itensPatrimonio = new Map<string, any>()
  const itensPapelaria = new Map<string, any>()
  const itensServico = new Map<string, any>()
  const emailEventos = new Map<string, any>()

  let idSeq = 0
  const novoId = (prefixo: string) => `${prefixo}-${++idSeq}`

  const ordemChamadas: string[] = []

  // Pré-popula com o dataset canônico (7 usuários, 8 categorias, 6 tipos de
  // serviço, 18 patrimônios) — replicado aqui deliberadamente (não importado
  // de dataset.ts) para o teste não "trapacear" comparando a função contra
  // seus próprios dados internos.
  const USUARIOS_CANONICOS = [
    { email: 'admin@example.com', nome: 'Administrador Demo', permissao: 'administrador', podeSerGestor: true },
    { email: 'patrimonio@example.com', nome: 'Patrimônio Demo', permissao: 'patrimonio', podeSerGestor: false },
    { email: 'gestor@example.com', nome: 'Gestor Demo', permissao: 'colaborador', podeSerGestor: true },
    { email: 'ana@example.com', nome: 'Ana Martins', permissao: 'colaborador', podeSerGestor: false },
    { email: 'carlos@example.com', nome: 'Carlos Oliveira', permissao: 'colaborador', podeSerGestor: false },
    { email: 'mariana@example.com', nome: 'Mariana Souza', permissao: 'colaborador', podeSerGestor: false },
    { email: 'lucas@example.com', nome: 'Lucas Ferreira', permissao: 'colaborador', podeSerGestor: false },
  ]
  for (const def of USUARIOS_CANONICOS) {
    const id = novoId('user')
    users.set(id, { id, ...def, ativo: true, gestorPadraoId: null, versaoSessao: 0, senha: 'hash-existente-nunca-tocado' })
  }
  const CATEGORIAS_CANONICAS = ['Notebook', 'Projetor', 'Monitor', 'Tablet', 'Caixa de Som', 'Microfone', 'Adaptador', 'Extensão']
  for (const nome of CATEGORIAS_CANONICAS) {
    const id = novoId('cat')
    categorias.set(id, { id, nome, ordem: 0, icone: 'x', ativo: true })
  }
  const TIPOS_SERVICO_CANONICOS = ['Movimentação de cadeiras', 'Movimentação de mesas', 'Fundo infinito', 'Backdrop', 'Flipchart', 'Outros serviços/movimentações']
  for (const nome of TIPOS_SERVICO_CANONICOS) {
    const id = novoId('serv')
    tiposServico.set(id, { id, nome, ordem: 0, ativo: true })
  }
  const primeiraCategoriaId = [...categorias.values()][0].id
  for (let i = 1; i <= 18; i++) {
    const id = novoId('pat')
    const numero = `PAT-${String(i).padStart(4, '0')}`
    patrimonios.set(id, { id, numero, marca: 'X', modelo: 'Y', ativo: true, categoriaId: primeiraCategoriaId })
  }

  // --- DIVERGÊNCIAS a serem corrigidas pelo reset ---------------------------
  // 1) Nome de um usuário mestre alterado (deve voltar ao canônico).
  const anaId = [...users.values()].find((u) => u.email === 'ana@example.com')!.id
  users.get(anaId).nome = 'NOME ALTERADO INDEVIDAMENTE'

  // 2) Uma solicitação transacional extra (deve desaparecer).
  const solExtraId = novoId('sol')
  solicitacoes.set(solExtraId, { id: solExtraId, solicitanteId: anaId, status: 'AGUARDANDO_PATRIMONIO', ambiente: 'DIVERGENCIA DE TESTE' })

  // 3) Uma notificação extra (deve desaparecer).
  const notifExtraId = novoId('notif')
  notificacoes.set(notifExtraId, { id: notifExtraId, usuarioId: anaId, titulo: 'Notificação de teste' })

  // --- Mock do `tx` (Prisma.TransactionClient) ------------------------------
  function tx() {
    return {
      user: {
        findUnique: async ({ where }: any) => {
          const u = [...users.values()].find((x) => x.email === where.email || x.id === where.id)
          return u ? { ...u } : null
        },
        create: async ({ data }: any) => {
          const id = novoId('user')
          const registro = { id, ativo: true, gestorPadraoId: null, versaoSessao: 0, ...data }
          users.set(id, registro)
          return { ...registro }
        },
        update: async ({ where, data }: any) => {
          const u = users.get(where.id)
          if (!u) throw new Error('user não encontrado (mock)')
          Object.assign(u, data)
          return { ...u }
        },
      },
      categoriaPatrimonio: {
        upsert: async ({ where, update, create }: any) => {
          const existente = [...categorias.values()].find((c) => c.nome === where.nome)
          if (existente) {
            Object.assign(existente, update)
            return { ...existente }
          }
          const id = novoId('cat')
          const registro = { id, ...create }
          categorias.set(id, registro)
          return { ...registro }
        },
      },
      tipoServico: {
        upsert: async ({ where, update, create }: any) => {
          const existente = [...tiposServico.values()].find((t) => t.nome === where.nome)
          if (existente) {
            Object.assign(existente, update)
            return { ...existente }
          }
          const id = novoId('serv')
          const registro = { id, ...create }
          tiposServico.set(id, registro)
          return { ...registro }
        },
      },
      patrimonio: {
        upsert: async ({ where, update, create }: any) => {
          const existente = [...patrimonios.values()].find((p) => p.numero === where.numero)
          if (existente) {
            Object.assign(existente, update)
            return { ...existente }
          }
          const id = novoId('pat')
          const registro = { id, ...create }
          patrimonios.set(id, registro)
          return { ...registro }
        },
      },
      solicitacao: {
        deleteMany: async () => {
          ordemChamadas.push('solicitacao.deleteMany')
          solicitacoes.clear()
          return { count: 0 }
        },
        create: async ({ data }: any) => {
          ordemChamadas.push('solicitacao.create')
          const id = novoId('sol')
          solicitacoes.set(id, { id, ...data })
          return { id }
        },
      },
      notificacao: {
        deleteMany: async () => {
          notificacoes.clear()
          return { count: 0 }
        },
        createMany: async ({ data }: any) => {
          for (const item of data) {
            const id = novoId('notif')
            notificacoes.set(id, { id, ...item })
          }
          return { count: data.length }
        },
      },
      historicoSolicitacao: { deleteMany: async () => { historico.clear(); return { count: 0 } } },
      assinatura: { deleteMany: async () => { assinaturas.clear(); return { count: 0 } } },
      itemPatrimonioSolicitacao: { deleteMany: async () => { itensPatrimonio.clear(); return { count: 0 } } },
      itemPapelaria: { deleteMany: async () => { itensPapelaria.clear(); return { count: 0 } } },
      itemServicoSolicitacao: { deleteMany: async () => { itensServico.clear(); return { count: 0 } } },
      emailEvento: { deleteMany: async () => { emailEventos.clear(); return { count: 0 } } },
    }
  }

  // --- Executa a função REAL -------------------------------------------------
  await resetarDatasetDemo(tx())

  // --- Asserções ---------------------------------------------------------
  assert(users.size === 7, 'reset preserva exatamente 7 usuários (nenhum extra, nenhum removido)', users.size)
  assert(users.get(anaId)?.nome === 'Ana Martins', 'reset RESTAURA o nome divergente do usuário mestre ao valor canônico (upsert, nunca deleteMany)', users.get(anaId)?.nome)
  assert(categorias.size === 8, 'reset preserva exatamente 8 categorias', categorias.size)
  assert(tiposServico.size === 6, 'reset preserva exatamente 6 tipos de serviço', tiposServico.size)
  assert(patrimonios.size === 18, 'reset preserva exatamente 18 patrimônios', patrimonios.size)

  assert(!solicitacoes.has(solExtraId), 'a solicitação EXTRA (divergência fictícia) foi removida pelo reset', [...solicitacoes.keys()])
  assert(solicitacoes.size === 15, 'reset recria exatamente as 15 solicitações canônicas', solicitacoes.size)

  assert(!notificacoes.has(notifExtraId), 'a notificação EXTRA (divergência fictícia) foi removida pelo reset')
  assert(notificacoes.size === 4, 'reset recria exatamente as 4 notificações canônicas', notificacoes.size)

  const primeiroDeleteAntesDoPrimeiroCreate =
    ordemChamadas.indexOf('solicitacao.deleteMany') !== -1 &&
    ordemChamadas.indexOf('solicitacao.deleteMany') < ordemChamadas.indexOf('solicitacao.create')
  assert(primeiroDeleteAntesDoPrimeiroCreate, 'resetarDatasetDemo() sempre apaga solicitações ANTES de recriar (nunca cria em cima do dado antigo)', ordemChamadas.slice(0, 5))

  console.log(`\n${failures === 0 ? '✅ Todos os testes passaram.' : `❌ ${failures} teste(s) falharam.`}`)
  if (failures > 0) process.exit(1)
}

main()
