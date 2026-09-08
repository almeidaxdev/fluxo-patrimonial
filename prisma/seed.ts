// prisma/seed.ts
// Seed DEMONSTRATIVO do Fluxo Patrimonial — dados 100% fictícios, pensados
// para popular o Dashboard, o Painel do Patrimônio, Minhas Reservas, Todas
// as Reservas e Aprovações com um cenário realista de portfólio.
// Idempotente: usuários/categorias/serviços/patrimônios usam upsert; as
// solicitações de demonstração só são criadas se ainda não existir nenhuma
// (não há um identificador de negócio natural para fazer upsert nelas).

import { PrismaClient, Permissao, TipoEmprestimo, PeriodoSolicitacao, StatusSolicitacao, OrigemSolicitacao, CondicaoDevolucao } from '@prisma/client'
import { randomInt } from 'crypto'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

// Prefixo fixo (não é segredo — só um identificador visual de "senha gerada
// pelo sistema"), mesmo padrão do reset administrativo de senha (ver
// src/app/api/colaboradores/[id]/route.ts). Alfabeto do sufixo evita
// caracteres ambíguos (sem I/O/0/1).
const PREFIXO_SENHA_SEED = 'Flx@9'
const ALFABETO_SENHA_SEED = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const TAMANHO_SUFIXO_SENHA_SEED = 8

function gerarSenhaTemporaria(): string {
  let sufixo = ''
  for (let i = 0; i < TAMANHO_SUFIXO_SENHA_SEED; i++) {
    sufixo += ALFABETO_SENHA_SEED[randomInt(ALFABETO_SENHA_SEED.length)]
  }
  return `${PREFIXO_SENHA_SEED}${sufixo}`
}

interface DadosCriacaoUsuario {
  nome: string
  permissao: Permissao
  podeSerGestor?: boolean
  gestorPadraoId?: string
}

// Cria o usuário só se o e-mail ainda não existir — nunca sugere uma senha
// nova para um usuário já existente, cuja senha real permanece inalterada.
async function criarUsuarioSeNaoExistir(
  email: string,
  dadosCriacao: DadosCriacaoUsuario,
  senhasGeradas: Record<string, string>
) {
  const existente = await prisma.user.findUnique({ where: { email } })
  if (existente) return existente

  const senha = gerarSenhaTemporaria()
  const usuario = await prisma.user.create({
    data: { ...dadosCriacao, email, senha: await bcrypt.hash(senha, 12) },
  })
  senhasGeradas[email] = senha
  return usuario
}

async function main() {
  console.log('🌱 Iniciando seed demonstrativo do Fluxo Patrimonial...')

  // ---------------------------------------------------------------------
  // Usuários demonstrativos — todos fictícios, e-mails só em @example.com.
  // ---------------------------------------------------------------------
  const senhasGeradas: Record<string, string> = {}

  const admin = await criarUsuarioSeNaoExistir(
    'admin@example.com',
    { nome: 'Administrador Demo', permissao: 'administrador', podeSerGestor: true },
    senhasGeradas
  )

  const patrimonio = await criarUsuarioSeNaoExistir(
    'patrimonio@example.com',
    { nome: 'Patrimônio Demo', permissao: 'patrimonio' },
    senhasGeradas
  )

  const gestor = await criarUsuarioSeNaoExistir(
    'gestor@example.com',
    { nome: 'Gestor Demo', permissao: 'colaborador', podeSerGestor: true },
    senhasGeradas
  )

  const ana = await criarUsuarioSeNaoExistir(
    'ana@example.com',
    { nome: 'Ana Martins', permissao: 'colaborador', gestorPadraoId: gestor.id },
    senhasGeradas
  )
  const carlos = await criarUsuarioSeNaoExistir(
    'carlos@example.com',
    { nome: 'Carlos Oliveira', permissao: 'colaborador', gestorPadraoId: gestor.id },
    senhasGeradas
  )
  const mariana = await criarUsuarioSeNaoExistir(
    'mariana@example.com',
    { nome: 'Mariana Souza', permissao: 'colaborador', gestorPadraoId: gestor.id },
    senhasGeradas
  )
  const lucas = await criarUsuarioSeNaoExistir(
    'lucas@example.com',
    { nome: 'Lucas Ferreira', permissao: 'colaborador', gestorPadraoId: gestor.id },
    senhasGeradas
  )

  console.log('✅ Usuários (existentes ou criados):', {
    admin: admin.email,
    patrimonio: patrimonio.email,
    gestor: gestor.email,
    colaboradores: [ana.email, carlos.email, mariana.email, lucas.email],
  })

  // ---------------------------------------------------------------------
  // Categorias de patrimônio
  // ---------------------------------------------------------------------
  const categorias = [
    { nome: 'Notebook', ordem: 0, icone: 'laptop' },
    { nome: 'Projetor', ordem: 1, icone: 'projector' },
    { nome: 'Monitor', ordem: 2, icone: 'monitor' },
    { nome: 'Tablet', ordem: 3, icone: 'tablet' },
    { nome: 'Caixa de Som', ordem: 4, icone: 'speaker' },
    { nome: 'Microfone', ordem: 5, icone: 'mic' },
    { nome: 'Adaptador', ordem: 6, icone: 'cable' },
    { nome: 'Extensão', ordem: 7, icone: 'plug' },
  ]

  const categoriasCriadas: Record<string, string> = {}
  for (const cat of categorias) {
    const c = await prisma.categoriaPatrimonio.upsert({
      where: { nome: cat.nome },
      update: {},
      create: { ...cat, ativo: true },
    })
    categoriasCriadas[cat.nome] = c.id
  }
  console.log('✅ Categorias:', categorias.map((c) => c.nome).join(', '))

  // ---------------------------------------------------------------------
  // Catálogo de serviços/movimentações
  // ---------------------------------------------------------------------
  const tiposServico = [
    { nome: 'Movimentação de cadeiras', ordem: 0 },
    { nome: 'Movimentação de mesas', ordem: 1 },
    { nome: 'Fundo infinito', ordem: 2 },
    { nome: 'Backdrop', ordem: 3 },
    { nome: 'Flipchart', ordem: 4 },
    { nome: 'Outros serviços/movimentações', ordem: 5 },
  ]
  const tiposServicoCriados: Record<string, string> = {}
  for (const servico of tiposServico) {
    const t = await prisma.tipoServico.upsert({
      where: { nome: servico.nome },
      update: {},
      create: { ...servico, ativo: true },
    })
    tiposServicoCriados[servico.nome] = t.id
  }
  console.log('✅ Tipos de serviço:', tiposServico.map((s) => s.nome).join(', '))

  // ---------------------------------------------------------------------
  // Patrimônios demonstrativos — números fictícios PAT-0001..PAT-0018,
  // nunca reaproveitando numeração de nenhum ambiente real.
  // ---------------------------------------------------------------------
  const patrimoniosBase = [
    { numero: 'PAT-0001', marca: 'Dell', modelo: 'Latitude 5420', categoria: 'Notebook' },
    { numero: 'PAT-0002', marca: 'Dell', modelo: 'Latitude 5420', categoria: 'Notebook' },
    { numero: 'PAT-0003', marca: 'Lenovo', modelo: 'ThinkPad E14', categoria: 'Notebook' },
    { numero: 'PAT-0004', marca: 'HP', modelo: 'ProBook 440 G9', categoria: 'Notebook' },
    { numero: 'PAT-0005', marca: 'Dell', modelo: 'Inspiron 15', categoria: 'Notebook' },
    { numero: 'PAT-0006', marca: 'Apple', modelo: 'MacBook Air M2', categoria: 'Notebook' },
    { numero: 'PAT-0007', marca: 'Epson', modelo: 'PowerLite X41', categoria: 'Projetor' },
    { numero: 'PAT-0008', marca: 'Epson', modelo: 'PowerLite S41', categoria: 'Projetor' },
    { numero: 'PAT-0009', marca: 'LG', modelo: 'Monitor 24"', categoria: 'Monitor' },
    { numero: 'PAT-0010', marca: 'Dell', modelo: 'Monitor 24"', categoria: 'Monitor' },
    { numero: 'PAT-0011', marca: 'Samsung', modelo: 'Monitor 27"', categoria: 'Monitor' },
    { numero: 'PAT-0012', marca: 'Samsung', modelo: 'Galaxy Tab A8', categoria: 'Tablet' },
    { numero: 'PAT-0013', marca: 'Samsung', modelo: 'Galaxy Tab A8', categoria: 'Tablet' },
    { numero: 'PAT-0014', marca: 'JBL', modelo: 'PartyBox 110', categoria: 'Caixa de Som' },
    { numero: 'PAT-0015', marca: 'JBL', modelo: 'Go 3', categoria: 'Caixa de Som' },
    { numero: 'PAT-0016', marca: 'Shure', modelo: 'SM58', categoria: 'Microfone' },
    { numero: 'PAT-0017', marca: 'Multilaser', modelo: 'Adaptador HDMI', categoria: 'Adaptador' },
    { numero: 'PAT-0018', marca: 'Genérico', modelo: 'Extensão elétrica 5m', categoria: 'Extensão' },
  ]

  const patrimoniosCriados: Record<string, string> = {}
  for (const p of patrimoniosBase) {
    const criado = await prisma.patrimonio.upsert({
      where: { numero: p.numero },
      update: {},
      create: { numero: p.numero, marca: p.marca, modelo: p.modelo, ativo: true, categoriaId: categoriasCriadas[p.categoria] },
    })
    patrimoniosCriados[p.numero] = criado.id
  }
  console.log('✅ Patrimônios:', patrimoniosBase.length)

  // ---------------------------------------------------------------------
  // Solicitações demonstrativas — só criadas se o banco ainda não tiver
  // NENHUMA solicitação (sem identificador de negócio natural para upsert).
  // Cobrem os principais estados do fluxo, para o Dashboard, o Painel do
  // Patrimônio, Aprovações, Minhas Reservas e Todas as Reservas não
  // aparecerem vazios numa demonstração.
  // ---------------------------------------------------------------------
  const jaTemSolicitacoes = (await prisma.solicitacao.count()) > 0
  if (jaTemSolicitacoes) {
    console.log('ℹ️  Já existem solicitações no banco — nenhuma solicitação demonstrativa foi criada.')
  } else {
    const hoje = new Date()
    function daqui(dias: number): Date {
      const d = new Date(hoje)
      d.setDate(d.getDate() + dias)
      d.setHours(0, 0, 0, 0)
      return d
    }
    function horasAtras(horas: number): Date {
      const d = new Date(hoje)
      d.setHours(d.getHours() - horas)
      return d
    }

    interface SolicitacaoDemo {
      solicitanteId: string
      status: StatusSolicitacao
      tipoEmprestimo: TipoEmprestimo
      origem?: OrigemSolicitacao
      data: Date
      periodos: PeriodoSolicitacao[]
      ambiente?: string
      finalidade?: string
      atividadeExterna?: string
      local?: string
      cidade?: string
      gestorId?: string
      observacoes?: string
      patrimonioIds: string[]
      gestorDecisaoEm?: Date
      motivoRejeicaoGestor?: string
      patrimonioDecisaoEm?: Date
      patrimonioDecisorId?: string
      motivoRejeicaoPatrimonio?: string
      separadoEm?: Date
      separadoPorId?: string
      retiradaEm?: Date
      retiradaPorId?: string
      devolucaoEm?: Date
      devolucaoPorId?: string
      devolucaoCondicao?: CondicaoDevolucao
      naoRetiradaEm?: Date
      naoRetiradaPorId?: string
    }

    const demo: SolicitacaoDemo[] = [
      // 1) Interna, recém-criada, aguardando o Patrimônio confirmar.
      {
        solicitanteId: ana.id,
        status: 'AGUARDANDO_PATRIMONIO',
        tipoEmprestimo: 'interno',
        data: daqui(2),
        periodos: ['MANHA'],
        ambiente: 'Sala 12',
        finalidade: 'Apresentação para a equipe de projetos',
        patrimonioIds: [patrimoniosCriados['PAT-0001']],
      },
      // 2) Externa, aguardando aprovação do gestor (popula Aprovações).
      {
        solicitanteId: carlos.id,
        status: 'AGUARDANDO_GESTOR',
        tipoEmprestimo: 'externo',
        data: daqui(5),
        periodos: ['TARDE'],
        atividadeExterna: 'Feira de tecnologia',
        local: 'Centro de Convenções',
        cidade: 'São Paulo',
        gestorId: gestor.id,
        patrimonioIds: [patrimoniosCriados['PAT-0003'], patrimoniosCriados['PAT-0007']],
      },
      // 3) Externa, já aprovada pelo gestor, aguardando o Patrimônio.
      {
        solicitanteId: mariana.id,
        status: 'AGUARDANDO_PATRIMONIO',
        tipoEmprestimo: 'externo',
        data: daqui(6),
        periodos: ['MANHA', 'TARDE'],
        atividadeExterna: 'Workshop externo de capacitação',
        local: 'Auditório Municipal',
        cidade: 'Campinas',
        gestorId: gestor.id,
        gestorDecisaoEm: horasAtras(20),
        patrimonioIds: [patrimoniosCriados['PAT-0004']],
      },
      // 4) Interna, confirmada pelo Patrimônio (ainda não separada).
      {
        solicitanteId: lucas.id,
        status: 'CONFIRMADA',
        tipoEmprestimo: 'interno',
        data: daqui(1),
        periodos: ['MANHA'],
        ambiente: 'Laboratório 3',
        patrimonioDecisaoEm: horasAtras(5),
        patrimonioDecisorId: patrimonio.id,
        patrimonioIds: [patrimoniosCriados['PAT-0012']],
      },
      // 5) Interna, em separação (Painel do Patrimônio).
      {
        solicitanteId: ana.id,
        status: 'EM_SEPARACAO',
        tipoEmprestimo: 'interno',
        data: daqui(0),
        periodos: ['TARDE'],
        ambiente: 'Sala 5',
        patrimonioDecisaoEm: horasAtras(10),
        patrimonioDecisorId: patrimonio.id,
        separadoEm: horasAtras(1),
        separadoPorId: patrimonio.id,
        patrimonioIds: [patrimoniosCriados['PAT-0009']],
      },
      // 6) Interna, pronta para retirada.
      {
        solicitanteId: carlos.id,
        status: 'PRONTA_RETIRADA',
        tipoEmprestimo: 'interno',
        data: daqui(0),
        periodos: ['MANHA'],
        ambiente: 'Recepção',
        patrimonioDecisaoEm: horasAtras(12),
        patrimonioDecisorId: patrimonio.id,
        separadoEm: horasAtras(3),
        separadoPorId: patrimonio.id,
        patrimonioIds: [patrimoniosCriados['PAT-0014']],
      },
      // 7) Interna, em utilização (já retirada).
      {
        solicitanteId: mariana.id,
        status: 'EM_UTILIZACAO',
        tipoEmprestimo: 'interno',
        data: daqui(-1),
        periodos: ['TARDE'],
        ambiente: 'Sala 8',
        patrimonioDecisaoEm: horasAtras(30),
        patrimonioDecisorId: patrimonio.id,
        separadoEm: horasAtras(26),
        separadoPorId: patrimonio.id,
        retiradaEm: horasAtras(24),
        retiradaPorId: patrimonio.id,
        patrimonioIds: [patrimoniosCriados['PAT-0002']],
      },
      // 8) Interna, finalizada (ciclo completo, sem avarias).
      {
        solicitanteId: lucas.id,
        status: 'FINALIZADA',
        tipoEmprestimo: 'interno',
        data: daqui(-4),
        periodos: ['MANHA'],
        ambiente: 'Sala 2',
        observacoes: 'Uso em treinamento interno',
        patrimonioDecisaoEm: horasAtras(96),
        patrimonioDecisorId: patrimonio.id,
        separadoEm: horasAtras(90),
        separadoPorId: patrimonio.id,
        retiradaEm: horasAtras(88),
        retiradaPorId: patrimonio.id,
        devolucaoEm: horasAtras(48),
        devolucaoPorId: patrimonio.id,
        devolucaoCondicao: 'SEM_AVARIAS',
        patrimonioIds: [patrimoniosCriados['PAT-0017'], patrimoniosCriados['PAT-0018']],
      },
      // 9) Externa, rejeitada pelo gestor.
      {
        solicitanteId: ana.id,
        status: 'REJEITADA_GESTOR',
        tipoEmprestimo: 'externo',
        data: daqui(3),
        periodos: ['MANHA'],
        atividadeExterna: 'Evento externo de divulgação',
        local: 'Praça Central',
        cidade: 'Guarulhos',
        gestorId: gestor.id,
        gestorDecisaoEm: horasAtras(15),
        motivoRejeicaoGestor: 'Atividade fora do escopo aprovado para o período.',
        patrimonioIds: [patrimoniosCriados['PAT-0005']],
      },
      // 10) Interna, rejeitada pelo Patrimônio.
      {
        solicitanteId: carlos.id,
        status: 'REJEITADA_PATRIMONIO',
        tipoEmprestimo: 'interno',
        data: daqui(2),
        periodos: ['TARDE'],
        ambiente: 'Sala 9',
        patrimonioDecisaoEm: horasAtras(8),
        patrimonioDecisorId: patrimonio.id,
        motivoRejeicaoPatrimonio: 'Bem já reservado para manutenção preventiva nesse período.',
        patrimonioIds: [patrimoniosCriados['PAT-0011']],
      },
      // 11) Interna, cancelada pelo solicitante.
      {
        solicitanteId: mariana.id,
        status: 'CANCELADA',
        tipoEmprestimo: 'interno',
        data: daqui(4),
        periodos: ['MANHA'],
        ambiente: 'Sala 1',
        patrimonioIds: [patrimoniosCriados['PAT-0013']],
      },
      // 12) Interna, não retirada (Patrimônio já tinha separado).
      {
        solicitanteId: lucas.id,
        status: 'NAO_RETIRADA',
        tipoEmprestimo: 'interno',
        data: daqui(-2),
        periodos: ['TARDE'],
        ambiente: 'Sala 4',
        patrimonioDecisaoEm: horasAtras(60),
        patrimonioDecisorId: patrimonio.id,
        separadoEm: horasAtras(55),
        separadoPorId: patrimonio.id,
        naoRetiradaEm: horasAtras(30),
        naoRetiradaPorId: patrimonio.id,
        patrimonioIds: [patrimoniosCriados['PAT-0015']],
      },
      // 13) Externa, aguardando envio de assinatura.
      {
        solicitanteId: ana.id,
        status: 'AGUARDANDO_ENVIO_ASSINATURA',
        tipoEmprestimo: 'externo',
        data: daqui(7),
        periodos: ['MANHA'],
        atividadeExterna: 'Visita técnica a cliente',
        local: 'Sede do cliente',
        cidade: 'Osasco',
        gestorId: gestor.id,
        gestorDecisaoEm: horasAtras(40),
        patrimonioDecisaoEm: horasAtras(18),
        patrimonioDecisorId: patrimonio.id,
        patrimonioIds: [patrimoniosCriados['PAT-0006']],
      },
    ]

    let numeroContador = 0
    for (const s of demo) {
      numeroContador++
      const criada = await prisma.solicitacao.create({
        data: {
          solicitanteId: s.solicitanteId,
          criadoPorId: s.solicitanteId,
          tipoEmprestimo: s.tipoEmprestimo,
          origem: s.origem ?? 'RESERVA',
          status: s.status,
          data: s.data,
          periodos: s.periodos,
          ambiente: s.ambiente,
          finalidade: s.finalidade,
          atividadeExterna: s.atividadeExterna,
          local: s.local,
          cidade: s.cidade,
          gestorId: s.gestorId,
          observacoes: s.observacoes,
          gestorDecisaoEm: s.gestorDecisaoEm,
          motivoRejeicaoGestor: s.motivoRejeicaoGestor,
          patrimonioDecisaoEm: s.patrimonioDecisaoEm,
          patrimonioDecisorId: s.patrimonioDecisorId,
          motivoRejeicaoPatrimonio: s.motivoRejeicaoPatrimonio,
          separadoEm: s.separadoEm,
          separadoPorId: s.separadoPorId,
          retiradaEm: s.retiradaEm,
          retiradaPorId: s.retiradaPorId,
          devolucaoEm: s.devolucaoEm,
          devolucaoPorId: s.devolucaoPorId,
          devolucaoCondicao: s.devolucaoCondicao,
          naoRetiradaEm: s.naoRetiradaEm,
          naoRetiradaPorId: s.naoRetiradaPorId,
          itensPatrimonio: {
            create: s.patrimonioIds.map((patrimonioId) => ({ patrimonioId })),
          },
          historico: {
            create: {
              acao: 'CRIACAO',
              statusNovo: s.status,
              descricao: 'Solicitação criada (dado demonstrativo).',
              usuarioId: s.solicitanteId,
            },
          },
        },
      })

      // Assinatura de exemplo para os dois últimos cenários externos que já
      // avançaram além do envio (AGUARDANDO_ASSINATURA / ASSINATURA_CONFIRMADA
      // não estão na lista `demo` acima — adicionados aqui como registros
      // extras, reaproveitando o mesmo padrão de criação).
      void criada
    }

    // 14) Externa — assinatura enviada, aguardando confirmação.
    const solic14 = await prisma.solicitacao.create({
      data: {
        solicitanteId: carlos.id,
        criadoPorId: carlos.id,
        tipoEmprestimo: 'externo',
        origem: 'RESERVA',
        status: 'AGUARDANDO_ASSINATURA',
        data: daqui(8),
        periodos: ['TARDE'],
        atividadeExterna: 'Treinamento em unidade parceira',
        local: 'Unidade Parceira',
        cidade: 'Barueri',
        gestorId: gestor.id,
        gestorDecisaoEm: horasAtras(50),
        patrimonioDecisaoEm: horasAtras(20),
        patrimonioDecisorId: patrimonio.id,
        itensPatrimonio: { create: [{ patrimonioId: patrimoniosCriados['PAT-0008'] }] },
        assinatura: {
          create: {
            link: 'https://exemplo-assinatura.invalid/doc/demo-14',
            enviadoPorId: patrimonio.id,
            enviadoEm: horasAtras(19),
          },
        },
        historico: {
          create: { acao: 'CRIACAO', statusNovo: 'AGUARDANDO_ASSINATURA', descricao: 'Solicitação criada (dado demonstrativo).', usuarioId: carlos.id },
        },
      },
    })
    void solic14

    // 15) Externa — assinatura confirmada, pronta para seguir para separação.
    const solic15 = await prisma.solicitacao.create({
      data: {
        solicitanteId: mariana.id,
        criadoPorId: mariana.id,
        tipoEmprestimo: 'externo',
        origem: 'RESERVA',
        status: 'ASSINATURA_CONFIRMADA',
        data: daqui(9),
        periodos: ['MANHA'],
        atividadeExterna: 'Palestra em instituição parceira',
        local: 'Instituição Parceira',
        cidade: 'Santo André',
        gestorId: gestor.id,
        gestorDecisaoEm: horasAtras(70),
        patrimonioDecisaoEm: horasAtras(40),
        patrimonioDecisorId: patrimonio.id,
        itensPatrimonio: { create: [{ patrimonioId: patrimoniosCriados['PAT-0016'] }] },
        assinatura: {
          create: {
            link: 'https://exemplo-assinatura.invalid/doc/demo-15',
            enviadoPorId: patrimonio.id,
            enviadoEm: horasAtras(38),
            confirmadaPorId: patrimonio.id,
            confirmadaEm: horasAtras(36),
          },
        },
        historico: {
          create: { acao: 'CRIACAO', statusNovo: 'ASSINATURA_CONFIRMADA', descricao: 'Solicitação criada (dado demonstrativo).', usuarioId: mariana.id },
        },
      },
    })
    void solic15

    // Algumas notificações in-app de exemplo, para a página de Notificações
    // não ficar vazia numa demonstração.
    await prisma.notificacao.createMany({
      data: [
        { usuarioId: ana.id, titulo: 'Solicitação em análise', mensagem: 'Sua solicitação está aguardando confirmação do Patrimônio.', tipo: 'INFO' },
        { usuarioId: carlos.id, titulo: 'Aprovação pendente', mensagem: 'Você tem uma solicitação aguardando sua aprovação como gestor.', tipo: 'INFO' },
        { usuarioId: lucas.id, titulo: 'Reserva confirmada', mensagem: 'Sua reserva foi confirmada pelo Patrimônio.', tipo: 'SUCESSO' },
        { usuarioId: mariana.id, titulo: 'Solicitação rejeitada', mensagem: 'Uma de suas solicitações foi rejeitada. Veja os detalhes.', tipo: 'ALERTA' },
      ],
    })

    console.log(`✅ Solicitações demonstrativas criadas: ${demo.length + 2}`)
    console.log('✅ Notificações demonstrativas criadas: 4')
  }

  console.log('\n🎉 Seed demonstrativo concluído com sucesso!')

  if (Object.keys(senhasGeradas).length > 0) {
    console.log('\n📋 Credenciais de acesso (senha temporária, gerada só nesta execução):')
    for (const [email, senha] of Object.entries(senhasGeradas)) {
      console.log(`  ${email.padEnd(20)} | ${senha}`)
    }
    console.log('\n⚠️  Estas senhas só aparecem aqui, uma única vez, e nunca são gravadas em texto plano.')
    console.log('⚠️  Troque-as no primeiro acesso (menu "Minha Conta" → "Alterar Senha").')
  } else {
    console.log('\nℹ️  Nenhum usuário novo foi criado nesta execução — senhas existentes preservadas.')
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
