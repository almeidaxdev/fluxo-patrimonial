# Fluxo Patrimonial

**Gestão de ativos, reservas e empréstimos com rastreabilidade de ponta a ponta.**

![Next.js](https://img.shields.io/badge/Next.js-15-black)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)
![Prisma](https://img.shields.io/badge/Prisma-5-2D3748)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-compatible-336791)

Sistema web para gestão de empréstimos de bens patrimoniais (notebooks, projetores, equipamentos audiovisuais etc.), papelaria e serviços/movimentações. Cobre todo o ciclo de uma solicitação — criação, aprovação, confirmação, assinatura, separação, retirada e devolução — com histórico, notificações e e-mails automáticos em cada etapa relevante.

Este é um projeto de portfólio: a base de código é a mesma usada em um sistema real em produção, com identidade (nome, marca, textos) e dados de demonstração inteiramente reescritos. Nenhuma informação de qualquer organização, pessoa ou operação real permanece no repositório.

## Índice

- [Destaques](#destaques)
- [Perfis de acesso](#perfis-de-acesso)
- [Fluxos](#fluxos)
- [Stack técnica](#stack-técnica)
- [Arquitetura](#arquitetura)
- [Segurança](#segurança)
- [Dados demonstrativos](#dados-demonstrativos)
- [Screenshots](#screenshots)
- [Executando localmente](#executando-localmente)
- [Roadmap](#roadmap)
- [Licença](#licença)
- [Autor](#autor)

## Destaques

| Área | Funcionalidade |
|---|---|
| Solicitações | Gestão de solicitações em três fluxos: interno, externo e atendimento imediato |
| Aprovação | Aprovação por gestor, restrita ao fluxo externo |
| Patrimônio | Gestão do catálogo de bens, categorias e disponibilidade por data/período |
| Operação | Separação, retirada e devolução (com condição estruturada) |
| Documentos | Assinatura eletrônica e termo de retirada/devolução |
| Comunicação | Notificações internas e e-mails transacionais |
| Rastreabilidade | Linha do tempo completa de cada solicitação |
| Relatórios | Visão gerencial e operacional, exportável em Excel e PDF |
| Usuários | Controle de usuários, permissões e capacidades adicionais |
| Segurança | Restrição de cadastro por domínio de e-mail, configurável por instalação |

## Perfis de acesso

| Perfil | Capacidade |
|---|---|
| **Colaborador** | Cria e acompanha as próprias solicitações. |
| **Gestor** | Não é um perfil exclusivo — é uma capacidade adicional que qualquer colaborador pode ter. Aprova ou rejeita atividades externas atribuídas a ele. |
| **Patrimônio** | Confirma solicitações, gerencia o catálogo de bens, e opera separação, retirada, devolução e assinatura. |
| **Administrador** | Tudo que Patrimônio faz, além de gerenciar categorias, colaboradores e permissões. |

## Fluxos

**Interno**

```
Solicitação → Patrimônio → Separação → Retirada → Devolução
```

**Externo**

```
Solicitação → Gestor → Patrimônio → Assinatura → Retirada → Devolução
```

Um terceiro fluxo, **atendimento imediato**, registra um atendimento que já está ocorrendo (sem reserva prévia, sem gestor, sem etapa de aprovação). Diagramas completos em [`docs/FLUXOS.md`](docs/FLUXOS.md).

## Stack técnica

| Camada | Tecnologia |
|---|---|
| Framework | Next.js (App Router) |
| Linguagem | TypeScript |
| UI | React + Tailwind CSS |
| Formulários / validação | React Hook Form + Zod |
| ORM | Prisma |
| Banco de dados | PostgreSQL (compatível com Supabase ou qualquer instância própria) |
| Autenticação | JWT próprio (`jose`) |
| Senhas | bcryptjs |
| Gráficos | Recharts |
| E-mail | Resend |
| Exportação | ExcelJS (Excel) / `@react-pdf/renderer` (PDF) |
| Componentes de UI | Radix UI |

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
PostgreSQL
```

Toda autorização é revalidada no backend a cada requisição — a UI nunca é a fonte de verdade. E-mails transacionais são disparados de forma assíncrona, fora da transação de negócio que os originou. Detalhes completos em [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md); regras de negócio por fluxo em [`docs/REGRAS_DE_NEGOCIO.md`](docs/REGRAS_DE_NEGOCIO.md).

## Segurança

- Autenticação própria via JWT, cookie `httpOnly`.
- Autorização por perfil e capacidade, revalidada no backend em cada rota — nunca só na interface.
- Validação server-side de toda entrada (Zod), independente da validação client-side.
- Domínio de e-mail permitido **configurável** via `ALLOWED_EMAIL_DOMAINS`, com comportamento **fail-closed**: configuração ausente ou inválida rejeita qualquer cadastro, nunca libera por omissão.
- Controle de sessão com versionamento — mudanças sensíveis (senha, permissão, e-mail) invalidam sessões abertas.
- Rastreabilidade completa de cada solicitação via histórico de eventos.

Este projeto segue boas práticas de segurança para uma aplicação deste porte — não se trata de um sistema com certificação ou auditoria formal de segurança.

## Dados demonstrativos

Os dados demonstrativos utilizados pelo projeto são inteiramente fictícios. `prisma/seed.ts` popula o ambiente com um conjunto pensado para exercitar todas as telas sem exigir cadastro manual:

- Usuários fictícios (`admin@example.com`, `patrimonio@example.com`, `gestor@example.com` e colaboradores de exemplo).
- 18 bens patrimoniais fictícios (`PAT-0001` a `PAT-0018`) em 8 categorias.
- Cerca de 15 solicitações distribuídas por praticamente todos os estados do fluxo.
- Notificações internas de exemplo.

Nenhum identificador, nome ou e-mail reaproveita dado de qualquer ambiente real. O seed é idempotente — pode ser executado novamente sem duplicar registros.

## Screenshots

> Screenshots da interface serão adicionados posteriormente.

## Executando localmente

Este projeto **não inclui banco de dados hospedado**. Para rodar localmente, configure uma instância PostgreSQL própria (um projeto Supabase gratuito serve) — o repositório traz apenas schema, SQL consolidado e um seed de demonstração; nenhum dado real ou de terceiros.

### Pré-requisitos

- Node.js 18.18+ (recomendado 20 LTS).
- npm.
- Um banco PostgreSQL próprio.
- Uma conta Resend (opcional — só necessária para testar o envio real de e-mail).

### Passo a passo

```bash
# 1. Clone o repositório
git clone <url-do-repositorio>
cd fluxo-patrimonial

# 2. Instale as dependências
npm install

# 3. Crie um banco PostgreSQL/Supabase próprio

# 4. Copie o arquivo de exemplo
cp .env.example .env.local

# 5. Preencha .env.local com as credenciais do SEU banco
#    (DATABASE_URL, DIRECT_URL, JWT_SECRET, ALLOWED_EMAIL_DOMAINS etc.)

# 6. Crie a estrutura do banco a partir do SQL consolidado
#    (cole o conteúdo de prisma/consolidated.sql no SQL Editor do seu banco)

# 7. Gere o Prisma Client
npx prisma generate

# 8. Popule o banco com dados de demonstração fictícios
npm run db:seed

# 9. Inicie a aplicação
npm run dev
```

Acesse `http://localhost:3000`. As credenciais de acesso (senha temporária, gerada aleatoriamente) são impressas no terminal ao final do seed.

Este projeto **não usa `prisma migrate`, `prisma migrate deploy`, `prisma db push` ou `prisma migrate reset`** em nenhuma etapa — o SQL consolidado é a única fonte da estrutura do banco. Ver [`docs/BANCO_DE_DADOS.md`](docs/BANCO_DE_DADOS.md).

### Build

```bash
npm run build
```

### Testes

```bash
npm run test:<nome-do-script>
```

Scripts de teste próprios (`ts-node`, mocks em memória de Prisma/sessão/e-mail — sem banco real, sem envio real de e-mail). Lista completa em [`docs/TESTES.md`](docs/TESTES.md).

### Variáveis de ambiente

Ver [`.env.example`](.env.example) (só placeholders) e [`docs/VARIAVEIS_AMBIENTE.md`](docs/VARIAVEIS_AMBIENTE.md) para a lista completa, com obrigatoriedade e finalidade de cada variável.

## Roadmap

- [ ] Demo pública opcional.
- [ ] Novos relatórios.
- [ ] Melhorias de acessibilidade.
- [ ] Testes automatizados adicionais.
- [ ] Observabilidade.

## Licença

Licença a definir.

## Autor

Eduardo Almeida
