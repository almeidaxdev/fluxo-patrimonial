# Banco de Dados — Fluxo Patrimonial

[← Documentação](README.md)

PostgreSQL (Supabase), acessado exclusivamente via Prisma. Fonte de verdade estrutural: `prisma/schema.prisma` + `prisma/consolidated.sql`. Este documento descreve o schema atual — não é um changelog nem uma proposta de evolução.

## Modelos

### User
Colaboradores, gestores, equipe Patrimônio e administradores — um único modelo para todos os perfis. Campos principais: `nome`, `email` (único; só aceita domínio permitido (ALLOWED_EMAIL_DOMAINS) `@example.com`, normalizado trim+lowercase antes de persistir/comparar — regra de aplicação, `emailPermitidoSchema` em `src/lib/validations.ts`, não uma constraint de banco; ver `docs/REGRAS_DE_NEGOCIO.md`, seção "Contas de colaborador"), `senha` (hash bcrypt), `permissao` (`Permissao`), `podeSerGestor` (bool — habilita o usuário como destinatário de aprovação no fluxo externo), `podeSolicitarParaOutro` (bool, `@default(false)` — capacidade individual, independente de `permissao`/`podeSerGestor`, que só habilita `solicitanteId != session.id` em `POST /api/solicitacoes`), `ativo` (bool — usuário inativado não é removido, preserva histórico de solicitações/aprovações antigas; Admin não pode desativar a própria conta), `versaoSessao` (`Int`, `@default(0)` — contador de versionamento de sessão; incrementado a cada mudança de segurança relevante no usuário — senha, `ativo`, `permissao`, `podeSerGestor`, `podeSolicitarParaOutro`, `email` — ver `docs/ARQUITETURA.md`, seção "Revogação de sessão"). Relações: autor de `Solicitacao` (solicitante), gestor atribuído em `Solicitacao`, destinatário de `Notificacao`.

### CategoriaPatrimonio
Categorias de bens (ex.: Notebook, Projetor). Campos: `nome`, `ativo`. `ativo = false` remove a categoria das opções de novo cadastro sem quebrar bens já categorizados.

### Patrimonio
Bem patrimonial individual. Campos: `numeroPatrimonio` (único), `marca`, `modelo`, `categoriaId`, `ativo`. Relação: `ItemPatrimonioSolicitacao` (histórico de uso em solicitações).

### Solicitacao
Entidade central — representa uma reserva/atendimento completo, do pedido inicial ao encerramento. Campos agrupados por finalidade:
- **Identificação/origem**: `tipoEmprestimo` (`interno`/`externo`), `origem` (`RESERVA`/`ATENDIMENTO_IMEDIATO`), `solicitanteId`.
- **Contexto do pedido**: `ambiente` (interno), `atividade`/`local`/`cidade` (externo), `gestorId` (externo), `notebooksComDominio`/`tipoDominio`.
- **Agendamento**: data(s) e período(s) selecionados, `prazoHoras`, `antecedenciaMinutos`, `dentroDoPrazo` (`null` em atendimento imediato).
- **Status**: `status` (`StatusSolicitacao`), único campo que rege toda a máquina de estados (`src/lib/status.ts`).
- **Decisão do gestor**: `gestorAprovadoEm`, `motivoRejeicaoGestor`.
- **Decisão do Patrimônio**: `patrimonioConfirmadoEm`, `motivoRejeicaoPatrimonio`.
- **Assinatura**: `linkAssinatura`, `assinaturaEnviadaEm`, `assinaturaConfirmadaEm`.
- **Operacional**: `separadoEm`, `retiradoEm`, `observacoesRetirada`, `devolvidoEm`, `condicaoDevolucao` (`CondicaoDevolucao`), `observacoesDevolucao`, `devolucaoCondicaoTextoLegado` (texto livre pré-migração, nunca reinterpretado como uma condição estruturada), `naoRetiradoEm`.
- **Cancelamento**: `canceladoEm`, `canceladoPorId`, `motivoCancelamento`.

Relações: `ItemPatrimonioSolicitacao[]`, `ItemPapelaria[]`, `ItemServicoSolicitacao[]`, `Assinatura?`, `HistoricoSolicitacao[]`, `EmailEvento[]`.

### ItemPatrimonioSolicitacao
Associa bens patrimoniais a uma solicitação. Unique `[solicitacaoId, patrimonioId]` — um mesmo bem não pode aparecer duas vezes na mesma solicitação.

### ItemPapelaria
Item de papelaria livre por solicitação: `descricao`, `quantidade`.

### TipoServico
Catálogo de tipos de serviço/movimentação, sem rota de mutação nesta base: `nome`, `ativo`, `ordem` (ordenação de exibição).

### ItemServicoSolicitacao
Item de serviço vinculado a uma solicitação: `tipoServicoId`, `quantidade`, `ambiente` (obrigatório), `observacao` (opcional).

### Assinatura
Registro da assinatura de um empréstimo externo. Unique por `solicitacaoId` (uma assinatura por solicitação). Campos refletem o link enviado e a confirmação — espelham, em parte, os campos de assinatura já presentes em `Solicitacao` (não há dado de assinatura fora desses dois lugares).

### HistoricoSolicitacao
Trilha de auditoria imutável: um registro por evento relevante (`acao`, `usuarioId`, `detalhes`, `criadoEm`). Sempre escrito dentro da mesma transaction da ação que o originou.

### Notificacao
Notificação in-app individual: `usuarioId`, `titulo`, `mensagem`, `lida` (bool), `solicitacaoId` (referência opcional). Uma linha por destinatário — nunca compartilhada entre usuários.

### EmailEvento
Outbox de e-mail transacional. Campos: `solicitacaoId`, `tipo` (`TipoEmailEvento`), `destinatario`, `status` (`StatusEmailEvento`), `payload` (`Json?` — snapshot dos dados necessários para reconstruir o e-mail, usado por eventos como `RESERVA_CONFIRMADA` que precisam do estado da solicitação no momento do envio, não no momento de uma eventual reconsulta), `tentativas`, timestamps de criação/processamento. Unique `[solicitacaoId, tipo, destinatario]` — garante no máximo um evento por combinação, mesmo que a ação que o dispara seja tentada mais de uma vez.

## Enums

| Enum | Valores |
|---|---|
| `Permissao` | `colaborador`, `patrimonio`, `administrador` |
| `TipoEmprestimo` | `interno`, `externo` |
| `PeriodoSolicitacao` | `MANHA`, `TARDE`, `NOITE` |
| `StatusSolicitacao` | `AGUARDANDO_GESTOR`, `REJEITADA_GESTOR`, `AGUARDANDO_PATRIMONIO`, `REJEITADA_PATRIMONIO`, `CONFIRMADA`, `AGUARDANDO_ENVIO_ASSINATURA`, `AGUARDANDO_ASSINATURA`, `ASSINATURA_CONFIRMADA`, `EM_SEPARACAO`, `PRONTA_RETIRADA`, `EM_UTILIZACAO`, `FINALIZADA`, `CANCELADA`, `NAO_RETIRADA` |
| `OrigemSolicitacao` | `RESERVA`, `ATENDIMENTO_IMEDIATO` |
| `CondicaoDevolucao` | `SEM_AVARIAS`, `COM_AVARIA`, `DANIFICADO`, `NECESSITA_VERIFICACAO` |
| `TipoDominio` | `EDUCACIONAL`, `ADMINISTRATIVO` |
| `TipoEmailEvento` | `SOLICITACAO_AGUARDANDO_GESTOR`, `SOLICITACAO_AGUARDANDO_PATRIMONIO`, `ASSINATURA_PENDENTE`, `RESERVA_CONFIRMADA`, `PRONTA_RETIRADA`, `NAO_RETIRADA`, `CANCELAMENTO`, `REJEICAO_GESTOR`, `REJEICAO_PATRIMONIO` |
| `StatusEmailEvento` | `PENDENTE`, `PROCESSANDO`, `ENVIADO`, `FALHA`, `OBSOLETO`, `SUPRIMIDO` |

## Integridade / constraints

- `User.email`, `Patrimonio.numeroPatrimonio` — únicos.
- `ItemPatrimonioSolicitacao[solicitacaoId, patrimonioId]` — único (sem duplicar bem na mesma solicitação).
- `Assinatura.solicitacaoId` — único (uma assinatura por solicitação).
- `EmailEvento[solicitacaoId, tipo, destinatario]` — único (base da idempotência do outbox, ver `docs/EMAILS.md`).
- Toda transição de `Solicitacao.status` é feita via `updateMany` condicionado ao status exato anterior (proteção de concorrência a nível de aplicação — ver `docs/ARQUITETURA.md`, seção Concorrência), não uma constraint de banco.
- Inativação (`ativo = false`) é preferida a exclusão física para `User`, `CategoriaPatrimonio`, `Patrimonio` e `TipoServico` sempre que o registro já tem histórico associado, para não quebrar `HistoricoSolicitacao`/relatórios antigos.

## Data API e RLS

A aplicação **não utiliza a Data API do Supabase (PostgREST/GraphQL)**. A opção de mantê-la desabilitada é uma configuração externa registrada na documentação original, não uma garantia imposta pelo código; o único caminho de acesso é o Prisma, via conexão Postgres direta (`DATABASE_URL`/`DIRECT_URL`, role de servidor). Por isso, **RLS (Row Level Security) não é usado como mecanismo de autorização** em nenhuma tabela — a autorização é inteiramente responsabilidade do backend Next.js (JWT próprio, `src/lib/permissions.ts`, checagem em cada rota de API — ver `docs/ARQUITETURA.md` e `docs/REGRAS_DE_NEGOCIO.md`), não de policies de banco. RLS habilitado não teria efeito sobre o Prisma de qualquer forma, já que a role de conexão do Prisma não é `anon`/`authenticated` (as roles que a Data API usaria).

Se a Data API for reativada no futuro por qualquer motivo, isso **não deve ser feito apenas para contornar outra configuração** — antes de expor qualquer tabela, é necessário desenhar e aplicar RLS + grants explícitos por tabela (nunca uma policy genérica `USING (true)` só para silenciar o Security Advisor).

## Processo de alteração

Este projeto **não usa `prisma migrate`/`prisma db push`/`prisma migrate reset`** em nenhuma etapa do fluxo — nem para criar a estrutura inicial, nem para alterá-la depois. `prisma/consolidated.sql` é a única fonte da estrutura completa e sempre reflete exatamente o que está em `schema.prisma`.

Recomendação para quem for evoluir o schema neste projeto:

1. Planeje e revise a alteração antes de aplicá-la — em qualquer banco que já tenha dados reais, prefira mudanças **aditivas** (nova coluna opcional, novo valor de enum, nova tabela) a mudanças destrutivas (remover coluna, renomear, alterar tipo).
2. Atualize `schema.prisma` e, em seguida, `prisma/consolidated.sql` (mantendo os dois sempre em sincronia — é a única fonte da estrutura neste projeto).
3. Aplique a alteração manualmente (SQL Editor do banco escolhido), nunca por um comando automático de migração/deploy.
4. Rode `npx prisma generate` para atualizar o Prisma Client.

Este documento não publica valores de secrets ou conexões reais. Consulte [Variáveis de ambiente](VARIAVEIS_AMBIENTE.md) para configurar um banco próprio.

## Dataset demonstrativo

O seed e o reset compartilham [src/lib/demo/dataset.ts](../src/lib/demo/dataset.ts). Os dados são fictícios. O reset transacional da demo é uma operação separada da criação estrutural pelo SQL consolidado. E-mails suprimidos pelo provedor `disabled` são registrados como `SUPRIMIDO`, sem indicar entrega real.
