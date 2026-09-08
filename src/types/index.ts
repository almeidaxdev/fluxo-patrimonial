// src/types/index.ts

export type Permissao = 'colaborador' | 'patrimonio' | 'administrador'
export type TipoEmprestimo = 'interno' | 'externo'
export type PeriodoSolicitacao = 'MANHA' | 'TARDE' | 'NOITE'
export type OrigemSolicitacao = 'RESERVA' | 'ATENDIMENTO_IMEDIATO'

// NOVO (Etapa 9A-C)
export type CondicaoDevolucao = 'SEM_AVARIAS' | 'COM_AVARIA' | 'DANIFICADO' | 'NECESSITA_VERIFICACAO'

// NOVO (Etapa domain-flow)
export type TipoDominio = 'EDUCACIONAL' | 'ADMINISTRATIVO'

export type StatusSolicitacao =
  | 'AGUARDANDO_GESTOR'
  | 'REJEITADA_GESTOR'
  | 'AGUARDANDO_PATRIMONIO'
  | 'REJEITADA_PATRIMONIO'
  | 'CONFIRMADA'
  | 'AGUARDANDO_ENVIO_ASSINATURA'
  | 'AGUARDANDO_ASSINATURA'
  | 'ASSINATURA_CONFIRMADA'
  | 'EM_SEPARACAO'
  | 'PRONTA_RETIRADA'
  | 'EM_UTILIZACAO'
  | 'FINALIZADA'
  | 'CANCELADA'
  | 'NAO_RETIRADA'

export interface User {
  id: string
  nome: string
  email: string
  permissao: Permissao
  ativo: boolean
  podeSerGestor: boolean
  // Capacidade adicional (não é um perfil) — ver podeSolicitarParaOutro()
  // em src/lib/permissions.ts.
  podeSolicitarParaOutro: boolean
  gestorPadraoId?: string | null
  gestorPadrao?: User | null
  createdAt: string
}

export interface CategoriaPatrimonio {
  id: string
  nome: string
  descricao?: string | null
  icone?: string | null
  ordem: number
  ativo: boolean
  createdAt: string
  _count?: { patrimonios: number }
}

export interface Patrimonio {
  id: string
  numero: string
  marca: string
  modelo: string
  observacoes?: string | null
  ativo: boolean
  categoriaId: string
  categoria?: CategoriaPatrimonio
  createdAt: string
}

export interface ItemPatrimonioSolicitacao {
  id: string
  solicitacaoId: string
  patrimonioId: string
  comDominio?: boolean | null
  patrimonio?: Patrimonio
}

export interface ItemPapelaria {
  id: string
  solicitacaoId: string
  descricao: string
  quantidade: number
}

// NOVO (Fase 3 — Etapa 3)
export interface TipoServico {
  id: string
  nome: string
  descricao?: string | null
  ativo: boolean
  ordem: number
  createdAt: string
}

export interface ItemServicoSolicitacao {
  id: string
  solicitacaoId: string
  tipoServicoId: string
  tipoServico?: TipoServico
  quantidade?: number | null
  ambiente?: string | null
  observacao?: string | null
}

export interface Assinatura {
  id: string
  solicitacaoId: string
  link?: string | null
  enviadoPorId?: string | null
  enviadoPor?: User | null
  enviadoEm?: string | null
  confirmadaPorId?: string | null
  confirmadaPor?: User | null
  confirmadaEm?: string | null
}

export interface HistoricoSolicitacao {
  id: string
  solicitacaoId: string
  usuarioId?: string | null
  usuario?: User | null
  acao: string
  statusAnterior?: string | null
  statusNovo?: string | null
  descricao?: string | null
  metadata?: Record<string, unknown> | null
  createdAt: string
}

export interface Notificacao {
  id: string
  usuarioId: string
  solicitacaoId?: string | null
  titulo: string
  mensagem: string
  link?: string | null
  tipo?: string | null
  lida: boolean
  createdAt: string
}

export interface Solicitacao {
  id: string
  numero: number
  tipoEmprestimo: TipoEmprestimo

  solicitanteId: string
  solicitante?: User
  criadoPorId: string
  criadoPor?: User

  ambiente?: string | null
  finalidade?: string | null

  atividadeExterna?: string | null
  local?: string | null
  cidade?: string | null
  gestorId?: string | null
  gestor?: User | null

  observacoes?: string | null

  data: string
  periodos: PeriodoSolicitacao[]

  notebooksComDominio?: boolean | null
  tipoDominio?: TipoDominio | null

  status: StatusSolicitacao

  // Fase 3 — origem e prazo (histórico, calculado uma única vez na criação)
  origem?: OrigemSolicitacao
  prazoHoras?: number | null
  antecedenciaMinutos?: number | null
  dentroDoPrazo?: boolean | null
  prazoReferenciaEm?: string | null

  motivoRejeicaoGestor?: string | null
  motivoRejeicaoPatrimonio?: string | null

  gestorDecisaoEm?: string | null
  patrimonioDecisaoEm?: string | null
  patrimonioDecisorId?: string | null

  separadoEm?: string | null
  separadoPorId?: string | null
  retiradaEm?: string | null
  retiradaPorId?: string | null
  retiradaObs?: string | null
  devolucaoEm?: string | null
  devolucaoPorId?: string | null
  devolucaoCondicao?: CondicaoDevolucao | null
  devolucaoCondicaoTextoLegado?: string | null
  devolucaoObs?: string | null
  naoRetiradaEm?: string | null
  naoRetiradaPorId?: string | null

  createdAt: string
  updatedAt: string

  itensPatrimonio?: ItemPatrimonioSolicitacao[]
  itensPapelaria?: ItemPapelaria[]
  itensServico?: ItemServicoSolicitacao[]
  assinatura?: Assinatura | null
  historico?: HistoricoSolicitacao[]
}

export interface SessionUser {
  id: string
  nome: string
  email: string
  permissao: Permissao
  podeSerGestor?: boolean
  // Capacidade adicional (Etapa security/request-for-another), gravada no
  // JWT no momento do login — ver podeSolicitarParaOutro() em
  // src/lib/permissions.ts e o aviso de staleness em docs/ARQUITETURA.md
  // (mesma limitação já existente para permissao/podeSerGestor: uma
  // alteração feita pelo admin só passa a valer no próximo login/token).
  podeSolicitarParaOutro?: boolean
  // Etapa security/session-revocation — versão de sessão vigente NO
  // MOMENTO DO LOGIN (nunca recalculada sem novo login). Declarado como
  // obrigatório aqui de propósito (para forçar todo ponto que CRIA uma
  // SessionUser/assina um JWT a pensar no campo), mas um token DECODIFICADO
  // (verifyToken(), via cast `as unknown as SessionUser`) não é garantido
  // ter esse valor em runtime — um token emitido ANTES desta etapa não terá
  // a claim `versaoSessao` de forma alguma. `getValidatedMutationSession()`
  // (src/lib/session-validation.ts) usa exatamente essa lacuna: compara com
  // `===` estrito contra o valor atual do banco, sem nenhum fallback
  // (`?? 0`) — um token antigo, sem a claim, nunca é `=== 0` (é
  // `undefined`), então é sempre rejeitado, mesmo que o usuário nunca tenha
  // tido sua versão incrementada.
  versaoSessao: number
}

// Etapa fix/collaborator-session-sync — formato devolvido por
// GET /api/auth/me e consumido pelo AuthProvider/useSession(): dados ATUAIS
// do banco (via getValidatedMutationSession(), 1 única consulta), nunca as
// claims (potencialmente desatualizadas) do JWT. Sem `versaoSessao`
// (irrelevante fora do backend); `ativo` sempre `true` quando presente —
// por construção, a rota só devolve `user` quando a sessão foi validada.
export type SessaoAtual = Omit<SessionUser, 'versaoSessao'> & { ativo: true; gestorPadraoId?: string | null }

export interface DashboardStats {
  aguardandoAnalise: number
  aguardandoAssinatura: number
  prontasRetirada: number
  emUtilizacao: number
  aguardandoDevolucao: number
  minhasPendentes: number
  aprovacoesPendentes: number
  bensDisponiveis: number
  bensTotal: number
  grafico: { data: string; total: number }[]
}

// ---------------------------------------------------------------------------
// Labels e cores centralizadas — nunca comparar/exibir status por texto solto
// ---------------------------------------------------------------------------

export const PERMISSAO_LABELS: Record<Permissao, string> = {
  colaborador: 'Colaborador',
  patrimonio: 'Patrimônio',
  administrador: 'Administrador',
}

export const TIPO_EMPRESTIMO_LABELS: Record<TipoEmprestimo, string> = {
  interno: 'Interno',
  externo: 'Externo',
}

export const PERIODO_LABELS: Record<PeriodoSolicitacao, string> = {
  MANHA: 'Manhã',
  TARDE: 'Tarde',
  NOITE: 'Noite',
}

export const STATUS_SOLICITACAO_LABELS: Record<StatusSolicitacao, string> = {
  AGUARDANDO_GESTOR: 'Aguardando Gestor',
  REJEITADA_GESTOR: 'Rejeitada pelo Gestor',
  AGUARDANDO_PATRIMONIO: 'Aguardando Patrimônio',
  REJEITADA_PATRIMONIO: 'Rejeitada pelo Patrimônio',
  CONFIRMADA: 'Confirmada',
  AGUARDANDO_ENVIO_ASSINATURA: 'Aguardando Envio da Assinatura',
  AGUARDANDO_ASSINATURA: 'Aguardando Assinatura',
  ASSINATURA_CONFIRMADA: 'Assinatura Confirmada',
  EM_SEPARACAO: 'Em Separação',
  PRONTA_RETIRADA: 'Pronta para Retirada',
  EM_UTILIZACAO: 'Em Utilização',
  FINALIZADA: 'Finalizada',
  CANCELADA: 'Cancelada',
  NAO_RETIRADA: 'Não Retirada',
}

export const STATUS_SOLICITACAO_COLORS: Record<StatusSolicitacao, string> = {
  AGUARDANDO_GESTOR: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  REJEITADA_GESTOR: 'bg-red-100 text-red-800 border-red-200',
  AGUARDANDO_PATRIMONIO: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  REJEITADA_PATRIMONIO: 'bg-red-100 text-red-800 border-red-200',
  CONFIRMADA: 'bg-blue-100 text-blue-800 border-blue-200',
  AGUARDANDO_ENVIO_ASSINATURA: 'bg-orange-100 text-orange-800 border-orange-200',
  AGUARDANDO_ASSINATURA: 'bg-orange-100 text-orange-800 border-orange-200',
  ASSINATURA_CONFIRMADA: 'bg-blue-100 text-blue-800 border-blue-200',
  EM_SEPARACAO: 'bg-purple-100 text-purple-800 border-purple-200',
  PRONTA_RETIRADA: 'bg-purple-100 text-purple-800 border-purple-200',
  EM_UTILIZACAO: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  FINALIZADA: 'bg-gray-100 text-gray-800 border-gray-200',
  CANCELADA: 'bg-gray-200 text-gray-600 border-gray-300',
  NAO_RETIRADA: 'bg-amber-100 text-amber-800 border-amber-200',
}

// NOVO (Etapa 9A-C)
export const CONDICAO_DEVOLUCAO_LABELS: Record<CondicaoDevolucao, string> = {
  SEM_AVARIAS: 'Sem avarias',
  COM_AVARIA: 'Com avaria',
  DANIFICADO: 'Danificado',
  NECESSITA_VERIFICACAO: 'Necessita verificação',
}

// NOVO (Etapa domain-flow)
export const TIPO_DOMINIO_LABELS: Record<TipoDominio, string> = {
  EDUCACIONAL: 'Educacional',
  ADMINISTRATIVO: 'Administrativo',
}
