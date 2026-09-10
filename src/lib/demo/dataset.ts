// src/lib/demo/dataset.ts
//
// Fonte ÚNICA do dataset demonstrativo do Fluxo Patrimonial — usada tanto
// por `prisma/seed.ts` (primeira carga do banco, rodada manualmente por
// quem provisiona o ambiente) quanto pela rota de reset
// (`POST /api/internal/demo-reset`, ver `resetarDatasetDemo()` abaixo). As
// DUAS nunca devem divergir sobre "qual é o estado demonstrativo correto" —
// por isso nenhuma delas define usuários/categorias/patrimônios/
// solicitações por conta própria; ambas chamam as funções deste arquivo.
//
// Tudo aqui é 100% fictício: e-mails só em @example.com, números de
// patrimônio PAT-0001..PAT-0018 nunca reaproveitados de nenhum ambiente
// real, cidades/locais genéricos.

import { Prisma, Permissao, TipoEmprestimo, PeriodoSolicitacao, StatusSolicitacao, OrigemSolicitacao, CondicaoDevolucao } from '@prisma/client'
import { randomInt } from 'crypto'
import bcrypt from 'bcryptjs'

// Aceita tanto o PrismaClient completo quanto o `tx` de dentro de um
// `prisma.$transaction(async (tx) => ...)` — as duas formas expõem os
// mesmos métodos de modelo usados aqui.
export type ClientePrismaOuTransacao = Prisma.TransactionClient

// ---------------------------------------------------------------------------
// Senha temporária — mesmo padrão usado no reset administrativo de senha
// (src/app/api/colaboradores/[id]/route.ts): prefixo fixo (não é segredo) +
// sufixo aleatório criptograficamente seguro (crypto.randomInt, nunca
// Math.random()), alfabeto sem caracteres ambíguos.
// ---------------------------------------------------------------------------
const PREFIXO_SENHA_DEMO = 'Flx@9'
const ALFABETO_SENHA_DEMO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const TAMANHO_SUFIXO_SENHA_DEMO = 8

export function gerarSenhaTemporariaDemo(): string {
  let sufixo = ''
  for (let i = 0; i < TAMANHO_SUFIXO_SENHA_DEMO; i++) {
    sufixo += ALFABETO_SENHA_DEMO[randomInt(ALFABETO_SENHA_DEMO.length)]
  }
  return `${PREFIXO_SENHA_DEMO}${sufixo}`
}

// ---------------------------------------------------------------------------
// Usuários demonstrativos
// ---------------------------------------------------------------------------
export interface UsuarioDemoDef {
  email: string
  nome: string
  permissao: Permissao
  podeSerGestor?: boolean
  /** E-mail do gestor padrão — resolvido para `gestorPadraoId` em runtime. */
  gestorPadraoEmail?: string
}

export const USUARIOS_DEMO: UsuarioDemoDef[] = [
  { email: 'admin@example.com', nome: 'Administrador Demo', permissao: 'administrador', podeSerGestor: true },
  { email: 'patrimonio@example.com', nome: 'Patrimônio Demo', permissao: 'patrimonio' },
  { email: 'gestor@example.com', nome: 'Gestor Demo', permissao: 'colaborador', podeSerGestor: true },
  { email: 'ana@example.com', nome: 'Ana Martins', permissao: 'colaborador', gestorPadraoEmail: 'gestor@example.com' },
  { email: 'carlos@example.com', nome: 'Carlos Oliveira', permissao: 'colaborador', gestorPadraoEmail: 'gestor@example.com' },
  { email: 'mariana@example.com', nome: 'Mariana Souza', permissao: 'colaborador', gestorPadraoEmail: 'gestor@example.com' },
  { email: 'lucas@example.com', nome: 'Lucas Ferreira', permissao: 'colaborador', gestorPadraoEmail: 'gestor@example.com' },
]

/**
 * Cria os usuários demonstrativos que ainda não existem, e — quando
 * `restaurarExistentes` é `true` (usado pelo reset, nunca pelo seed inicial)
 * — restaura nome/permissão/capacidades/gestor padrão/`ativo` dos que já
 * existem para o valor canônico. A senha NUNCA é sobrescrita num usuário já
 * existente (só definida na criação) — o reset não pode invalidar a
 * credencial que os visitantes da demo já conhecem.
 */
export async function popularUsuariosDemo(
  tx: ClientePrismaOuTransacao,
  opts: { restaurarExistentes: boolean }
): Promise<{ idsPorEmail: Record<string, string>; senhasGeradas: Record<string, string> }> {
  const idsPorEmail: Record<string, string> = {}
  const senhasGeradas: Record<string, string> = {}

  // Duas passadas: 1ª cria/restaura todos SEM gestorPadraoId (ainda não
  // conhecemos os ids uns dos outros); 2ª aplica gestorPadraoId agora que
  // idsPorEmail está completo — evita depender de uma ordem específica no
  // array acima.
  for (const def of USUARIOS_DEMO) {
    const existente = await tx.user.findUnique({ where: { email: def.email } })
    if (existente) {
      idsPorEmail[def.email] = existente.id
      if (opts.restaurarExistentes) {
        await tx.user.update({
          where: { id: existente.id },
          data: { nome: def.nome, permissao: def.permissao, podeSerGestor: !!def.podeSerGestor, ativo: true },
        })
      }
      continue
    }

    const senha = gerarSenhaTemporariaDemo()
    const criado = await tx.user.create({
      data: {
        email: def.email,
        nome: def.nome,
        permissao: def.permissao,
        podeSerGestor: !!def.podeSerGestor,
        senha: await bcrypt.hash(senha, 12),
      },
    })
    idsPorEmail[def.email] = criado.id
    senhasGeradas[def.email] = senha
  }

  for (const def of USUARIOS_DEMO) {
    if (!def.gestorPadraoEmail) continue
    const gestorId = idsPorEmail[def.gestorPadraoEmail]
    if (!gestorId) continue
    await tx.user.update({ where: { id: idsPorEmail[def.email] }, data: { gestorPadraoId: gestorId } })
  }

  return { idsPorEmail, senhasGeradas }
}


// ---------------------------------------------------------------------------
// Categorias de patrimônio
// ---------------------------------------------------------------------------
export interface CategoriaDemoDef {
  nome: string
  ordem: number
  icone: string
}

export const CATEGORIAS_DEMO: CategoriaDemoDef[] = [
  { nome: 'Notebook', ordem: 0, icone: 'laptop' },
  { nome: 'Projetor', ordem: 1, icone: 'projector' },
  { nome: 'Monitor', ordem: 2, icone: 'monitor' },
  { nome: 'Tablet', ordem: 3, icone: 'tablet' },
  { nome: 'Caixa de Som', ordem: 4, icone: 'speaker' },
  { nome: 'Microfone', ordem: 5, icone: 'mic' },
  { nome: 'Adaptador', ordem: 6, icone: 'cable' },
  { nome: 'Extensão', ordem: 7, icone: 'plug' },
]

export async function popularCategoriasDemo(tx: ClientePrismaOuTransacao): Promise<Record<string, string>> {
  const idsPorNome: Record<string, string> = {}
  for (const cat of CATEGORIAS_DEMO) {
    const c = await tx.categoriaPatrimonio.upsert({
      where: { nome: cat.nome },
      update: { ordem: cat.ordem, icone: cat.icone, ativo: true },
      create: { ...cat, ativo: true },
    })
    idsPorNome[cat.nome] = c.id
  }
  return idsPorNome
}

// ---------------------------------------------------------------------------
// Tipos de serviço
// ---------------------------------------------------------------------------
export interface TipoServicoDemoDef {
  nome: string
  ordem: number
}

export const TIPOS_SERVICO_DEMO: TipoServicoDemoDef[] = [
  { nome: 'Movimentação de cadeiras', ordem: 0 },
  { nome: 'Movimentação de mesas', ordem: 1 },
  { nome: 'Fundo infinito', ordem: 2 },
  { nome: 'Backdrop', ordem: 3 },
  { nome: 'Flipchart', ordem: 4 },
  { nome: 'Outros serviços/movimentações', ordem: 5 },
]

export async function popularTiposServicoDemo(tx: ClientePrismaOuTransacao): Promise<Record<string, string>> {
  const idsPorNome: Record<string, string> = {}
  for (const servico of TIPOS_SERVICO_DEMO) {
    const t = await tx.tipoServico.upsert({
      where: { nome: servico.nome },
      update: { ordem: servico.ordem, ativo: true },
      create: { ...servico, ativo: true },
    })
    idsPorNome[servico.nome] = t.id
  }
  return idsPorNome
}

// ---------------------------------------------------------------------------
// Patrimônios demonstrativos
// ---------------------------------------------------------------------------
export interface PatrimonioDemoDef {
  numero: string
  marca: string
  modelo: string
  categoria: string
}

export const PATRIMONIOS_DEMO: PatrimonioDemoDef[] = [
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

export async function popularPatrimoniosDemo(
  tx: ClientePrismaOuTransacao,
  categoriasIdsPorNome: Record<string, string>
): Promise<Record<string, string>> {
  const idsPorNumero: Record<string, string> = {}
  for (const p of PATRIMONIOS_DEMO) {
    const criado = await tx.patrimonio.upsert({
      where: { numero: p.numero },
      update: { marca: p.marca, modelo: p.modelo, categoriaId: categoriasIdsPorNome[p.categoria], ativo: true },
      create: { numero: p.numero, marca: p.marca, modelo: p.modelo, ativo: true, categoriaId: categoriasIdsPorNome[p.categoria] },
    })
    idsPorNumero[p.numero] = criado.id
  }
  return idsPorNumero
}

// ---------------------------------------------------------------------------
// Dados MUTÁVEIS (solicitações, itens, histórico, assinaturas, notificações,
// eventos de e-mail) — sempre apagados por inteiro e recriados do zero pelo
// reset; nunca "restaurados campo a campo" como usuários/categorias/
// patrimônios/tipos de serviço acima (não há identificador de negócio
// estável para fazer upsert numa solicitação demonstrativa).
// ---------------------------------------------------------------------------

/**
 * Apaga, em ordem segura de FK, todos os dados mutáveis do fluxo de
 * solicitações. Chamado dentro da MESMA transação que depois recria o
 * dataset (`resetarDatasetDemo()`) — nunca em `prisma.$executeRaw`/SQL cru,
 * sempre `deleteMany` explícito por tabela, nunca TRUNCATE.
 */
export async function apagarDadosMutaveisDemo(tx: ClientePrismaOuTransacao): Promise<void> {
  // notificacao/historico/assinatura/itens referenciam solicitacaoId com
  // onDelete: Cascade — apagar antes explicitamente (em vez de confiar só
  // na cascata) deixa a ordem de dependência auditável linha a linha.
  await tx.notificacao.deleteMany({})
  await tx.historicoSolicitacao.deleteMany({})
  await tx.assinatura.deleteMany({})
  await tx.itemPatrimonioSolicitacao.deleteMany({})
  await tx.itemPapelaria.deleteMany({})
  await tx.itemServicoSolicitacao.deleteMany({})
  await tx.emailEvento.deleteMany({})
  await tx.solicitacao.deleteMany({})
}

interface SolicitacaoDemoDef {
  solicitanteEmail: string
  status: StatusSolicitacao
  tipoEmprestimo: TipoEmprestimo
  origem?: OrigemSolicitacao
  diasRelativos: number
  periodos: PeriodoSolicitacao[]
  ambiente?: string
  finalidade?: string
  atividadeExterna?: string
  local?: string
  cidade?: string
  gestorEmail?: string
  observacoes?: string
  patrimonioNumeros: string[]
  horasAtrasGestorDecisao?: number
  motivoRejeicaoGestor?: string
  horasAtrasPatrimonioDecisao?: number
  patrimonioDecisorEmail?: string
  motivoRejeicaoPatrimonio?: string
  horasAtrasSeparacao?: number
  separadoPorEmail?: string
  horasAtrasRetirada?: number
  retiradaPorEmail?: string
  horasAtrasDevolucao?: number
  devolucaoPorEmail?: string
  devolucaoCondicao?: CondicaoDevolucao
  horasAtrasNaoRetirada?: number
  naoRetiradaPorEmail?: string
}

const SOLICITACOES_DEMO: SolicitacaoDemoDef[] = [
  { solicitanteEmail: 'ana@example.com', status: 'AGUARDANDO_PATRIMONIO', tipoEmprestimo: 'interno', diasRelativos: 2, periodos: ['MANHA'], ambiente: 'Sala 12', finalidade: 'Apresentação para a equipe de projetos', patrimonioNumeros: ['PAT-0001'] },
  { solicitanteEmail: 'carlos@example.com', status: 'AGUARDANDO_GESTOR', tipoEmprestimo: 'externo', diasRelativos: 5, periodos: ['TARDE'], atividadeExterna: 'Feira de tecnologia', local: 'Centro de Convenções', cidade: 'São Paulo', gestorEmail: 'gestor@example.com', patrimonioNumeros: ['PAT-0003', 'PAT-0007'] },
  { solicitanteEmail: 'mariana@example.com', status: 'AGUARDANDO_PATRIMONIO', tipoEmprestimo: 'externo', diasRelativos: 6, periodos: ['MANHA', 'TARDE'], atividadeExterna: 'Workshop externo de capacitação', local: 'Auditório Municipal', cidade: 'Campinas', gestorEmail: 'gestor@example.com', horasAtrasGestorDecisao: 20, patrimonioNumeros: ['PAT-0004'] },
  { solicitanteEmail: 'lucas@example.com', status: 'CONFIRMADA', tipoEmprestimo: 'interno', diasRelativos: 1, periodos: ['MANHA'], ambiente: 'Laboratório 3', horasAtrasPatrimonioDecisao: 5, patrimonioDecisorEmail: 'patrimonio@example.com', patrimonioNumeros: ['PAT-0012'] },
  { solicitanteEmail: 'ana@example.com', status: 'EM_SEPARACAO', tipoEmprestimo: 'interno', diasRelativos: 0, periodos: ['TARDE'], ambiente: 'Sala 5', horasAtrasPatrimonioDecisao: 10, patrimonioDecisorEmail: 'patrimonio@example.com', horasAtrasSeparacao: 1, separadoPorEmail: 'patrimonio@example.com', patrimonioNumeros: ['PAT-0009'] },
  { solicitanteEmail: 'carlos@example.com', status: 'PRONTA_RETIRADA', tipoEmprestimo: 'interno', diasRelativos: 0, periodos: ['MANHA'], ambiente: 'Recepção', horasAtrasPatrimonioDecisao: 12, patrimonioDecisorEmail: 'patrimonio@example.com', horasAtrasSeparacao: 3, separadoPorEmail: 'patrimonio@example.com', patrimonioNumeros: ['PAT-0014'] },
  { solicitanteEmail: 'mariana@example.com', status: 'EM_UTILIZACAO', tipoEmprestimo: 'interno', diasRelativos: -1, periodos: ['TARDE'], ambiente: 'Sala 8', horasAtrasPatrimonioDecisao: 30, patrimonioDecisorEmail: 'patrimonio@example.com', horasAtrasSeparacao: 26, separadoPorEmail: 'patrimonio@example.com', horasAtrasRetirada: 24, retiradaPorEmail: 'patrimonio@example.com', patrimonioNumeros: ['PAT-0002'] },
  { solicitanteEmail: 'lucas@example.com', status: 'FINALIZADA', tipoEmprestimo: 'interno', diasRelativos: -4, periodos: ['MANHA'], ambiente: 'Sala 2', observacoes: 'Uso em treinamento interno', horasAtrasPatrimonioDecisao: 96, patrimonioDecisorEmail: 'patrimonio@example.com', horasAtrasSeparacao: 90, separadoPorEmail: 'patrimonio@example.com', horasAtrasRetirada: 88, retiradaPorEmail: 'patrimonio@example.com', horasAtrasDevolucao: 48, devolucaoPorEmail: 'patrimonio@example.com', devolucaoCondicao: 'SEM_AVARIAS', patrimonioNumeros: ['PAT-0017', 'PAT-0018'] },
  { solicitanteEmail: 'ana@example.com', status: 'REJEITADA_GESTOR', tipoEmprestimo: 'externo', diasRelativos: 3, periodos: ['MANHA'], atividadeExterna: 'Evento externo de divulgação', local: 'Praça Central', cidade: 'Guarulhos', gestorEmail: 'gestor@example.com', horasAtrasGestorDecisao: 15, motivoRejeicaoGestor: 'Atividade fora do escopo aprovado para o período.', patrimonioNumeros: ['PAT-0005'] },
  { solicitanteEmail: 'carlos@example.com', status: 'REJEITADA_PATRIMONIO', tipoEmprestimo: 'interno', diasRelativos: 2, periodos: ['TARDE'], ambiente: 'Sala 9', horasAtrasPatrimonioDecisao: 8, patrimonioDecisorEmail: 'patrimonio@example.com', motivoRejeicaoPatrimonio: 'Bem já reservado para manutenção preventiva nesse período.', patrimonioNumeros: ['PAT-0011'] },
  { solicitanteEmail: 'mariana@example.com', status: 'CANCELADA', tipoEmprestimo: 'interno', diasRelativos: 4, periodos: ['MANHA'], ambiente: 'Sala 1', patrimonioNumeros: ['PAT-0013'] },
  { solicitanteEmail: 'lucas@example.com', status: 'NAO_RETIRADA', tipoEmprestimo: 'interno', diasRelativos: -2, periodos: ['TARDE'], ambiente: 'Sala 4', horasAtrasPatrimonioDecisao: 60, patrimonioDecisorEmail: 'patrimonio@example.com', horasAtrasSeparacao: 55, separadoPorEmail: 'patrimonio@example.com', horasAtrasNaoRetirada: 30, naoRetiradaPorEmail: 'patrimonio@example.com', patrimonioNumeros: ['PAT-0015'] },
  { solicitanteEmail: 'ana@example.com', status: 'AGUARDANDO_ENVIO_ASSINATURA', tipoEmprestimo: 'externo', diasRelativos: 7, periodos: ['MANHA'], atividadeExterna: 'Visita técnica a cliente', local: 'Sede do cliente', cidade: 'Osasco', gestorEmail: 'gestor@example.com', horasAtrasGestorDecisao: 40, horasAtrasPatrimonioDecisao: 18, patrimonioDecisorEmail: 'patrimonio@example.com', patrimonioNumeros: ['PAT-0006'] },
]

function horasAtras(base: Date, horas: number): Date {
  const d = new Date(base)
  d.setHours(d.getHours() - horas)
  return d
}

function daqui(base: Date, dias: number): Date {
  const d = new Date(base)
  d.setDate(d.getDate() + dias)
  d.setHours(0, 0, 0, 0)
  return d
}

/**
 * Recria as solicitações e notificações demonstrativas. Sempre chamado
 * DEPOIS de `apagarDadosMutaveisDemo()` na mesma transação — nunca tenta
 * fazer upsert de solicitação (não há identificador de negócio estável).
 */
export async function popularSolicitacoesDemo(
  tx: ClientePrismaOuTransacao,
  usuariosIdsPorEmail: Record<string, string>,
  patrimoniosIdsPorNumero: Record<string, string>
): Promise<void> {
  const hoje = new Date()

  for (const s of SOLICITACOES_DEMO) {
    const solicitanteId = usuariosIdsPorEmail[s.solicitanteEmail]
    await tx.solicitacao.create({
      data: {
        solicitanteId,
        criadoPorId: solicitanteId,
        tipoEmprestimo: s.tipoEmprestimo,
        origem: s.origem ?? 'RESERVA',
        status: s.status,
        data: daqui(hoje, s.diasRelativos),
        periodos: s.periodos,
        ambiente: s.ambiente,
        finalidade: s.finalidade,
        atividadeExterna: s.atividadeExterna,
        local: s.local,
        cidade: s.cidade,
        gestorId: s.gestorEmail ? usuariosIdsPorEmail[s.gestorEmail] : undefined,
        observacoes: s.observacoes,
        gestorDecisaoEm: s.horasAtrasGestorDecisao !== undefined ? horasAtras(hoje, s.horasAtrasGestorDecisao) : undefined,
        motivoRejeicaoGestor: s.motivoRejeicaoGestor,
        patrimonioDecisaoEm: s.horasAtrasPatrimonioDecisao !== undefined ? horasAtras(hoje, s.horasAtrasPatrimonioDecisao) : undefined,
        patrimonioDecisorId: s.patrimonioDecisorEmail ? usuariosIdsPorEmail[s.patrimonioDecisorEmail] : undefined,
        motivoRejeicaoPatrimonio: s.motivoRejeicaoPatrimonio,
        separadoEm: s.horasAtrasSeparacao !== undefined ? horasAtras(hoje, s.horasAtrasSeparacao) : undefined,
        separadoPorId: s.separadoPorEmail ? usuariosIdsPorEmail[s.separadoPorEmail] : undefined,
        retiradaEm: s.horasAtrasRetirada !== undefined ? horasAtras(hoje, s.horasAtrasRetirada) : undefined,
        retiradaPorId: s.retiradaPorEmail ? usuariosIdsPorEmail[s.retiradaPorEmail] : undefined,
        devolucaoEm: s.horasAtrasDevolucao !== undefined ? horasAtras(hoje, s.horasAtrasDevolucao) : undefined,
        devolucaoPorId: s.devolucaoPorEmail ? usuariosIdsPorEmail[s.devolucaoPorEmail] : undefined,
        devolucaoCondicao: s.devolucaoCondicao,
        naoRetiradaEm: s.horasAtrasNaoRetirada !== undefined ? horasAtras(hoje, s.horasAtrasNaoRetirada) : undefined,
        naoRetiradaPorId: s.naoRetiradaPorEmail ? usuariosIdsPorEmail[s.naoRetiradaPorEmail] : undefined,
        itensPatrimonio: { create: s.patrimonioNumeros.map((numero) => ({ patrimonioId: patrimoniosIdsPorNumero[numero] })) },
        historico: {
          create: { acao: 'CRIACAO', statusNovo: s.status, descricao: 'Solicitação criada (dado demonstrativo).', usuarioId: solicitanteId },
        },
      },
    })
  }

  // Dois cenários extras de assinatura (aguardando confirmação / já
  // confirmada) — mesmo padrão do seed original, mantidos fora do array
  // acima por terem um bloco `assinatura.create` aninhado.
  const carlosId = usuariosIdsPorEmail['carlos@example.com']
  const marianaId = usuariosIdsPorEmail['mariana@example.com']
  const gestorId = usuariosIdsPorEmail['gestor@example.com']
  const patrimonioId = usuariosIdsPorEmail['patrimonio@example.com']

  await tx.solicitacao.create({
    data: {
      solicitanteId: carlosId,
      criadoPorId: carlosId,
      tipoEmprestimo: 'externo',
      origem: 'RESERVA',
      status: 'AGUARDANDO_ASSINATURA',
      data: daqui(hoje, 8),
      periodos: ['TARDE'],
      atividadeExterna: 'Treinamento em unidade parceira',
      local: 'Unidade Parceira',
      cidade: 'Barueri',
      gestorId,
      gestorDecisaoEm: horasAtras(hoje, 50),
      patrimonioDecisaoEm: horasAtras(hoje, 20),
      patrimonioDecisorId: patrimonioId,
      itensPatrimonio: { create: [{ patrimonioId: patrimoniosIdsPorNumero['PAT-0008'] }] },
      assinatura: { create: { link: 'https://exemplo-assinatura.invalid/doc/demo-14', enviadoPorId: patrimonioId, enviadoEm: horasAtras(hoje, 19) } },
      historico: { create: { acao: 'CRIACAO', statusNovo: 'AGUARDANDO_ASSINATURA', descricao: 'Solicitação criada (dado demonstrativo).', usuarioId: carlosId } },
    },
  })

  await tx.solicitacao.create({
    data: {
      solicitanteId: marianaId,
      criadoPorId: marianaId,
      tipoEmprestimo: 'externo',
      origem: 'RESERVA',
      status: 'ASSINATURA_CONFIRMADA',
      data: daqui(hoje, 9),
      periodos: ['MANHA'],
      atividadeExterna: 'Palestra em instituição parceira',
      local: 'Instituição Parceira',
      cidade: 'Santo André',
      gestorId,
      gestorDecisaoEm: horasAtras(hoje, 70),
      patrimonioDecisaoEm: horasAtras(hoje, 40),
      patrimonioDecisorId: patrimonioId,
      itensPatrimonio: { create: [{ patrimonioId: patrimoniosIdsPorNumero['PAT-0016'] }] },
      assinatura: {
        create: {
          link: 'https://exemplo-assinatura.invalid/doc/demo-15',
          enviadoPorId: patrimonioId,
          enviadoEm: horasAtras(hoje, 38),
          confirmadaPorId: patrimonioId,
          confirmadaEm: horasAtras(hoje, 36),
        },
      },
      historico: { create: { acao: 'CRIACAO', statusNovo: 'ASSINATURA_CONFIRMADA', descricao: 'Solicitação criada (dado demonstrativo).', usuarioId: marianaId } },
    },
  })

  await tx.notificacao.createMany({
    data: [
      { usuarioId: usuariosIdsPorEmail['ana@example.com'], titulo: 'Solicitação em análise', mensagem: 'Sua solicitação está aguardando confirmação do Patrimônio.', tipo: 'INFO' },
      { usuarioId: carlosId, titulo: 'Aprovação pendente', mensagem: 'Você tem uma solicitação aguardando sua aprovação como gestor.', tipo: 'INFO' },
      { usuarioId: usuariosIdsPorEmail['lucas@example.com'], titulo: 'Reserva confirmada', mensagem: 'Sua reserva foi confirmada pelo Patrimônio.', tipo: 'SUCESSO' },
      { usuarioId: marianaId, titulo: 'Solicitação rejeitada', mensagem: 'Uma de suas solicitações foi rejeitada. Veja os detalhes.', tipo: 'ALERTA' },
    ],
  })
}

/**
 * Repõe o dataset demonstrativo. Foco principal (revisão de hardening —
 * "dados mestres somente leitura"): as tabelas TRANSACIONAIS — solicitações
 * e tudo que pende delas (itens, histórico, assinaturas, notificações,
 * eventos de e-mail) — são apagadas e recriadas do zero a cada reset, já
 * que são o único lugar onde um visitante consegue alterar algo (o core da
 * demo continua mutável de propósito, ver src/lib/demo-mode.ts).
 *
 * Usuários/categorias/tipos de serviço/patrimônios NÃO podem mais ser
 * criados/editados/excluídos por nenhuma rota enquanto DEMO_MODE=true (são
 * dado mestre somente-leitura — ver assertDemoActionAllowed()), então não
 * existe mais cenário de "registro extra criado por um visitante" para
 * limpar aqui. Ainda assim, `popularUsuariosDemo`/`popularCategoriasDemo`/
 * `popularTiposServicoDemo`/`popularPatrimoniosDemo` continuam sendo
 * chamados — como validação/restauração idempotente e NÃO destrutiva
 * (upsert, sem nenhum `deleteMany`), defesa em profundidade caso o dado
 * mestre tenha divergido do canônico por qualquer via fora da API (ex.:
 * edição manual no banco). Roda inteiramente dentro de UMA transação — ou
 * tudo é aplicado, ou nada é.
 */
export async function resetarDatasetDemo(tx: ClientePrismaOuTransacao): Promise<void> {
  await apagarDadosMutaveisDemo(tx)

  const { idsPorEmail: usuariosIdsPorEmail } = await popularUsuariosDemo(tx, { restaurarExistentes: true })
  const categoriasIdsPorNome = await popularCategoriasDemo(tx)
  await popularTiposServicoDemo(tx)
  const patrimoniosIdsPorNumero = await popularPatrimoniosDemo(tx, categoriasIdsPorNome)
  await popularSolicitacoesDemo(tx, usuariosIdsPorEmail, patrimoniosIdsPorNumero)
}
