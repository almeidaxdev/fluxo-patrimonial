# Deploy — Fluxo Patrimonial

[← Documentação](README.md) · [Configuração da demo](DEMO_MODE.md)

Manual operacional. Nenhum valor real de variável de ambiente aparece neste documento — apenas nomes.

## Fluxo Git

```
branch de feature
  → validações locais (tsc --noEmit, eslint, npm run test:*, npm run build)
  → commit
  → merge fast-forward em main
  → push origin main
  → Vercel detecta o push e builda/publica automaticamente
```

`main` é a única branch de deploy — não há branch de staging separada configurada no projeto atualmente.

## Variáveis de ambiente na Vercel

Configure os valores no ambiente correto do projeto, mantendo banco e credenciais da demo separados. A [referência de variáveis](VARIAVEIS_AMBIENTE.md) é o inventário central de obrigatoriedade e finalidade.

- Aplicação/banco: `DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET`, `ALLOWED_EMAIL_DOMAINS` e `APP_URL`.
- Demo: `DEMO_MODE`, `DEMO_ACCOUNT_EMAIL`, `DEMO_MAX_SOLICITACOES`, `CRON_SECRET` e `DEMO_RESET_SECRET`.
- E-mail: `EMAIL_PROVIDER` e demais campos condicionais descritos na referência.

A demo atual utiliza `EMAIL_PROVIDER=disabled`. Com `resend`, `EMAIL_TEST_MODE=true` redireciona a entrega para o destinatário de teste; o código não rejeita esse valor simplesmente por estar em produção. Envio desabilitado e envio redirecionado são configurações distintas.

## Reset automático da demo

O [vercel.json](../vercel.json) contém um cron diário para `GET /api/internal/demo-reset`, com expressão `0 6 * * *`: 06:00 UTC, aproximadamente 03:00 em Brasília. O mantenedor confirmou essa configuração ativa na demo.

O GET exige `CRON_SECRET` via `Authorization: Bearer`. O reset manual é um POST protegido por `DEMO_RESET_SECRET`, com header próprio. Uma credencial não substitui a outra. Ambos só operam com `DEMO_MODE=true`.

O reset reconstrói os dados transacionais fictícios; não cria ou migra a estrutura do banco. O cron não executa o dispatcher de e-mails. [Detalhes do reset](DEMO_MODE.md#reset-do-dataset).

## Build / postinstall

`postinstall: prisma generate` roda automaticamente após `npm install`, tanto localmente quanto no build da Vercel — o Prisma Client já está atualizado antes de `npm run build` rodar, sem passo manual adicional no pipeline.

## O que o deploy NÃO faz

O build da Vercel **não** executa `prisma migrate deploy`, `prisma db push`, nem qualquer script de seed. O schema do banco em produção é gerenciado **manualmente e separadamente** do deploy da aplicação (ver `docs/BANCO_DE_DADOS.md`, seção "Processo de alteração"). Um push em `main` nunca altera a estrutura do banco por si só.

**Coluna `users.versao_sessao`**: já faz parte de `prisma/consolidated.sql` — sustenta a revogação de sessão (login, `getValidatedMutationSession()`, `PATCH /api/colaboradores/[id]`, `PATCH /api/auth/senha`). Nenhuma ação adicional necessária ao aplicar a estrutura em um banco novo.

**Data API do Supabase**: a aplicação não a utiliza; a documentação original registra a opção de mantê-la desabilitada no painel (ver [Banco de dados](BANCO_DE_DADOS.md#data-api-e-rls)). O deploy da Vercel não depende dela em nenhum ponto — o acesso a dado é sempre via Prisma/conexão Postgres direta, nunca via Data API/PostgREST/GraphQL.

**Firewall**: o build não cria nem publica regras no painel. Há duas configurações distintas, descritas abaixo.

## Firewall: borda e SDK

| Camada | Configuração | Estado conhecido |
|---|---|---|
| Borda | POST /api/solicitacoes, 10 requisições / 60 segundos / IP | Ativa na demo, validada pelo mantenedor |
| SDK | Rate Limit ID `fluxo-patrimonial-sensitive-actions`, namespaces por ação | Integração implementada; a confirmação da borda não comprova a publicação desta regra |

Os parâmetros documentados para a regra do SDK são 8 requisições em 600 segundos, compatíveis com o `Retry-After: 600` do helper. Eles não descrevem a regra de borda da demo. Consulte [Modo Demo](DEMO_MODE.md#proteção-contra-abuso) antes de interpretar os limites.

O helper utiliza fail-open em falhas de infraestrutura. A demo acrescenta a contagem global `DEMO_MAX_SOLICITACOES=200`; esse controle não depende do Firewall, mas não é atômico sob concorrência extrema.

Nenhuma configuração de painel é aplicada por este documento. Não há necessidade de recriar regras já ativas para atualizar a apresentação do repositório.

## Smoke test pós-deploy

Checklist operacional para um ambiente próprio de validação. As ações abaixo não fazem parte de uma revisão documental; não use dados reais e não execute alterações administrativas na demo pública, onde elas são bloqueadas:

- [ ] Login com um usuário de cada perfil (colaborador, gestor, patrimônio, administrador) funciona.
- [ ] Dashboard carrega sem erro para cada perfil.
- [ ] `GET /api/patrimonios/disponibilidade` responde com bens livres para uma data/período válidos.
- [ ] Criação de uma solicitação interna de teste completa sem erro 500 (checar especialmente a rota `POST /api/solicitacoes`, histórico de P2028).
- [ ] O evento de e-mail possui o estado esperado: `SUPRIMIDO` na demo com provedor `disabled`, sem entrega externa; em ambiente de envio real, avaliar o resultado do provedor.
- [ ] Relatórios (resumo e operacional) carregam para um perfil autorizado.
- [ ] Nenhum log de erro `[Email]` de configuração ausente/inválida aparece nos logs da função após o smoke test.
- [ ] Headers de segurança presentes numa resposta qualquer em produção (`curl -I` ou aba Network do navegador): `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, `Permissions-Policy` e `Strict-Transport-Security: max-age=31536000; includeSubDomains` (este último só deve aparecer em produção — `NODE_ENV === 'production'`).
- [ ] Login normal (poucas tentativas, uso real) continua funcionando sem 429 — confirma que o rate limit (ver `docs/ARQUITETURA.md`, seção "Rate limiting") não está bloqueando uso legítimo.
- [ ] Painel Vercel → Firewall mostra a regra de borda esperada e, se configurada, a regra separada do SDK. Verificar cada camada individualmente, sem teste de carga na demo.
- [ ] Revogação de sessão (Etapa `security/session-revocation`, requer a coluna `versao_sessao` já aplicada — ver acima): troque a senha de um usuário de teste em `/alterar-senha` e confirme que a página redireciona para `/login`; com um segundo login desse mesmo usuário, peça a um Administrador para desativá-lo em Colaboradores e confirme que a próxima ação de mutação (ex.: criar uma solicitação) retorna `401` "Sessão inválida ou expirada", não um erro genérico.

## Rollback

Sempre via Vercel/Git — **nunca envolve alterar o banco**:

1. No painel da Vercel, promover o deployment anterior estável ("Promote to Production"), **ou**
2. `git revert` do(s) commit(s) problemático(s) em `main` e novo push (preferível quando o rollback precisa ficar registrado no histórico).

Como o schema do banco não é alterado automaticamente pelo deploy, reverter a aplicação nunca deixa o banco "à frente" do código de forma incompatível — a única exceção seria uma alteração de schema aplicada manualmente e deliberadamente junto de um deploy específico, que precisaria ser avaliada caso a caso (não é o fluxo padrão).
