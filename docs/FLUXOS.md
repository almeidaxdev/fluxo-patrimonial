# Fluxos — Fluxo Patrimonial

[← Documentação](README.md)

Diagramas baseados exclusivamente nos estados e transições reais de `src/lib/status.ts` (`TRANSICOES_PERMITIDAS`) e nas rotas de `src/app/api/solicitacoes/**`. Estados entre parênteses são terminais.

## Fluxo interno

```mermaid
flowchart TD
    A[Criação: solicitação interna] --> B(AGUARDANDO_PATRIMONIO)
    B -->|Patrimônio confirma| C(EM_SEPARACAO)
    B -->|Patrimônio rejeita| D[REJEITADA_PATRIMONIO]
    C -->|Separação registrada| E(PRONTA_RETIRADA)
    E -->|Retirada registrada| F(EM_UTILIZACAO)
    E -->|Prazo de retirada vencido| G[NAO_RETIRADA]
    F -->|Devolução registrada| H[FINALIZADA]
    B -->|Cancelamento| I[CANCELADA]
    C -->|Cancelamento| I
    E -->|Cancelamento| I
```

Sem gestor, sem etapa de assinatura. Campo Ambiente obrigatório na criação.

## Fluxo externo

```mermaid
flowchart TD
    A[Criação: solicitação externa] --> B(AGUARDANDO_GESTOR)
    B -->|Gestor aprova| C(AGUARDANDO_PATRIMONIO)
    B -->|Gestor rejeita| D[REJEITADA_GESTOR]
    C -->|Patrimônio confirma| E(AGUARDANDO_ENVIO_ASSINATURA)
    C -->|Patrimônio rejeita| F[REJEITADA_PATRIMONIO]
    E -->|Link de assinatura enviado| G(AGUARDANDO_ASSINATURA)
    G -->|Assinatura confirmada| H(ASSINATURA_CONFIRMADA)
    H -->|Separação registrada| I(EM_SEPARACAO)
    I -->|Retirada, devolução...| J[... mesma cauda do fluxo interno]
    B -->|Cancelamento| K[CANCELADA]
    C -->|Cancelamento| K
    E -->|Cancelamento| K
    G -->|Cancelamento| K
    H -->|Cancelamento| K
    I -->|Cancelamento| K
```

A partir de `EM_SEPARACAO`, o restante (`PRONTA_RETIRADA` → `EM_UTILIZACAO` → `FINALIZADA`, ou `NAO_RETIRADA`) é idêntico ao fluxo interno.

## Atendimento imediato

```mermaid
flowchart TD
    A[Registro por Patrimônio/Administrador] -->|Há bem patrimonial selecionado| B(EM_UTILIZACAO)
    A -->|Só papelaria/serviço, sem bem| C[FINALIZADA]
    B -->|Devolução registrada| D[FINALIZADA]
```

Sem gestor, sem aprovação prévia, sem cálculo de prazo/antecedência (`prazoHoras`/`antecedenciaMinutos`/`dentroDoPrazo` ficam `null`). Sempre tratado como `tipoEmprestimo: 'interno'` no banco, independente do que for enviado.

## Cancelamento

```mermaid
flowchart TD
    A{Status atual permite cancelar?} -->|AGUARDANDO_GESTOR, AGUARDANDO_PATRIMONIO,\nCONFIRMADA, AGUARDANDO_ENVIO_ASSINATURA,\nAGUARDANDO_ASSINATURA, ASSINATURA_CONFIRMADA,\nEM_SEPARACAO ou PRONTA_RETIRADA| B[Solicitante ou Patrimônio/Administrador cancela]
    B --> C[CANCELADA]
    A -->|EM_UTILIZACAO ou já terminal| D[Cancelamento bloqueado]
```

Não é possível cancelar a partir de `EM_UTILIZACAO` (só resta o caminho de devolução).

## Assinatura (detalhe do fluxo externo)

```mermaid
flowchart TD
    A(AGUARDANDO_ENVIO_ASSINATURA) -->|Patrimônio envia link| B(AGUARDANDO_ASSINATURA)
    B -->|Reenvio do link| B
    B -->|Solicitante confirma, ou Patrimônio valida manualmente| C(ASSINATURA_CONFIRMADA)
```

Não há integração automática com sistema externo de assinatura eletrônica — a confirmação é sempre uma ação manual dentro do sistema.

## Fluxo de e-mails (visão de outbox)

```mermaid
flowchart TD
    A[Ação de negócio dentro de uma transaction] --> B[Criação do EmailEvento: PENDENTE]
    B --> C{Claim atômico\nupdateMany PENDENTE→PROCESSANDO}
    C -->|Só um processo vence| D[PROCESSANDO]
    D -->|Provedor disabled| H[SUPRIMIDO]
    D -->|Envio ao Resend OK| E[ENVIADO]
    D -->|Falha no envio| F[FALHA]
    D -->|Superado por estado mais novo\nda solicitação| G[OBSOLETO]
```

A criação do `EmailEvento` (estado `PENDENTE`) é sempre parte da mesma transaction da ação de negócio que o originou — o envio efetivo (claim → `PROCESSANDO` → resultado) acontece depois, de forma assíncrona/desacoplada, sem poder desfazer a ação de negócio já commitada. Ver `docs/EMAILS.md` para o detalhamento completo de idempotência e retry.
