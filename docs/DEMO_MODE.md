# Modo Demo

[← Documentação](README.md) · [Acessar demonstração](https://fluxo-patrimonial-demo.vercel.app)

A demonstração pública do Fluxo Patrimonial utiliza banco separado e dados fictícios. Permite avaliar a interface e o fluxo operacional sem cadastrar uma conta ou informar credenciais.

## Estado da demonstração

Configuração atual informada como validada pelo mantenedor em 11/09/2026:

| Item | Configuração |
|---|---|
| Acesso | Botão **Acessar demonstração**, com conta pública compartilhada |
| Dados | Dataset fictício, seed funcional e restauração periódica |
| Administração | Dados mestres somente leitura; autocadastro indisponível |
| E-mails | `EMAIL_PROVIDER=disabled`; nenhum envio externo |
| Reset automático | Vercel Cron: `0 6 * * *` — 06:00 UTC, aproximadamente 03:00 em Brasília |
| Autenticação do cron | `CRON_SECRET` via `Authorization: Bearer` |
| Reset manual | Credencial separada: `DEMO_RESET_SECRET` |
| Firewall de borda | `POST /api/solicitacoes`: 10 requisições / 60 segundos / IP |
| Limite adicional | `DEMO_MAX_SOLICITACOES=200` |

O estado do painel da Vercel não é definido integralmente por arquivos deste repositório. A configuração de borda acima é distinta da regra consumida pelo SDK descrita adiante.

## Acesso público

`POST /api/demo/entrar` estabelece uma sessão usando o mesmo mecanismo JWT do login normal, na conta indicada por `DEMO_ACCOUNT_EMAIL`. Não retorna senha ou hash ao visitante. Fora de `DEMO_MODE=true`, responde `404`.

A conta é compartilhada: solicitações criadas por visitantes podem aparecer para outros visitantes. Os registros da demonstração não devem conter dados pessoais reais. O reset descarta alterações transacionais.

## Dados mestres somente leitura

`assertDemoActionAllowed()`, em [demo-mode.ts](../src/lib/demo-mode.ts), bloqueia as mutações no servidor com `403`, inclusive para a conta administradora.

| Recurso | Comportamento na demo |
|---|---|
| Colaboradores | Consulta disponível; criação, edição e exclusão bloqueadas |
| Bens patrimoniais | Consulta disponível; criação, edição e exclusão bloqueadas |
| Categorias | Consulta disponível; criação, edição e exclusão bloqueadas |
| Autocadastro | Bloqueado |
| Troca da própria senha | Bloqueada |
| Tipos de serviço | Consulta disponível; não há rota de mutação nesta base |

O visitante pode experimentar solicitações, aprovações/rejeições, separação, retirada, devolução, cancelamento, controle da confirmação de assinatura, atendimento imediato e relatórios, conforme as permissões da conta e as regras de cada estado.

## E-mails desabilitados

`EMAIL_PROVIDER=disabled` seleciona o [provedor sem envio](../src/lib/email/providers/disabled.ts). Nenhuma chamada externa de entrega é feita e nenhuma chave de provedor é exigida nesse modo.

O processamento da outbox registra **SUPRIMIDO**, distinguindo uma mensagem sem envio de **ENVIADO**. `APP_URL` continua necessária para construir links; a caixa de grupo do patrimônio é configurada separadamente para resolução dos destinatários lógicos.

**DEMO_MODE não desabilita e-mails por si só.** A seleção do provedor é independente; a demo pública atual usa explicitamente `disabled`.

## Reset do dataset

O dataset está centralizado em [src/lib/demo/dataset.ts](../src/lib/demo/dataset.ts) e é compartilhado pelo [seed](../prisma/seed.ts) e pela [rota de reset](../src/app/api/internal/demo-reset/route.ts).

O reset remove e recria os registros transacionais — solicitações, itens, histórico, assinaturas, notificações e eventos de e-mail — dentro de uma transação. Os dados mestres são reconciliados pela rotina compartilhada; não são todos apagados. Senhas de usuários já existentes são preservadas.

### Reset automático

O [vercel.json](../vercel.json) agenda `GET /api/internal/demo-reset` diariamente com `0 6 * * *`. Isso corresponde a 06:00 UTC, aproximadamente 03:00 no horário de Brasília; não é promessa de execução no segundo exato.

O handler exige `Authorization: Bearer <CRON_SECRET>`. Secret ausente bloqueia a execução; credencial incorreta não autoriza o reset. A comparação utiliza hashes de tamanho fixo e `timingSafeEqual`.

### Reset manual

`POST /api/internal/demo-reset` exige `DEMO_RESET_SECRET` no header `x-demo-reset-secret`. O utilitário `npm run demo:reset` lê `APP_URL` e `DEMO_RESET_SECRET` do ambiente do processo; ele não carrega `.env.local` automaticamente.

Esse comando é operacional e destrutivo para os registros transacionais da demo. Não faz parte do setup local nem de uma revisão documental.

### Separação de credenciais

- GET aceita a credencial do cron; POST aceita a credencial do reset manual.
- Um secret não substitui o outro.
- Sessão JWT de usuário, inclusive administrador, não autoriza o reset.
- Secrets são transmitidos em headers, nunca em query string.
- Fora do modo Demo, ambos os handlers respondem `404`.
- Ausência do secret correspondente resulta em comportamento fail-closed.
- POST utiliza o helper de rate limiting; GET não utiliza esse helper adicional.

## Proteção contra abuso

### 1. Regra de borda na demo pública

O mantenedor confirmou uma regra ativa do Vercel Firewall para **POST /api/solicitacoes**, com **10 requisições em 60 segundos por IP**.

Ela é configurada no painel da Vercel e atua na borda. Pessoas que compartilham um IP podem compartilhar o limite; sua configuração não deve ser confundida com a chave por sessão da camada seguinte.

### 2. Integração do SDK na aplicação

[rate-limit.ts](../src/lib/rate-limit.ts) utiliza `@vercel/firewall` e o Rate Limit ID `fluxo-patrimonial-sensitive-actions`. Cada ação usa um namespace e um identificador normalizado com hash SHA-256.

O helper é utilizado em login, cadastro, envio/reenvio de link de assinatura, entrada na demo, reset manual e criação de solicitações em modo Demo. Na criação, a chave usa o usuário autenticado; visitantes da conta pública compartilham esse identificador.

A regra correspondente ao SDK precisa ser publicada no painel. Os parâmetros documentados para essa regra são 8 requisições em 600 segundos, e o helper usa `Retry-After: 600`. **A confirmação da regra de borda de 10/60 por IP não comprova a ativação dessa outra regra.**

Em exceções de infraestrutura, o helper retorna `limited: false` (**fail-open**). Regra ausente também pode deixar a limitação do SDK inoperante. Essa camada é uma mitigação, sem garantia absoluta.

### 3. Limite global adicional

Em modo Demo, `POST /api/solicitacoes` consulta a contagem total e recusa novas criações com `429` quando o limite é atingido. A configuração atual é `DEMO_MAX_SOLICITACOES=200`; valor ausente ou inválido usa o padrão 200.

Essa verificação não depende do Firewall. Entretanto, a contagem e a criação não formam uma reserva atômica de capacidade: requisições simultâneas podem ultrapassar o valor. É proteção adicional contra crescimento de dados, não teto estrito sob concorrência.

### 4. Restauração periódica

O reset diário devolve os registros transacionais ao dataset fictício. Ele complementa os limites de requisição e de volume; não substitui autenticação ou autorização.

## Variáveis

Consulte a [referência de variáveis](VARIAVEIS_AMBIENTE.md), que distingue aplicação normal, demo e envio real de e-mails. Valores de secrets não devem aparecer no repositório, em capturas ou na documentação.

## Validação

Há comandos específicos para bloqueios de demo, rotas, limite de solicitações, middleware, cron, dataset e provedor de e-mail desabilitado. O [inventário de testes](TESTES.md) descreve os comandos disponíveis; a existência desses comandos não equivale a evidência de uma execução recente.
