-- =============================================================================
-- Fluxo Patrimonial — Sistema de Gestão de Empréstimos Patrimoniais
-- SQL CONSOLIDADO — cria a estrutura completa do banco DO ZERO.
--
-- ATENÇÃO: este script assume um schema "public" limpo (sem as tabelas
-- antigas do sistema de reservas). Antes de rodar, execute o script de
-- limpeza (DROP_TUDO.sql) se o banco atual ainda tiver as tabelas antigas.
--
-- Ordem de uso:
--   1) DROP_TUDO.sql   (limpa o schema public)
--   2) consolidated.sql (este arquivo)
--   3) npx prisma generate
--   4) npm run db:seed
-- =============================================================================

-- =============================================================================
-- ENUMS
-- =============================================================================

CREATE TYPE "Permissao" AS ENUM ('colaborador', 'patrimonio', 'administrador');

CREATE TYPE "TipoEmprestimo" AS ENUM ('interno', 'externo');

CREATE TYPE "PeriodoSolicitacao" AS ENUM ('MANHA', 'TARDE', 'NOITE');

CREATE TYPE "CondicaoDevolucao" AS ENUM ('SEM_AVARIAS', 'COM_AVARIA', 'DANIFICADO', 'NECESSITA_VERIFICACAO');

CREATE TYPE "TipoDominio" AS ENUM ('EDUCACIONAL', 'ADMINISTRATIVO');

CREATE TYPE "StatusSolicitacao" AS ENUM (
  'AGUARDANDO_GESTOR',
  'REJEITADA_GESTOR',
  'AGUARDANDO_PATRIMONIO',
  'REJEITADA_PATRIMONIO',
  'CONFIRMADA',
  'AGUARDANDO_ENVIO_ASSINATURA',
  'AGUARDANDO_ASSINATURA',
  'ASSINATURA_CONFIRMADA',
  'EM_SEPARACAO',
  'PRONTA_RETIRADA',
  'EM_UTILIZACAO',
  'FINALIZADA',
  'CANCELADA',
  'NAO_RETIRADA'
);

-- NOVO (Fase 3): origem da solicitação — reserva antecipada (fluxo normal)
-- ou atendimento imediato (Patrimônio atende o solicitante na hora, sem
-- reserva prévia). Ver prisma/schema.prisma, enum OrigemSolicitacao.
CREATE TYPE "OrigemSolicitacao" AS ENUM ('RESERVA', 'ATENDIMENTO_IMEDIATO');

-- =============================================================================
-- USERS
-- =============================================================================

CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "senha" TEXT NOT NULL,
    "permissao" "Permissao" NOT NULL DEFAULT 'colaborador',
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "pode_ser_gestor" BOOLEAN NOT NULL DEFAULT false,
    "gestor_padrao_id" TEXT,
    -- Etapa security/request-for-another — já aplicada manualmente ao banco
    -- de produção (ver docs/BANCO_DE_DADOS.md).
    "pode_solicitar_para_outro" BOOLEAN NOT NULL DEFAULT false,
    -- Etapa security/session-revocation — já aplicada manualmente ao banco
    -- de produção; usada pela revogação de sessão S5 (ver
    -- docs/BANCO_DE_DADOS.md, seção "Já aplicado em produção:
    -- users.versao_sessao", e docs/ARQUITETURA.md, seção "Revogação de
    -- sessão").
    "versao_sessao" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE INDEX "users_permissao_idx" ON "users"("permissao");
CREATE INDEX "users_ativo_idx" ON "users"("ativo");
CREATE INDEX "users_pode_ser_gestor_idx" ON "users"("pode_ser_gestor");

ALTER TABLE "users" ADD CONSTRAINT "users_gestor_padrao_id_fkey"
  FOREIGN KEY ("gestor_padrao_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- =============================================================================
-- CATEGORIAS DE PATRIMÔNIO
-- =============================================================================

CREATE TABLE "categorias_patrimonio" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "descricao" TEXT,
    "icone" TEXT,
    "ordem" INTEGER NOT NULL DEFAULT 0,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "categorias_patrimonio_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "categorias_patrimonio_nome_key" ON "categorias_patrimonio"("nome");
CREATE INDEX "categorias_patrimonio_ativo_idx" ON "categorias_patrimonio"("ativo");

-- =============================================================================
-- PATRIMÔNIOS (bens: notebooks, projetores, TVs, etc.)
-- =============================================================================

CREATE TABLE "patrimonios" (
    "id" TEXT NOT NULL,
    "numero_patrimonio" TEXT NOT NULL,
    "marca" TEXT NOT NULL,
    "modelo" TEXT NOT NULL,
    "observacoes" TEXT,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "categoria_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "patrimonios_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "patrimonios_numero_patrimonio_key" ON "patrimonios"("numero_patrimonio");
CREATE INDEX "patrimonios_numero_patrimonio_idx" ON "patrimonios"("numero_patrimonio");
CREATE INDEX "patrimonios_ativo_idx" ON "patrimonios"("ativo");
CREATE INDEX "patrimonios_categoria_id_idx" ON "patrimonios"("categoria_id");

ALTER TABLE "patrimonios" ADD CONSTRAINT "patrimonios_categoria_id_fkey"
  FOREIGN KEY ("categoria_id") REFERENCES "categorias_patrimonio"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================================
-- SOLICITAÇÕES
-- =============================================================================

CREATE TABLE "solicitacoes" (
    "id" TEXT NOT NULL,
    "numero" SERIAL NOT NULL,
    "tipo_emprestimo" "TipoEmprestimo" NOT NULL,
    "solicitante_id" TEXT NOT NULL,
    "criado_por_id" TEXT NOT NULL,
    "ambiente" TEXT,
    "finalidade" TEXT,
    "atividade_externa" TEXT,
    "local" TEXT,
    "cidade" TEXT,
    "gestor_id" TEXT,
    "observacoes" TEXT,
    "data" DATE NOT NULL,
    "periodos" "PeriodoSolicitacao"[] NOT NULL DEFAULT ARRAY[]::"PeriodoSolicitacao"[],
    "notebooks_com_dominio" BOOLEAN,
    "tipo_dominio" "TipoDominio",
    "status" "StatusSolicitacao" NOT NULL DEFAULT 'AGUARDANDO_PATRIMONIO',
    -- NOVO (Fase 3): origem e controle de antecedência/prazo — ver
    -- prisma/schema.prisma, model Solicitacao, campos origem/prazoHoras/
    -- antecedenciaMinutos/dentroDoPrazo/prazoReferenciaEm.
    "origem" "OrigemSolicitacao" NOT NULL DEFAULT 'RESERVA',
    "prazo_horas" INTEGER,
    "antecedencia_minutos" INTEGER,
    "dentro_do_prazo" BOOLEAN,
    "prazo_referencia_em" TIMESTAMP(3),
    "motivo_rejeicao_gestor" TEXT,
    "motivo_rejeicao_patrimonio" TEXT,
    "gestor_decisao_em" TIMESTAMP(3),
    "patrimonio_decisao_em" TIMESTAMP(3),
    "patrimonio_decisor_id" TEXT,
    "separado_em" TIMESTAMP(3),
    "separado_por_id" TEXT,
    "retirada_em" TIMESTAMP(3),
    "retirada_por_id" TEXT,
    "retirada_obs" TEXT,
    "devolucao_em" TIMESTAMP(3),
    "devolucao_por_id" TEXT,
    "devolucao_condicao" "CondicaoDevolucao",
    "devolucao_condicao_texto_legado" TEXT,
    "devolucao_obs" TEXT,
    "nao_retirada_em" TIMESTAMP(3),
    "nao_retirada_por_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "solicitacoes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "solicitacoes_numero_key" ON "solicitacoes"("numero");
CREATE INDEX "solicitacoes_status_idx" ON "solicitacoes"("status");
CREATE INDEX "solicitacoes_data_idx" ON "solicitacoes"("data");
CREATE INDEX "solicitacoes_solicitante_id_idx" ON "solicitacoes"("solicitante_id");
CREATE INDEX "solicitacoes_gestor_id_idx" ON "solicitacoes"("gestor_id");
CREATE INDEX "solicitacoes_tipo_emprestimo_idx" ON "solicitacoes"("tipo_emprestimo");
CREATE INDEX "solicitacoes_origem_idx" ON "solicitacoes"("origem");

ALTER TABLE "solicitacoes" ADD CONSTRAINT "solicitacoes_solicitante_id_fkey" FOREIGN KEY ("solicitante_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "solicitacoes" ADD CONSTRAINT "solicitacoes_criado_por_id_fkey" FOREIGN KEY ("criado_por_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "solicitacoes" ADD CONSTRAINT "solicitacoes_gestor_id_fkey" FOREIGN KEY ("gestor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- =============================================================================
-- ITENS PATRIMONIAIS DA SOLICITAÇÃO (N:N solicitacao <-> patrimonio)
-- =============================================================================

CREATE TABLE "itens_patrimonio_solicitacao" (
    "id" TEXT NOT NULL,
    "solicitacao_id" TEXT NOT NULL,
    "patrimonio_id" TEXT NOT NULL,
    "com_dominio" BOOLEAN,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "itens_patrimonio_solicitacao_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "itens_patrimonio_solicitacao_solicitacao_id_patrimonio_id_key" ON "itens_patrimonio_solicitacao"("solicitacao_id", "patrimonio_id");
CREATE INDEX "itens_patrimonio_solicitacao_patrimonio_id_idx" ON "itens_patrimonio_solicitacao"("patrimonio_id");

ALTER TABLE "itens_patrimonio_solicitacao" ADD CONSTRAINT "itens_patrimonio_solicitacao_solicitacao_id_fkey" FOREIGN KEY ("solicitacao_id") REFERENCES "solicitacoes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "itens_patrimonio_solicitacao" ADD CONSTRAINT "itens_patrimonio_solicitacao_patrimonio_id_fkey" FOREIGN KEY ("patrimonio_id") REFERENCES "patrimonios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================================
-- ITENS DE PAPELARIA (sem estoque)
-- =============================================================================

CREATE TABLE "itens_papelaria" (
    "id" TEXT NOT NULL,
    "solicitacao_id" TEXT NOT NULL,
    "descricao" TEXT NOT NULL,
    "quantidade" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "itens_papelaria_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "itens_papelaria_solicitacao_id_idx" ON "itens_papelaria"("solicitacao_id");

ALTER TABLE "itens_papelaria" ADD CONSTRAINT "itens_papelaria_solicitacao_id_fkey" FOREIGN KEY ("solicitacao_id") REFERENCES "solicitacoes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- SERVIÇOS / MOVIMENTAÇÕES (Fase 3) — catálogo administrável de serviços
-- realizados pelo Patrimônio (mesmo padrão de categorias_patrimonio) e os
-- itens de serviço vinculados a cada solicitação. Etapa
-- chore/v1-release-consistency: tabelas já existentes em prisma/schema.prisma
-- e usadas em produção (POST /api/solicitacoes, GET /api/tipos-servico),
-- ausentes deste script até esta correção — ver docs/BANCO_DE_DADOS.md.
-- =============================================================================

CREATE TABLE "tipos_servico" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "descricao" TEXT,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "ordem" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tipos_servico_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tipos_servico_nome_key" ON "tipos_servico"("nome");
CREATE INDEX "tipos_servico_ativo_idx" ON "tipos_servico"("ativo");

CREATE TABLE "itens_servico_solicitacao" (
    "id" TEXT NOT NULL,
    "solicitacao_id" TEXT NOT NULL,
    "tipo_servico_id" TEXT NOT NULL,
    "quantidade" INTEGER,
    "ambiente" TEXT,
    "observacao" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "itens_servico_solicitacao_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "itens_servico_solicitacao_solicitacao_id_idx" ON "itens_servico_solicitacao"("solicitacao_id");
CREATE INDEX "itens_servico_solicitacao_tipo_servico_id_idx" ON "itens_servico_solicitacao"("tipo_servico_id");

ALTER TABLE "itens_servico_solicitacao" ADD CONSTRAINT "itens_servico_solicitacao_solicitacao_id_fkey" FOREIGN KEY ("solicitacao_id") REFERENCES "solicitacoes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "itens_servico_solicitacao" ADD CONSTRAINT "itens_servico_solicitacao_tipo_servico_id_fkey" FOREIGN KEY ("tipo_servico_id") REFERENCES "tipos_servico"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================================
-- ASSINATURAS (1:1 com solicitação)
-- =============================================================================

CREATE TABLE "assinaturas" (
    "id" TEXT NOT NULL,
    "solicitacao_id" TEXT NOT NULL,
    "link" TEXT,
    "enviado_por_id" TEXT,
    "enviado_em" TIMESTAMP(3),
    "confirmada_por_id" TEXT,
    "confirmada_em" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assinaturas_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "assinaturas_solicitacao_id_key" ON "assinaturas"("solicitacao_id");

ALTER TABLE "assinaturas" ADD CONSTRAINT "assinaturas_solicitacao_id_fkey" FOREIGN KEY ("solicitacao_id") REFERENCES "solicitacoes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "assinaturas" ADD CONSTRAINT "assinaturas_enviado_por_id_fkey" FOREIGN KEY ("enviado_por_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "assinaturas" ADD CONSTRAINT "assinaturas_confirmada_por_id_fkey" FOREIGN KEY ("confirmada_por_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- =============================================================================
-- HISTÓRICO / TIMELINE (auditoria, imutável pela interface)
-- =============================================================================

CREATE TABLE "historico_solicitacoes" (
    "id" TEXT NOT NULL,
    "solicitacao_id" TEXT NOT NULL,
    "usuario_id" TEXT,
    "acao" TEXT NOT NULL,
    "status_anterior" TEXT,
    "status_novo" TEXT,
    "descricao" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "historico_solicitacoes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "historico_solicitacoes_solicitacao_id_idx" ON "historico_solicitacoes"("solicitacao_id");

ALTER TABLE "historico_solicitacoes" ADD CONSTRAINT "historico_solicitacoes_solicitacao_id_fkey" FOREIGN KEY ("solicitacao_id") REFERENCES "solicitacoes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "historico_solicitacoes" ADD CONSTRAINT "historico_solicitacoes_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- =============================================================================
-- NOTIFICAÇÕES
-- =============================================================================

CREATE TABLE "notificacoes" (
    "id" TEXT NOT NULL,
    "usuario_id" TEXT NOT NULL,
    "solicitacao_id" TEXT,
    "titulo" TEXT NOT NULL,
    "mensagem" TEXT NOT NULL,
    "link" TEXT,
    "tipo" TEXT,
    "lida" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notificacoes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "notificacoes_usuario_id_lida_idx" ON "notificacoes"("usuario_id", "lida");

ALTER TABLE "notificacoes" ADD CONSTRAINT "notificacoes_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notificacoes" ADD CONSTRAINT "notificacoes_solicitacao_id_fkey" FOREIGN KEY ("solicitacao_id") REFERENCES "solicitacoes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- E-MAIL (Etapa D.1) — infraestrutura de rastreabilidade/idempotência de
-- envios. Nenhuma rota de negócio grava registros aqui ainda.
-- =============================================================================

CREATE TYPE "TipoEmailEvento" AS ENUM (
  'SOLICITACAO_AGUARDANDO_GESTOR',
  'SOLICITACAO_AGUARDANDO_PATRIMONIO',
  'ASSINATURA_PENDENTE',
  'RESERVA_CONFIRMADA',
  'PRONTA_RETIRADA',
  'NAO_RETIRADA',
  'CANCELAMENTO',
  'REJEICAO_GESTOR',
  'REJEICAO_PATRIMONIO'
);

-- PROCESSANDO (Etapa D.2): estado de claim exclusivo do outbox. OBSOLETO
-- (Etapa D.2 — correção pós-Codex-Review): evento cuja condição de negócio
-- deixou de ser verdadeira antes do envio. SUPRIMIDO (Fluxo Patrimonial —
-- Demo): envio físico desligado por EMAIL_PROVIDER=disabled. Ver
-- src/lib/email/processar-evento.ts.
CREATE TYPE "StatusEmailEvento" AS ENUM ('PENDENTE', 'PROCESSANDO', 'ENVIADO', 'FALHA', 'OBSOLETO', 'SUPRIMIDO');

CREATE TABLE "email_eventos" (
    "id" TEXT NOT NULL,
    "solicitacao_id" TEXT NOT NULL,
    "tipo" "TipoEmailEvento" NOT NULL,
    "destinatario" TEXT NOT NULL,
    "status" "StatusEmailEvento" NOT NULL DEFAULT 'PENDENTE',
    "tentativas" INTEGER NOT NULL DEFAULT 0,
    "erro" TEXT,
    "enviado_em" TIMESTAMP(3),
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_eventos_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "email_eventos_solicitacao_id_tipo_destinatario_key" ON "email_eventos"("solicitacao_id", "tipo", "destinatario");
CREATE INDEX "email_eventos_solicitacao_id_idx" ON "email_eventos"("solicitacao_id");
CREATE INDEX "email_eventos_status_idx" ON "email_eventos"("status");

ALTER TABLE "email_eventos" ADD CONSTRAINT "email_eventos_solicitacao_id_fkey" FOREIGN KEY ("solicitacao_id") REFERENCES "solicitacoes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- FIM DO SCRIPT
-- =============================================================================
