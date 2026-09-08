# Fluxo Patrimonial

Gestão de ativos, reservas e empréstimos.

## Sobre o projeto

Sistema web para gestão de empréstimos de bens patrimoniais (notebooks, projetores, equipamentos audiovisuais etc.), papelaria e serviços/movimentações. Cobre todo o ciclo de uma solicitação — criação, aprovação (quando aplicável), confirmação pelo setor de Patrimônio, assinatura de documentos (fluxo externo), separação, retirada, devolução — com histórico completo, notificações internas e e-mails automáticos em cada etapa relevante.

Este é um projeto de portfólio: a base de código é a mesma usada em um sistema real em produção, reescrita de identidade (nome, marca, textos) e com dados de demonstração inteiramente fictícios. Nenhuma informação institucional, pessoal ou operacional real permanece no repositório.

## Principais funcionalidades

- Solicitação de bens patrimoniais, papelaria e serviços/movimentações, em três fluxos: **interno**, **externo** e **atendimento imediato**.
- Aprovação por gestor (obrigatória apenas no fluxo externo) e confirmação pelo setor de Patrimônio.
- Assinatura de documentos para empréstimos externos, com envio/reenvio de link e confirmação manual.
- Controle de disponibilidade de bens por data e período, com proteção contra concorrência.
- Separação, retirada, devolução (com condição estruturada) e registro de "não retirado".
- Cancelamento de solicitações, com regras diferentes conforme a etapa em que a solicitação está.
- Cadastro e gestão de bens patrimoniais e categorias.
- Gestão de colaboradores, permissões e redefinição de senha temporária.
- Domínio de e-mail permitido **configurável por instalação** (`ALLOWED_EMAIL_DOMAINS`), fail-closed: sem configuração, nenhum cadastro é aceito.
- Notificações internas (in-app) e e-mails transacionais (Resend), com modo de homologação seguro e caixa de grupo dedicada para o setor de Patrimônio.
- Relatórios (visão gerencial e operacional) com exportação em Excel e PDF.
- Termo de retirada/devolução e assinatura eletrônica de documentos.
- Autenticação própria via JWT (cookie httpOnly), sem dependência de provedor externo de login.

## Perfis de acesso

| Perfil | Papel |
|---|---|
| **Colaborador** | Cria e acompanha suas próprias solicitações. Pode acumular a permissão adicional de Gestor. |
| **Gestor** | Não é um perfil exclusivo — é uma permissão adicional que qualquer colaborador pode ter. Aprova ou rejeita atividades externas atribuídas a ele. |
| **Patrimônio** | Confirma/rejeita solicitações, envia/valida assinatura, registra separação, retirada, devolução e "não retirado". Gerencia o catálogo de bens. Vê todas as solicitações e a fila de pendências. |
| **Administrador** | Tudo que Patrimônio faz, além de gerenciar categorias e colaboradores (cadastro, permissões, redefinição de senha). |

## Fluxos do sistema

- **Interna**: nasce aguardando o setor de Patrimônio (sem gestor envolvido). Após confirmação, vai direto para separação (sem etapa de assinatura).
- **Externa**: nasce aguardando o gestor. Após aprovação, passa a aguardar o Patrimônio; após confirmação, aguarda envio e confirmação de assinatura antes de seguir para separação.
- **Atendimento imediato**: registrado pelo Patrimônio/Administrador para um atendimento que já está ocorrendo — sempre tratado como fluxo interno simplificado, sem gestor, sem etapa de aprovação e sem cálculo de prazo/antecedência.

Ver `docs/FLUXOS.md` para os diagramas completos de cada caminho.

## Tecnologias utilizadas

| Camada | Tecnologia |
|---|---|
| Framework | Next.js (App Router) |
| Linguagem | TypeScript |
| UI | React + TailwindCSS |
| ORM | Prisma |
| Banco de dados | PostgreSQL (Supabase) |
| Autenticação | JWT próprio (`jose`) |
| Senhas | bcryptjs |
| Formulários/validação | React Hook Form + Zod |
| Gráficos | Recharts |
| E-mail | Resend |
| Exportação | ExcelJS / @react-pdf/renderer |
| Deploy | Vercel |

## Arquitetura

```
Browser
  ↓
Next.js (App Router — páginas 'use client' + API Routes)
  ↓
API Routes (src/app/api/**) — autenticação, validação, regra de negócio
  ↓
Prisma Client (singleton — src/lib/prisma.ts)
  ↓
PostgreSQL (Supabase, via pooler de transação/sessão)
```

E-mails transacionais são disparados de forma assíncrona, fora da transação de negócio que os originou. Todo o acesso ao banco é feito pelo backend via Prisma.

Detalhes técnicos completos em `docs/ARQUITETURA.md`.

## Screenshots

_A publicar após a homologação visual da identidade "Fluxo Patrimonial" (ver roadmap abaixo)._

## Executando localmente

Este projeto **não inclui banco de dados hospedado**. Para rodar localmente, configure uma instância PostgreSQL compatível (ou um projeto Supabase próprio, gratuito) — o repositório traz apenas o schema, o SQL consolidado e um seed de demonstração; nenhum dado real ou de terceiros.

### Pré-requisitos

- Node.js 18.18+ (recomendado 20 LTS).
- npm.
- Um banco PostgreSQL próprio (ex.: um projeto Supabase gratuito, ou PostgreSQL local).
- Uma conta Resend (opcional — só necessária para testar o envio real de e-mail; sem ela, o restante da aplicação funciona normalmente).

### Passo a passo

```bash
# 1. Clone o repositório
git clone <url-do-repositorio>
cd fluxo-patrimonial

# 2. Instale as dependências
npm install

# 3. Crie um banco PostgreSQL/Supabase próprio
#    (nenhuma credencial de terceiros funciona aqui — é o SEU banco)

# 4. Copie o arquivo de exemplo
cp .env.example .env.local

# 5. Preencha .env.local com as credenciais do SEU banco
#    (DATABASE_URL, DIRECT_URL, JWT_SECRET, ALLOWED_EMAIL_DOMAINS etc.
#    — ver "Variáveis de ambiente" abaixo)

# 6. Crie a estrutura do banco a partir do SQL consolidado
#    (cole o conteúdo de prisma/consolidated.sql no SQL Editor do seu
#    banco/Supabase — este projeto NUNCA usa prisma migrate/db push/reset)

# 7. Gere o Prisma Client
npx prisma generate

# 8. Popule o banco com dados de demonstração fictícios
npm run db:seed

# 9. Inicie a aplicação
npm run dev
```

Acesse `http://localhost:3000`. As credenciais de acesso (senha temporária, gerada aleatoriamente) são impressas no terminal ao final do seed.

### Build

```bash
npm run build
```

`postinstall` já roda `prisma generate` automaticamente após `npm install`.

### Testes

```bash
npm run test:<nome-do-script>
```

O projeto usa scripts de teste próprios (`ts-node`, mocks em memória de Prisma/sessão/e-mail — sem banco real, sem envio real de e-mail), listados em `package.json` sob o prefixo `test:`. Ver `docs/TESTES.md` para a lista agrupada por área.

## Variáveis de ambiente

Ver `.env.example` para o arquivo de referência (só placeholders, nenhum segredo real) e `docs/VARIAVEIS_AMBIENTE.md` para a lista completa com obrigatoriedade e finalidade de cada uma. Nunca copie segredos reais para `.env.example` ou para qualquer commit.

## Banco de dados

O projeto não inclui banco de dados hospedado nem credenciais de nenhuma instância real — para execução local, configure uma instância PostgreSQL compatível ou um projeto Supabase próprio.

Este projeto **não usa `prisma migrate`/`prisma migrate deploy`/`prisma db push`/`prisma migrate reset`** como procedimento de setup ou deploy. O schema (`prisma/schema.prisma`) e o SQL consolidado (`prisma/consolidated.sql`, sanitizado — sem nenhum dado) descrevem a estrutura completa; a criação da estrutura é feita rodando esse SQL diretamente no banco escolhido. Ver `docs/BANCO_DE_DADOS.md`.

## Dados demonstrativos

`prisma/seed.ts` popula o ambiente com dados **inteiramente fictícios**, pensados para quem clonar o projeto testar todas as telas sem precisar criar nada manualmente:

- Usuários: `admin@example.com` (Administrador Demo), `patrimonio@example.com` (Patrimônio Demo), `gestor@example.com` (Gestor Demo) e colaboradores de exemplo (Ana Martins, Carlos Oliveira, Mariana Souza, Lucas Ferreira).
- 18 bens patrimoniais fictícios (`PAT-0001` a `PAT-0018`) em 8 categorias.
- ~15 solicitações distribuídas por praticamente todos os estados do fluxo (aguardando gestor/Patrimônio, confirmada, em separação, pronta para retirada, em utilização, finalizada, rejeitada, cancelada, não retirada, assinatura em cada etapa).
- Notificações internas de exemplo.

Os dados demonstrativos utilizados pelo projeto são inteiramente fictícios. Nenhum identificador, número de patrimônio, nome ou e-mail reaproveita dado de qualquer ambiente real. Idempotente — pode ser executado novamente sem duplicar registros.

## Segurança

- **Autenticação**: JWT próprio (`jose`), assinado com `JWT_SECRET` (mínimo 32 caracteres, validado em runtime — sem fallback inseguro).
- **Senhas**: hash com `bcryptjs` (custo 12), nunca armazenadas em texto plano.
- **Sessão**: cookie `httpOnly`, `secure` em produção, `sameSite: lax`.
- **Autorização**: cada rota de API revalida permissão no backend (nunca confia apenas na UI); `src/middleware.ts` protege páginas por perfil/permissão a partir das claims do JWT.
- **Domínio de e-mail permitido**: configurável e fail-closed (ver `ALLOWED_EMAIL_DOMAINS` acima) — nunca aceita qualquer domínio por omissão de configuração.
- Nenhum arquivo `.env`/`.env.local` faz parte deste repositório — apenas `.env.example`, com placeholders.

## Roadmap

- [ ] Nova identidade visual homologada (paleta, tipografia, wordmark).
- [ ] Novas capturas de tela do sistema já rebrandado, para o README e o Manual do Usuário.
- [ ] Publicação de um ambiente de demonstração público.
- [ ] Definição de licença open source.

## Licença

Licença a definir.

## Autor

Eduardo Almeida
