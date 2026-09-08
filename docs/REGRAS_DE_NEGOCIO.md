# Regras de Negócio — Fluxo Patrimonial

Todas as regras abaixo foram confirmadas diretamente no código (`src/lib/status.ts`, `src/lib/prazo.ts`, `src/lib/validations.ts`, `src/middleware.ts`, `src/lib/permissions.ts` e as API Routes de cada ação). Nenhuma é intenção futura.

## Perfis

- **Colaborador**: perfil padrão de cadastro público. Cria/acompanha suas solicitações.
- **Gestor**: não é um valor de `permissao` — é a flag `podeSerGestor` em `User`, que qualquer colaborador pode ter. Aparece como destinatário de aprovação apenas em solicitações **externas**.
- **Patrimônio** (`permissao = 'patrimonio'`): confirma/rejeita solicitações, gerencia bens, opera separação/retirada/devolução/não-retirado, vê "Todas as Solicitações" e "Pendências".
- **Administrador** (`permissao = 'administrador'`): tudo que Patrimônio faz + gerencia categorias e colaboradores.

`isPatrimonioOuAdmin()` = `permissao === 'patrimonio' || permissao === 'administrador'`. `isAdmin()` = `permissao === 'administrador'`.

## Contas de colaborador (Etapa `fix/collaborator-session-sync`)

- **Domínio de e-mail permitido, configurável e fail-closed**: toda conta `User` — criada por cadastro público (`POST /api/auth/cadastro`) ou pelo Administrador (`POST /api/colaboradores`) — só aceita e-mail terminado EXATAMENTE num dos domínios listados em `ALLOWED_EMAIL_DOMAINS` (`emailPermitidoSchema`, `src/lib/validations.ts`). Sem essa variável configurada (ausente, vazia ou inválida), NENHUM e-mail é aceito — nunca libera geral por omissão. Normalizado (trim + minúsculas) antes de validar/persistir/comparar em qualquer rota (criação, edição, login).
- **Administrador pode editar nome e e-mail de qualquer colaborador** (`PATCH /api/colaboradores/[id]`), incluindo os próprios. Mudar o e-mail (ou qualquer outro campo sensível) da PRÓPRIA conta encerra a sessão atual do admin — precisa entrar de novo com o novo e-mail.
- **Um Administrador não pode desativar a própria conta** — bloqueado no backend (`400`), não só por um botão desabilitado na tela.
- **Ativar/desativar colaborador** é reservado ao Administrador, pela mesma rota de edição. Um usuário desativado (`ativo = false`) não consegue autenticar (mesma mensagem genérica de credenciais inválidas — nunca revela que a conta existe mas está desativada).

## Solicitação interna

Nasce em `AGUARDANDO_PATRIMONIO` — sem gestor, sem aprovação prévia. Campo **Ambiente** é obrigatório (validado tanto na UI quanto no schema Zod do backend — não é possível burlar via payload manipulado). Ao ser confirmada pelo Patrimônio, vai **direto** para `EM_SEPARACAO` (sem etapa de assinatura).

## Solicitação externa

Nasce em `AGUARDANDO_GESTOR`. Campos **Atividade, Local, Cidade e Gestor** são obrigatórios. Após aprovação do gestor, passa a `AGUARDANDO_PATRIMONIO`. Ao ser confirmada pelo Patrimônio, vai para `AGUARDANDO_ENVIO_ASSINATURA` (nunca direto para separação) — precisa passar pela etapa de assinatura antes de `EM_SEPARACAO`/`PRONTA_RETIRADA`.

## Atendimento imediato

Registrado por Patrimônio/Administrador (nunca por colaborador comum — validado no backend, não só na UI) para um atendimento que já está ocorrendo. Sempre tratado como `tipoEmprestimo: 'interno'`, independente do valor enviado. **Sem gestor, sem cálculo de prazo/antecedência** (campos `prazoHoras`/`antecedenciaMinutos`/`dentroDoPrazo` ficam `null`). Status inicial: `EM_UTILIZACAO` se há bem patrimonial selecionado, ou `FINALIZADA` diretamente se for só papelaria/serviço (já nasce "resolvido" — não há decisão pendente). Campo **Ambiente** da solicitação não existe nesse formulário (só o "ambiente" por item de serviço, campo diferente).

## Patrimônios

Cadastro com número (único), marca, modelo, categoria e status ativo/inativo. Exclusão real só quando o bem nunca foi usado em nenhuma solicitação; caso contrário, é inativado (nunca perde o número de patrimônio nem quebra o histórico de solicitações antigas).

## Papelaria

Item livre (descrição + quantidade), sem catálogo pré-cadastrado. Quantidade deve ser inteiro positivo.

## Serviços

Catálogo administrável (`TipoServico`, com nome/ativo/ordem). Cada item de serviço na solicitação exige tipo, quantidade (inteiro ≥ 1) e **ambiente/local obrigatório**; observação é opcional.

## Domínio

Propriedade da **solicitação como um todo** (não de cada bem individualmente) — só relevante quando há pelo menos um bem de categoria "Notebook" selecionado. Se `notebooksComDominio = true`, o tipo de domínio (`EDUCACIONAL` ou `ADMINISTRATIVO`) é obrigatório. Sem notebook selecionado, ou com domínio desligado, os campos são sempre normalizados para `null` — nunca inferidos.

## Ambiente

Obrigatório apenas para: fluxo interno (campo da solicitação) e itens de serviço (campo por item, em qualquer fluxo). Nunca obrigatório no fluxo externo (usa Local/Cidade em vez disso) nem no formulário de Atendimento Imediato como um todo.

## Períodos

Três períodos fixos, com horário de início oficial (horário de Brasília, offset fixo -3h, sem horário de verão desde 2019):

| Período | Início | Fim (só para sugestão do Atendimento Imediato) |
|---|---|---|
| `MANHA` | 08:00 | 12:00 |
| `TARDE` | 13:30 | 17:30 |
| `NOITE` | 19:00 | 22:30 |

Reserva antecipada aceita um ou mais períodos por solicitação; Atendimento Imediato aceita **exatamente um**.

## Antecedência

Prazo mínimo recomendado, calculado uma única vez na criação e nunca recalculado depois:

- **Interno**: **48 horas** de antecedência.
- **Externo**: **72 horas** de antecedência.
- **Atendimento imediato**: não se aplica (campos de prazo ficam `null`).

A referência de antecedência é a data da solicitação + horário de **início** do período mais cedo selecionado. Se a solicitação for enviada fora do prazo recomendado, a UI exibe um aviso e pede confirmação — mas o backend **não bloqueia** o envio; `dentroDoPrazo = false` só fica registrado para fins de indicador/relatório.

## Solicitar para outro colaborador

Ao criar uma solicitação (interna ou externa; não se aplica ao Atendimento Imediato, que já é registrado em nome de terceiro por natureza — ver seção própria), o campo `solicitanteId` define quem é o titular da solicitação, e pode ser diferente de quem está efetivamente enviando o formulário (`criadoPorId`, sempre o usuário autenticado). Regra de autorização (validada no backend, nunca só escondendo a opção na UI):

| Perfil | Solicitar para si | Solicitar para outro colaborador |
|---|---|---|
| Colaborador comum (`podeSolicitarParaOutro = false`) | Sim | **Não** |
| Colaborador com a capacidade `podeSolicitarParaOutro = true` | Sim | Sim |
| Gestor (permissão adicional `podeSerGestor`) | Sim | Sim |
| Patrimônio | Sim | Sim |
| Administrador | Sim | Sim |

Quando `solicitanteId` é omitido no payload, a rota usa o próprio usuário autenticado. Uma tentativa não autorizada de informar o `solicitanteId` de outro usuário é rejeitada com `403`, sem nenhum efeito colateral (nenhuma solicitação, item, histórico, notificação ou e-mail é criado) — a decisão usa exclusivamente as claims da sessão (JWT já validado: `permissao`, `podeSerGestor`, `podeSolicitarParaOutro`), nunca um valor recebido no corpo da requisição.

### Perfil vs. capacidade

`podeSolicitarParaOutro` é uma **capacidade individual**, não um perfil/role novo e não uma variação de `permissao`. Existe para o caso real de um colaborador comum (ex.: apoio técnico de uma unidade) que precisa registrar solicitações em nome de terceiros sem receber nenhuma das demais atribuições de Gestor/Patrimônio/Administrador — a capacidade **só** habilita `solicitanteId != session.id` em `POST /api/solicitacoes`; não libera aprovação de gestor, não libera nenhuma tela/rota de Patrimônio ou Administração, e não libera Atendimento Imediato (que continua exclusivo de Patrimônio/Administrador — ver seção "Atendimento imediato"). Concedida individualmente, por colaborador, exclusivamente por um Administrador (tela Colaboradores → editar → "Pode solicitar para outro colaborador"), desligada por padrão. Nunca reaproveita `podeSerGestor` — são campos e decisões independentes.

## Gestor

Só existe no fluxo externo. Aprova ou rejeita (com motivo obrigatório, mínimo 3 caracteres) apenas solicitações atribuídas a ele (`gestorId === session.id` — verificado no backend, um gestor não pode agir sobre solicitação de outro via URL direta).

## Aprovação do Patrimônio

Confirma ou rejeita (motivo obrigatório) qualquer solicitação em `AGUARDANDO_PATRIMONIO`, interna ou externa. Confirmação interna → `EM_SEPARACAO`; confirmação externa → `AGUARDANDO_ENVIO_ASSINATURA`.

## Assinatura

Exclusiva do fluxo externo. Patrimônio envia (ou reenvia) um link de assinatura (URL válida, obrigatória) → status `AGUARDANDO_ASSINATURA`. O solicitante confirma manualmente "Concluí a assinatura" (ou o próprio Patrimônio pode validar manualmente) → `ASSINATURA_CONFIRMADA`. Não há integração automática com nenhum sistema de assinatura eletrônica — a confirmação é sempre uma ação manual de alguém no sistema.

## Separação

Patrimônio registra que os itens foram separados fisicamente → `PRONTA_RETIRADA`. Aceita como origem `CONFIRMADA`, `ASSINATURA_CONFIRMADA` ou `EM_SEPARACAO` (mesma rota atende os dois fluxos).

## Pronta para retirada

Estado intermediário entre separação e retirada física. A partir daqui, o sistema passa a considerar que a "referência de utilização" (data + início do período) pode vencer sem o solicitante ter retirado — habilitando a ação de marcar como não retirado.

## Retirada

Patrimônio registra a retirada física → `EM_UTILIZACAO`. Observações opcionais.

## Devolução

Só a partir de `EM_UTILIZACAO` → `FINALIZADA`. Exige **condição estruturada** obrigatória (`SEM_AVARIAS`, `COM_AVARIA`, `DANIFICADO`, `NECESSITA_VERIFICACAO`); observação é obrigatória para qualquer condição diferente de `SEM_AVARIAS` (precisa descrever o problema). Devoluções registradas antes desta regra mantêm o texto livre original em um campo legado separado, nunca reinterpretado como uma das opções estruturadas.

## Não retirado

Exclusiva de Patrimônio/Administrador, só disponível a partir de `PRONTA_RETIRADA` **depois** que a referência de utilização (data + início do período) já passou — a UI só oferece a ação nesse momento, mas o backend também valida a condição de tempo, não confia só na UI. Estado terminal, distinto de cancelamento (decisão operacional posterior à separação, não uma decisão prévia).

## Cancelamento

Permitido ao solicitante (enquanto a solicitação ainda não estiver finalizada/em utilização) ou a Patrimônio/Administrador, a partir de qualquer status que ainda permita cancelamento (`AGUARDANDO_GESTOR`, `AGUARDANDO_PATRIMONIO`, `CONFIRMADA`, `AGUARDANDO_ENVIO_ASSINATURA`, `AGUARDANDO_ASSINATURA`, `ASSINATURA_CONFIRMADA`, `EM_SEPARACAO`, `PRONTA_RETIRADA`). Não é possível cancelar a partir de `EM_UTILIZACAO` (só existe o caminho para `FINALIZADA`).

## Histórico

Todo evento relevante (criação, aprovação, rejeição, confirmação, separação, retirada, devolução, não retirado, cancelamento) gera um registro imutável em `HistoricoSolicitacao`, sempre dentro da mesma transaction da ação que o originou — nunca criado separadamente, nunca editado depois.

## Notificações internas

Notificações in-app (`Notificacao`) são sempre **individuais**, uma por usuário destinatário — nunca uma cópia de e-mail. Continuam sendo criadas para cada membro ativo da equipe Patrimônio quando aplicável, mesmo depois da mudança de e-mail para caixa de grupo (ver seção seguinte).

## E-mails

Cada evento relevante pode gerar um ou mais `EmailEvento`. Matriz atual (destinatários confirmados em cada rota de origem):

| Evento | Destinatário(s) | Quando é disparado |
|---|---|---|
| `SOLICITACAO_AGUARDANDO_GESTOR` | Gestor atribuído | Criação de solicitação externa |
| `SOLICITACAO_AGUARDANDO_PATRIMONIO` | Caixa de grupo do Patrimônio | Criação de solicitação interna, **ou** aprovação do gestor em solicitação externa |
| `ASSINATURA_PENDENTE` | Solicitante | Envio ou reenvio do link de assinatura |
| `RESERVA_CONFIRMADA` | Solicitante + caixa de grupo do Patrimônio | Confirmação do Patrimônio (fluxo interno) **ou** confirmação de assinatura (fluxo externo) |
| `PRONTA_RETIRADA` | Solicitante | Registro de separação |
| `NAO_RETIRADA` | Solicitante | Registro de "não retirado" |
| `CANCELAMENTO` | Solicitante + caixa de grupo do Patrimônio (só se o status anterior já indicava envolvimento operacional do Patrimônio: `ASSINATURA_CONFIRMADA`, `EM_SEPARACAO` ou `PRONTA_RETIRADA`) | Cancelamento |
| `REJEICAO_GESTOR` | Solicitante | Rejeição pelo gestor |
| `REJEICAO_PATRIMONIO` | Solicitante | Rejeição pelo Patrimônio |

**Sobre o Patrimônio**: usuários com `permissao = 'patrimonio'` continuam existindo individualmente no sistema (login próprio, notificações in-app individuais). Apenas o **e-mail operacional** — o que sai fisicamente do sistema — vai para uma única caixa de grupo configurada por `EMAIL_PATRIMONIO_RECIPIENT`, nunca um e-mail por usuário. Ver `docs/EMAILS.md` para o detalhamento completo.
