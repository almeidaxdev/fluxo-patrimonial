# Documentação técnica

[← Apresentação do projeto](../README.md) · [Demo pública](https://fluxo-patrimonial-demo.vercel.app)

O Fluxo Patrimonial organiza reservas, aprovações e a operação de empréstimos de ativos. Este índice reúne os detalhes que complementam a apresentação do repositório.

## Por onde começar

| Objetivo | Leitura |
|---|---|
| Avaliar o produto | [README](../README.md), [fluxos](FLUXOS.md) e [demo](DEMO_MODE.md) |
| Entender decisões técnicas | [Arquitetura](ARQUITETURA.md) e [banco de dados](BANCO_DE_DADOS.md) |
| Executar localmente | [Setup](../README.md#setup-local), [variáveis](VARIAVEIS_AMBIENTE.md) e [SQL consolidado](../prisma/consolidated.sql) |
| Validar uma alteração | [Testes](TESTES.md), [regras de negócio](REGRAS_DE_NEGOCIO.md) e [manutenção](MANUTENCAO.md) |
| Compreender a operação | [Deploy](DEPLOY.md), [e-mails](EMAILS.md) e [proteções da demo](DEMO_MODE.md) |

## Referência por assunto

| Documento | Conteúdo |
|---|---|
| [Arquitetura](ARQUITETURA.md) | Frontend, backend, Prisma, sessão, autorização, concorrência e integrações |
| [Banco de dados](BANCO_DE_DADOS.md) | Modelos, enums, constraints e criação pelo SQL consolidado |
| [Fluxos](FLUXOS.md) | Reservas internas/externas, atendimento imediato e transições |
| [Modo Demo](DEMO_MODE.md) | Acesso público, dados fictícios, restrições, e-mails, reset e limites |
| [Variáveis de ambiente](VARIAVEIS_AMBIENTE.md) | Nomes, finalidade, obrigatoriedade e configuração local |
| [E-mails](EMAILS.md) | Resend/disabled, outbox, idempotência e estados de envio |
| [Testes](TESTES.md) | Inventário dos 56 comandos de teste e validação |
| [Deploy](DEPLOY.md) | Build, configuração existente da demo, cron e limites operacionais |
| [Regras de negócio](REGRAS_DE_NEGOCIO.md) | Perfis, capacidades e regras por etapa |
| [Manutenção](MANUTENCAO.md) | Orientações para desenvolvimento contínuo |

## Imagens do produto

As [capturas](assets/README.md) mostram telas reais da demonstração com dados fictícios. Não são protótipos nem imagens geradas da interface.

## Convenções

- O README principal apresenta o produto; os detalhes técnicos permanecem nestes documentos.
- Configurações são descritas por nome e finalidade, sem valores de secrets.
- Supabase é PostgreSQL gerenciado; a autenticação utiliza JWT próprio.
- A estrutura do banco é aplicada pelo SQL consolidado, separadamente do deploy.
- Os dados da demo são compartilhados entre visitantes e restaurados periodicamente.
