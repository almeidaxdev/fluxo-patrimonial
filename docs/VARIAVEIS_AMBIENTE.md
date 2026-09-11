# Variáveis de ambiente

[← Documentação](README.md) · [Setup local](../README.md#setup-local)

Referência dos nomes utilizados pela aplicação, Prisma e utilitário de reset. Nenhum valor real de credencial é publicado aqui. O arquivo [.env.example](../.env.example) é um modelo com placeholders; alguns comentários históricos nele não refletem todos os recursos atuais.

## Aplicação e banco

| Variável | Obrigatoriedade | Finalidade |
|---|---|---|
| `DATABASE_URL` | Sim para acesso ao banco | Conexão PostgreSQL do Prisma Client |
| `DIRECT_URL` | Configurar para o datasource Prisma | Conexão alternativa sem o pool de transações; não implica executar migrações |
| `JWT_SECRET` | Sim para autenticação | Assinatura/verificação de JWT; mínimo de 32 caracteres, validado quando utilizado |
| `ALLOWED_EMAIL_DOMAINS` | Sim para criação/alteração de e-mail de contas | Domínios exatos permitidos, separados por vírgula; ausência ou configuração sem domínio válido bloqueia cadastros |
| `APP_URL` | Sim para links e para o utilitário de reset | URL base absoluta HTTP/HTTPS, sem query ou fragmento |
| `NODE_ENV` | Definida pelo runtime | Flags de execução, logs do Prisma e cookie seguro em produção |

Supabase é usado como PostgreSQL gerenciado; não é necessário configurar Supabase Auth ou chaves de cliente Supabase para autenticar a aplicação.

## Modo Demo

| Variável | Obrigatoriedade | Finalidade |
|---|---|---|
| `DEMO_MODE` | Opcional | Somente o literal `true` ativa a demo; outros valores preservam o modo normal |
| `DEMO_ACCOUNT_EMAIL` | Opcional | Conta usada no acesso automático; padrão fictício `admin@example.com` |
| `DEMO_MAX_SOLICITACOES` | Opcional | Limite adicional do total de solicitações; inteiro positivo, padrão 200 |
| `CRON_SECRET` | Sim para reset automático | Autentica GET da rota de reset via Bearer |
| `DEMO_RESET_SECRET` | Sim para reset manual | Autentica POST da rota de reset pelo header específico |

As credenciais dos dois mecanismos de reset são independentes. Ausência da credencial exigida bloqueia aquele mecanismo. Nunca use valores da produção na demo.

O modo Demo não desliga e-mails automaticamente: use também `EMAIL_PROVIDER=disabled`. [Funcionamento e proteções](DEMO_MODE.md).

## E-mails

| Variável | Obrigatoriedade | Finalidade |
|---|---|---|
| `EMAIL_PROVIDER` | Sim para processamento de e-mail | `resend` para envio real ou `disabled` para suprimir envio |
| `EMAIL_API_KEY` | Com `resend` | Credencial do provedor; dispensada em `disabled` |
| `EMAIL_FROM_ADDRESS` | Com `resend` | Endereço remetente |
| `EMAIL_FROM_NAME` | Opcional com `resend` | Nome de exibição; padrão Fluxo Patrimonial |
| `EMAIL_REPLY_TO` | Opcional com `resend` | Endereço de resposta |
| `EMAIL_TEST_MODE` | Com `resend` | Literais exatos `true`/`false`; controla redirecionamento para destinatário de teste |
| `EMAIL_TEST_RECIPIENT` | Se `resend` e teste ativo | Destinatário físico autorizado para homologação |
| `EMAIL_PATRIMONIO_RECIPIENT` | Para resolução dos eventos destinados ao patrimônio | Caixa de grupo, validada separadamente do provedor; usar endereço fictício no ambiente sem envio |

Com `disabled`, a configuração do provedor ainda exige `APP_URL`, mas dispensa chave, remetente e configuração de entrega de teste. A resolução dos destinatários lógicos do patrimônio continua separada.

`EMAIL_TEST_MODE=true` redireciona a entrega; não desabilita o envio externo. Para impedir entrega externa, escolha `disabled`. A implementação atual não proíbe `EMAIL_TEST_MODE=true` apenas porque `NODE_ENV=production`.

## Configuração local

1. Copie `.env.example` para **`.env` na raiz**.
2. Preencha `DATABASE_URL` e `DIRECT_URL` com as conexões do seu banco de desenvolvimento.
3. Gere uma chave JWT forte e exclusiva. Configure `ALLOWED_EMAIL_DOMAINS=example.com` para os usuários fictícios do seed.
4. Use `APP_URL=http://localhost:3000` e `EMAIL_PROVIDER=disabled` para explorar sem e-mails externos.
5. Mantenha `EMAIL_PATRIMONIO_RECIPIENT` com endereço fictício válido para resolução dos eventos.
6. Use `DEMO_MODE=false` para avaliar o produto sem bloqueios administrativos locais, ou `true` para reproduzir as restrições da demo.

O Next.js carrega `.env`; o Prisma 5 utilizado no seed também carrega o arquivo de ambiente da raiz. O comando `db:seed` executa `ts-node` diretamente e não possui carregador de `.env.local`. Portanto, copiar somente para `.env.local` pode deixar o seed sem conexão configurada.

Evite manter valores divergentes entre `.env`, `.env.local` e variáveis já exportadas no terminal. Se optar por fornecer tudo pelo ambiente do processo, faça isso explicitamente antes de executar o seed.

O utilitário `demo:reset` não usa Prisma para carregar `.env`: ele lê as variáveis já disponíveis no processo. Não o execute como parte do setup.

Aplique a estrutura pelo [SQL consolidado](../prisma/consolidated.sql), somente no banco vazio escolhido. O deploy da aplicação não cria nem migra o banco.

## Cuidados com configuração

- Os arquivos locais de ambiente são ignorados pelo Git; somente `.env.example` é versionado.
- Não publique strings de conexão, secrets, tokens ou saída do seed.
- Configure os valores da Vercel no ambiente apropriado, sem copiá-los para a documentação.
- A restrição de domínio trata **domínio de e-mail**, não uma lista de hosts autorizados a acessar o site.
