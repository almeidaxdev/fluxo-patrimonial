# Deploy — Fluxo Patrimonial

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

Configuradas manualmente no painel do projeto (Settings → Environment Variables), uma entrada **Name / Value** por variável. Nomes exigidos (ver `docs/VARIAVEIS_AMBIENTE.md` para a tabela completa com finalidade de cada uma):

```
Name                          Value
─────────────────────────────────────────────
DATABASE_URL                  <valor real — nunca commitado>
DIRECT_URL                    <valor real — nunca commitado>
JWT_SECRET                    <valor real — nunca commitado>
APP_URL                       <URL pública de produção>
EMAIL_PROVIDER                resend
EMAIL_API_KEY                 <valor real — nunca commitado>
EMAIL_FROM_ADDRESS            <valor real>
EMAIL_FROM_NAME               <valor real, opcional>
EMAIL_REPLY_TO                <valor real, opcional>
EMAIL_TEST_MODE               true ou false (literal exato)
EMAIL_TEST_RECIPIENT          <obrigatório se EMAIL_TEST_MODE=true>
EMAIL_PATRIMONIO_RECIPIENT    <valor real — caixa de grupo do Patrimônio>
```

**Atenção**: `EMAIL_TEST_MODE` deve ser `"false"` em produção — deixá-la em `"true"` (ou com valor inválido) faz `getEmailConfig()` lançar erro de configuração já na primeira tentativa de envio (falha segura, não silenciosa), mas o correto é simplesmente configurá-la certo por ambiente.

## Build / postinstall

`postinstall: prisma generate` roda automaticamente após `npm install`, tanto localmente quanto no build da Vercel — o Prisma Client já está atualizado antes de `npm run build` rodar, sem passo manual adicional no pipeline.

## O que o deploy NÃO faz

O build da Vercel **não** executa `prisma migrate deploy`, `prisma db push`, nem qualquer script de seed. O schema do banco em produção é gerenciado **manualmente e separadamente** do deploy da aplicação (ver `docs/BANCO_DE_DADOS.md`, seção "Processo de alteração"). Um push em `main` nunca altera a estrutura do banco por si só.

**Coluna `users.versao_sessao`**: já faz parte de `prisma/consolidated.sql` — sustenta a revogação de sessão (login, `getValidatedMutationSession()`, `PATCH /api/colaboradores/[id]`, `PATCH /api/auth/senha`). Nenhuma ação adicional necessária ao aplicar a estrutura em um banco novo.

**Data API do Supabase**: desabilitada no projeto (decisão arquitetural — ver `docs/ARQUITETURA.md` e `docs/BANCO_DE_DADOS.md`, seção "Data API e RLS"). O deploy da Vercel não depende dela em nenhum ponto — o acesso a dado é sempre via Prisma/conexão Postgres direta, nunca via Data API/PostgREST/GraphQL.

**Regra de Rate Limit do Firewall**: o deploy também **não** cria/publica a regra `fluxo-patrimonial-sensitive-actions` — isso é sempre uma ação manual no Dashboard (nunca por código/CLI). Sem essa regra publicada, o código já em produção fica com o rate limiting inerte (ver `docs/ARQUITETURA.md`, seção "Rate limiting") — nenhum risco de quebra, só de proteção ainda não ativa.

## Rate limiting — configuração manual do Firewall

Feita **uma única vez** (ou sempre que a regra precisar ser recriada — ex.: projeto novo, regra removida por engano), sempre pelo Dashboard, nunca por CLI/API:

1. `vercel.com/dashboard` → selecione o projeto → **Firewall** (menu lateral).
2. **Configure** (canto superior direito) → **+ New Rule**.
3. Nome: algo identificável, ex. `Fluxo Patrimonial sensitive actions rate limit`.
4. Seção **Configure**, primeira condição **If**: selecione o tipo **`@vercel/firewall`**.
5. Campo **Rate limit ID**: `fluxo-patrimonial-sensitive-actions` (exatamente igual à constante `RATE_LIMIT_ID` em `src/lib/rate-limit.ts`).
6. Ação **Then**: **Rate Limit**.
7. Algoritmo: **Fixed Window** (única opção disponível no plano Hobby).
8. **Time Window**: `600` (segundos).
9. **Request Limit**: `8`.
10. Ação quando o limite é excedido: **Deny** (ou o padrão `429` — a resposta JSON com mensagem genérica e o header `Retry-After` já são construídos pela própria aplicação).
11. **Save Rule** → **Review Changes** → **Publish**.

Depois de publicada, confirmar no smoke test (abaixo) que a regra aparece recebendo tráfego em Firewall → Overview.

## Smoke test pós-deploy

Checklist mínimo para confirmar que um deploy está saudável, sem tocar em dado real de produção além do estritamente necessário:

- [ ] Login com um usuário de cada perfil (colaborador, gestor, patrimônio, administrador) funciona.
- [ ] Dashboard carrega sem erro para cada perfil.
- [ ] `GET /api/patrimonios/disponibilidade` responde com bens livres para uma data/período válidos.
- [ ] Criação de uma solicitação interna de teste completa sem erro 500 (checar especialmente a rota `POST /api/solicitacoes`, histórico de P2028).
- [ ] O e-mail correspondente à criação é registrado em `EmailEvento` com o `status` esperado (não precisa necessariamente ter sido entregue, mas precisa ter sido criado/processado sem erro de configuração — checar logs `[Email]`).
- [ ] Relatórios (resumo e operacional) carregam para um perfil autorizado.
- [ ] Nenhum log de erro `[Email]` de configuração ausente/inválida aparece nos logs da função após o smoke test.
- [ ] Headers de segurança presentes numa resposta qualquer em produção (`curl -I` ou aba Network do navegador): `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, `Permissions-Policy` e `Strict-Transport-Security: max-age=31536000; includeSubDomains` (este último só deve aparecer em produção — `NODE_ENV === 'production'`).
- [ ] Login normal (poucas tentativas, uso real) continua funcionando sem 429 — confirma que o rate limit (ver `docs/ARQUITETURA.md`, seção "Rate limiting") não está bloqueando uso legítimo.
- [ ] Painel Vercel → Firewall → Overview mostra a regra `fluxo-patrimonial-sensitive-actions` recebendo tráfego (confirma que o Rate Limit ID está corretamente publicado e ativo).
- [ ] Revogação de sessão (Etapa `security/session-revocation`, requer a coluna `versao_sessao` já aplicada — ver acima): troque a senha de um usuário de teste em `/alterar-senha` e confirme que a página redireciona para `/login`; com um segundo login desse mesmo usuário, peça a um Administrador para desativá-lo em Colaboradores e confirme que a próxima ação de mutação (ex.: criar uma solicitação) retorna `401` "Sessão inválida ou expirada", não um erro genérico.

## Rollback

Sempre via Vercel/Git — **nunca envolve alterar o banco**:

1. No painel da Vercel, promover o deployment anterior estável ("Promote to Production"), **ou**
2. `git revert` do(s) commit(s) problemático(s) em `main` e novo push (preferível quando o rollback precisa ficar registrado no histórico).

Como o schema do banco não é alterado automaticamente pelo deploy, reverter a aplicação nunca deixa o banco "à frente" do código de forma incompatível — a única exceção seria uma alteração de schema aplicada manualmente e deliberadamente junto de um deploy específico, que precisaria ser avaliada caso a caso (não é o fluxo padrão).
