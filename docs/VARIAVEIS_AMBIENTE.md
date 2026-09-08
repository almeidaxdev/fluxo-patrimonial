# Variáveis de Ambiente — Fluxo Patrimonial

Lista confirmada por busca direta de `process.env.*` em `src/` e `env(...)` em `prisma/schema.prisma`. Nenhum valor real aparece neste documento — apenas nome, obrigatoriedade e finalidade. Ver `.env.example` (sem segredos, só placeholders) para o arquivo de referência local.

| Variável | Obrigatória? | Utilização | Ambiente |
|---|---|---|---|
| `DATABASE_URL` | Sim | Connection string do Prisma Client (pooler Supavisor, modo transação, porta 6543) — usada em runtime para toda query da aplicação. | Local + Vercel (todos) |
| `DIRECT_URL` | Sim | Connection string do pooler em modo sessão (porta 5432) — usada pelo Prisma para operações que exigem conexão persistente (ex.: `prisma generate`/introspecção). | Local + Vercel (todos) |
| `JWT_SECRET` | Sim | Chave de assinatura/verificação do JWT de sessão (`src/lib/auth.ts`). Validada em runtime — mínimo 32 caracteres, sem fallback inseguro; falha explícita apenas quando um token é de fato assinado/verificado (nunca no escopo do módulo, para não quebrar o build). | Local + Vercel (todos) |
| `ALLOWED_EMAIL_DOMAINS` | Sim | Domínio(s) de e-mail aceitos em toda criação/edição de conta `User` — um ou mais, separados por vírgula (`src/lib/validations.ts`, `emailPermitidoSchema`). **Fail-closed**: ausente, vazia ou sem nenhum domínio válido após normalização rejeita QUALQUER e-mail. | Local + Vercel (todos) |
| `APP_URL` | Sim | Base para montagem de links absolutos usados no corpo de e-mails (ex.: link de assinatura). Validada (`parseAppUrl`): precisa ser URL absoluta `http`/`https`, com hostname, sem query string nem fragment. | Local + Vercel (todos) |
| `EMAIL_PROVIDER` | Sim | Seleciona o provedor de e-mail. Único valor suportado atualmente: `"resend"`. | Local + Vercel (todos) |
| `EMAIL_API_KEY` | Sim | Credencial de API do provedor de e-mail. | Local + Vercel (todos) |
| `EMAIL_FROM_ADDRESS` | Sim | Endereço de e-mail remetente (validado como e-mail). | Local + Vercel (todos) |
| `EMAIL_FROM_NAME` | Não | Nome de exibição do remetente. Default `"Fluxo Patrimonial"` se ausente/vazia. | Local + Vercel (todos) |
| `EMAIL_REPLY_TO` | Não | Endereço de Reply-To. Sem cabeçalho Reply-To se ausente/vazia; validado como e-mail quando presente. | Local + Vercel (todos) |
| `EMAIL_TEST_MODE` | Sim | Aceita **somente** os literais exatos `"true"` ou `"false"` (sem trim, sem variação de caixa — qualquer outro valor, incluindo ausência, é erro de configuração). Quando `"true"`, todo envio é redirecionado fisicamente para `EMAIL_TEST_RECIPIENT`. | Local + Vercel (todos) |
| `EMAIL_TEST_RECIPIENT` | Condicional | Obrigatória (e validada como e-mail) somente quando `EMAIL_TEST_MODE = "true"` — sem fallback para destinatário real nesse caso. | Local + Vercel (não produção) |
| `EMAIL_PATRIMONIO_RECIPIENT` | Sim | Endereço da caixa de grupo do Patrimônio — destino de todo e-mail cujo destinatário operacional é "a equipe Patrimônio" como um todo. Validada separadamente de `getEmailConfig()`, no momento de resolver o destinatário (não exige as demais variáveis de e-mail para ser checada). | Local + Vercel (todos) |
| `NODE_ENV` | Definida pelo runtime | Usada para habilitar `log` do Prisma (`query`/`error`/`warn`) fora de produção (`src/lib/prisma.ts`) e para o flag `secure` do cookie de sessão (`src/lib/auth.ts`). Não é configurada manualmente — Next.js/Vercel a definem automaticamente. | Local + Vercel (todos) |

## Confirmação de completude

Busca por `process.env.` em todo `src/` (aplicação) e por `env(...)` em `prisma/schema.prisma` não retornou nenhuma outra variável além das listadas acima. Os arquivos em `scripts/` (scripts de teste) leem as mesmas variáveis de e-mail acima para montar mocks — não introduzem nenhuma variável nova de configuração de produção.

## Nota sobre arquivos legados

`RECRIACAO_BANCO.md`, na raiz do projeto, ainda faz referência a uma variável `NEXTAUTH_URL` de uma versão anterior do projeto — essa variável **não existe mais no código atual** (confirmado: nenhuma ocorrência de `NEXTAUTH_URL` em `src/`). Esse arquivo está fora do escopo desta rodada de documentação; a tabela acima reflete exclusivamente o que o código atual efetivamente lê.
