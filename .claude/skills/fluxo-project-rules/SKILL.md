---
name: fluxo-project-rules
description: Regras permanentes de arquitetura, banco, segurança, autenticação, performance e processo de desenvolvimento do projeto Fluxo Patrimonial. Use esta skill sempre que modificar código, API, banco, autenticação, autorização, reservas, colaboradores, e-mails, segurança ou infraestrutura deste projeto.
---

# Fluxo Patrimonial — Project Rules

## 1. Objetivo

Estas regras são permanentes para este repositório.

Antes de implementar qualquer alteração, preserve estas decisões salvo
instrução explícita em contrário.

---

## 2. Stack

Projeto baseado em:

- Next.js 15.5.24
- React 18
- TypeScript
- Prisma 5
- PostgreSQL / Supabase
- Tailwind
- autenticação JWT própria
- deploy Vercel

Produção:

main → Vercel Production.

---

## 3. Banco de dados — REGRA CRÍTICA

O banco foi criado e é mantido por SQL consolidado/manual.

NUNCA executar por conta própria:

- prisma migrate
- prisma migrate dev
- prisma migrate deploy
- prisma db push
- prisma db reset
- reset do banco
- seed em produção
- DROP
- recriação de banco

Alterações estruturais devem ser:

1. aditivas sempre que possível;
2. representadas em prisma/schema.prisma;
3. representadas em prisma/consolidated.sql;
4. entregues como SQL explícito;
5. aplicadas manualmente no Supabase somente após aprovação do usuário.

`npx prisma generate` é permitido porque não altera o banco.

Não executar SQL sem autorização explícita.

---

## 4. Dados de produção

Nunca destruir, resetar ou recriar dados existentes.

Preservar compatibilidade com banco de produção.

Não presumir que seed representa produção.

---

## 5. Build / dev server

Não executar `npm run build` enquanto `npm run dev` estiver rodando.

Antes do build:

- confirmar dev server parado;
- evitar contaminação do diretório `.next`.

---

## 6. Git

Por padrão:

NÃO commit.
NÃO push.

Só executar commit/push quando o usuário explicitamente liberar.

Antes de alterar:

- git status
- confirmar branch
- preservar working tree existente

Nunca usar sem autorização:

- git reset --hard
- git clean
- git push --force
- rebase destrutivo
- rewrite de histórico

Produção usa:

main

Preferir fast-forward quando solicitado.

---

## 7. Segurança já implementada

Preservar integralmente as etapas já homologadas.

### S1
Next.js atualizado para versão segura.

### S2
Security Headers.

Preservar:

- X-Content-Type-Options
- Referrer-Policy
- X-Frame-Options
- Permissions-Policy
- HSTS

Não remover headers existentes sem justificativa.

### S3 — solicitar para outro

User possui:

podeSolicitarParaOutro

Isso é uma CAPACIDADE, não um papel.

Não criar papel "apoio técnico".

Pode solicitar para outro quando autorizado conforme helper existente.

Essa capacidade NÃO concede:

- aprovação de gestor;
- funções de patrimônio;
- funções de admin;
- atendimento imediato.

Backend deve impedir solicitanteId de terceiro sem autorização.

### S4 — Rate Limiting

Rate limit existente via Vercel Firewall / @vercel/firewall.

Preservar especialmente:

LOGIN:
rate limit antes de Prisma e bcrypt.

CADASTRO:
preservar ordem segura já homologada.

REENVIO DE ASSINATURA:
preservar limiter/idempotência existente.

Não mover operações caras para antes do limiter.

### S5 — Session Revocation

User possui:

versaoSessao

JWT possui:

versaoSessao

JWT/cookie:

24 horas.

Tokens anteriores sem versaoSessao não são válidos para operações
revalidadas.

getValidatedMutationSession():

- verifica sessão;
- consulta User atual;
- usuário deve existir;
- ativo deve ser true;
- versaoSessao JWT == banco;
- autorização usa dados atuais do banco.

Mudanças de segurança incrementam versaoSessao atomicamente.

Incluem:

- senha;
- ativo;
- permissao;
- podeSerGestor;
- podeSolicitarParaOutro;
- e-mail.

Nome sozinho NÃO incrementa.

Várias mudanças sensíveis no mesmo PATCH:

incrementam somente UMA vez.

Usar:

increment: 1

Não fazer read + version + 1 manual quando puder evitar.

### S5.1 — sincronização client-side

GET /api/auth/me revalida sessão no banco.

AuthProvider revalida:

- montagem;
- window focus;
- visibilitychange quando visible;

com throttle e SEM polling.

401 de API autenticada:

revoga estado local e envia para login.

403:

NÃO deve causar logout.

Middleware continua SEM Prisma.

Não colocar consulta de banco no middleware Edge.

---

## 8. Usuário ativo/inativo

User.ativo já existe.

Admin pode ativar/desativar outros usuários.

Admin não pode desativar a própria conta.

Desativação/reativação:

incrementa versaoSessao.

Usuário inativo:

não autentica.

Preservar mensagem de login genérica.

---

## 9. Colaboradores

Admin pode editar:

- nome;
- e-mail;
- ativo;
- permissao;
- podeSerGestor;
- podeSolicitarParaOutro;
- gestor padrão.

Nome:

não revoga sessão.

E-mail alterado:

revoga sessão.

E-mail novo deve estar num domínio permitido.

---

## 10. E-mails de usuários

Novos e-mails de User devem ter domínio dentro da lista configurada em
ALLOWED_EMAIL_DOMAINS (um ou mais domínios, separados por vírgula).
FAIL-CLOSED: variável ausente/vazia/inválida rejeita todo e-mail — nunca
libera geral por omissão.

Normalizar:

trim().toLowerCase()

Não validar com:

includes(dominio)

Usuários legados que já tenham e-mail fora da configuração atual de
ALLOWED_EMAIL_DOMAINS podem continuar com esse endereço enquanto o e-mail
NÃO for alterado.

Admin pode editar outros campos desses usuários normalmente.

Se o e-mail legado for realmente alterado:

novo valor deve obedecer ALLOWED_EMAIL_DOMAINS.

Não aplicar essa regra à variável de e-mail do grupo Patrimônio; esta regra é
para User.email.

---

## 11. Senhas — S6-B1

Nova senha:

- mínimo 8 Unicode code points;
- máximo 72 bytes UTF-8.

Contagem mínima:

usar equivalente a:

[...senha].length

Limite máximo:

TextEncoder().encode(senha).length <= 72

Senha nunca deve sofrer:

- trim
- lowercase
- uppercase
- normalize
- remoção de espaços

Não exigir artificialmente:

- maiúscula
- número
- símbolo
- complexidade regex

LOGIN:

não exigir mínimo de 8 por compatibilidade com senha legada.

Login exige:

- string não vazia;
- máximo 72 bytes antes de bcrypt.compare.

Entrada acima de 72 bytes:

não deve chegar ao bcrypt.compare.

Preservar bcrypt cost atual.

Reset administrativo:

preservar gerador criptograficamente seguro existente.

Senha temporária:

- nunca logar;
- nunca guardar em texto puro;
- nunca colocar em JWT/history/e-mail;
- mostrar somente uma vez quando aplicável.

---

## 12. Validações S6-B2

Limites centralizados atuais:

nome = 120
email = 254
busca = 120
tituloCurto = 120
categoria = 100
localAmbiente = 150
descricaoCurta = 300
observacao = 1000
motivo = 1000
papelaria = 1500

Preservar esses limites salvo nova decisão explícita.

Backend é a autoridade.

Frontend pode espelhar limites para UX.

Não depender de maxLength HTML para segurança.

---

## 13. Enums

Inputs externos de conjunto fechado devem possuir validação explícita.

Não confiar apenas em casts TypeScript como:

valor as Permissao

ou:

valor as StatusSolicitacao

Utilizar schemas Zod/checagem explícita.

Workflow de status não pode virar atualização genérica.

---

## 14. Workflow de Solicitações

Preservar rotas específicas e regras existentes.

Operações de workflow incluem, conforme sistema atual:

- aprovação gestor;
- rejeição gestor;
- confirmação patrimônio;
- rejeição patrimônio;
- assinatura;
- separação;
- pronta retirada;
- retirada;
- devolução;
- não retirada;
- cancelamento;
- finalização.

Não permitir alteração arbitrária de status por body genérico.

---

## 15. Atendimento imediato

ATENDIMENTO_IMEDIATO:

somente Patrimônio/Admin.

Não ampliar autorização por causa de schemas genéricos.

---

## 16. Reserva para terceiro

Autorização para solicitanteId diferente do usuário logado continua sendo regra
de negócio, não apenas validação estrutural.

Schema válido NÃO significa usuário autorizado.

Sempre preservar autorização server-side.

---

## 17. Períodos

Períodos existentes:

- MANHÃ
- TARDE
- NOITE

Não alterar regras de horários/antecedência nesta etapa sem pedido explícito.

Arrays de períodos nunca precisam conter mais que 3 elementos.

---

## 18. Serviços / Papelaria / Patrimônio

Solicitação pode conter combinações de:

- patrimônio;
- papelaria;
- serviços.

Não quebrar solicitações mistas.

Papelaria é texto/lista livre conforme arquitetura existente; não implementar
estoque automaticamente.

---

## 19. Performance

Evitar:

- N+1;
- consultas redundantes;
- buscar User duas vezes quando uma query pode fornecer autorização;
- revalidar sessão em todo GET comum;
- polling;
- round-trip de banco somente para validar string;
- chamadas externas desnecessárias.

Dashboard e GETs comuns devem continuar leves.

Revalidação seletiva é preferida.

---

## 20. Prisma

Nunca usar body diretamente como data:

NÃO:

data: body

NÃO:

data: { ...body }

quando body é controlado pelo cliente.

Construir whitelist explícita.

Campos sensíveis nunca devem ser controláveis apenas porque apareceram no
payload.

---

## 21. Segredos

Nunca pedir ou exibir:

- DATABASE_URL
- DIRECT_URL
- JWT_SECRET
- chaves Supabase
- tokens
- credenciais
- senhas reais

Nunca logar secrets.

`.env` / `.env.local` não devem ser commitados.

`.env.example` somente placeholders.

---

## 22. E-mails

Infra atual deve preservar:

- idempotência;
- EmailEvento;
- recipient lógico;
- EMAIL_TEST_MODE;
- EMAIL_TEST_RECIPIENT;
- EMAIL_PATRIMONIO_RECIPIENT;
- isolamento de falha de e-mail das transações principais.

Não reintroduzir envio individual para cada usuário Patrimônio quando o
destinatário lógico é o grupo configurado.

---

## 23. Erros

Não retornar ao cliente:

- stack;
- SQL;
- connection string;
- Prisma internals;
- constraint interna;
- segredo.

Erros esperados:

mensagem amigável.

Erros inesperados:

500 genérico + log server-side seguro.

---

## 24. Frontend

Quando houver redesign significativo:

usar a skill/plugin Front End Design, se disponível.

Não usar skill de frontend em alterações puramente backend sem necessidade.

Preservar:

- responsividade;
- estados loading;
- proteção double submit;
- acessibilidade;
- hierarquia visual existente.

---

## 25. Testes

Mudanças de segurança devem ter teste regressivo.

Preservar todos os testes existentes.

Ao concluir bloco de implementação, quando solicitado:

- executar scripts test:* existentes;
- npx tsc --noEmit;
- npm run lint;
- git diff --check;
- npm run build com dev parado.

Não repetir build/testes desnecessariamente durante mera auditoria read-only.

---

## 26. Processo de entrega

Ser conciso.

Evitar narrar cada leitura/comando se não for necessário.

Na entrega normalmente informar apenas:

- arquivos alterados;
- decisões relevantes;
- testes;
- riscos;
- git status.

Não repetir toda a arquitetura do projeto em toda resposta.
