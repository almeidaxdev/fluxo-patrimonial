---
name: fluxo-security-review
description: Checklist compacto de revisão de segurança para alterações no Fluxo Patrimonial. Use quando modificar autenticação, autorização, sessões, APIs, inputs, Prisma, colaboradores, solicitações, uploads, e-mails ou qualquer funcionalidade sensível.
---

# Fluxo Patrimonial — Security Review

Use este checklist em mudanças sensíveis.

Não reescreva um relatório gigante automaticamente.

Aplique o checklist internamente e reporte somente problemas reais,
regressões ou decisões relevantes.

---

## 1. Authentication

Verificar:

- login mantém mensagem genérica;
- usuário inativo não autentica;
- bcrypt não recebe input >72 bytes;
- senha não sofre trim/normalização;
- JWT continua 24h;
- versaoSessao está correta;
- cookies mantêm propriedades seguras;
- nenhum segredo vai para logs/resposta.

---

## 2. Rate Limit

Em endpoints já protegidos:

confirmar que limiter não foi removido/reordenado incorretamente.

Especial atenção:

- login;
- cadastro;
- reenvio de assinatura.

Trabalho caro como:

- Prisma;
- bcrypt;
- envio externo;

não deve anteceder rate limit quando a arquitetura aprovada define o
contrário.

---

## 3. Session Revocation

Em mudança de:

- senha;
- e-mail;
- ativo;
- permissao;
- podeSerGestor;
- podeSolicitarParaOutro;

confirmar incremento de versaoSessao.

Múltiplas mudanças na mesma operação:

somente +1.

Nome:

não revoga.

Operações sensíveis devem usar sessão revalidada conforme arquitetura atual.

---

## 4. Authorization

Nunca tratar autenticação como autorização.

Verificar:

- papel;
- capacidade;
- ownership;
- gestor;
- patrimônio/admin;
- solicitanteId;
- ATENDIMENTO_IMEDIATO.

Um payload estruturalmente válido pode continuar sendo não autorizado.

Backend é autoridade final.

---

## 5. Mass Assignment

Procurar:

data: body

data: { ...body }

spread de body

Object.assign com input

Construir whitelist explícita.

Verificar especialmente:

User:
- senha
- ativo
- permissao
- versaoSessao
- capacidades

Solicitação:
- status
- solicitanteId
- approvals
- timestamps
- workflow

---

## 6. Input Validation

Todo input externo deve ter:

- tipo correto;
- limite;
- enum quando conjunto fechado;
- range para números;
- shape para objetos/arrays;
- validação individual dos itens;
- tratamento coerente de null/undefined.

Backend deve validar mesmo quando frontend valida.

---

## 7. Strings

Preservar limites aprovados do projeto.

Verificar:

- tamanho máximo;
- trim somente quando semanticamente correto;
- senha nunca trim;
- busca limitada;
- textos livres suficientemente generosos.

---

## 8. Arrays

Verificar:

- máximo de elementos;
- shape;
- duplicatas quando não permitidas;
- ids;
- quantidades;
- enums internos.

Evitar payload que gere milhares de operações.

---

## 9. Numbers / Pagination

Verificar:

- Number.isFinite;
- inteiro quando necessário;
- mínimo;
- máximo;
- zero;
- negativo;
- NaN;
- Infinity.

Paginação:

sempre teto server-side.

Nunca confiar no cliente para limit/pageSize.

---

## 10. IDs

Validar formato/tamanho conforme o tipo REAL utilizado no schema.

Não assumir UUID/CUID sem conferir.

Evitar strings gigantes chegando ao Prisma como ID.

---

## 11. Dates

Verificar:

- formato;
- parse;
- Invalid Date;
- timezone quando relevante;
- regras de negócio existentes preservadas.

Não alterar antecedência/períodos sem escopo explícito.

---

## 12. Workflow Integrity

Status de solicitação nunca deve ser mass-assigned.

Mudanças de estado devem continuar por operações específicas.

Revalidar transições e concorrência quando a mudança tocar workflow.

---

## 13. Prisma

Verificar:

- queries parametrizadas;
- ausência de raw SQL inseguro;
- transações quando necessárias;
- concorrência;
- unique constraint;
- P2002 tratado quando esperado;
- nenhuma query redundante introduzida.

Não alterar schema/banco sem autorização.

---

## 14. Sensitive Fields

Cliente nunca deve controlar diretamente:

- versaoSessao;
- password hash;
- createdAt;
- updatedAt;
- timestamps internos;
- idempotency keys;
- EmailEvento state;
- approval timestamps;
- campos server-generated.

---

## 15. Error Handling

Não devolver:

- stack;
- Pxxxx desnecessário;
- SQL;
- nome de constraint;
- tabela;
- secret;
- connection details.

400/401/403/404/409/429/500 devem manter semântica correta.

401:
pode acionar revogação global no frontend.

403:
NÃO deve encerrar sessão.

---

## 16. JSON

JSON malformado deve produzir erro controlado quando aplicável.

Não criar duplicação enorme de try/catch se um helper simples resolver.

Não ler body no middleware Edge apenas para hardening.

---

## 17. XSS / HTML

Procurar:

dangerouslySetInnerHTML

Se React renderiza string normal:
React já faz escaping.

Templates HTML de e-mail são contexto diferente:

qualquer input controlado por usuário interpolado em HTML deve ser escapado
adequadamente.

Não adicionar sanitizador pesado sem necessidade.

---

## 18. E-mail Security

Preservar:

- escape contextual;
- idempotência;
- destinatário lógico;
- geração;
- EmailEvento;
- test mode;
- group recipient.

Não permitir HTML injection por:

- nome;
- finalidade;
- observação;
- motivo;
- local;
- itens;
- solicitante;
- gestor.

---

## 19. Logs

Nunca logar:

- senha;
- senha atual;
- nova senha;
- senha temporária;
- JWT;
- Cookie;
- Authorization;
- DATABASE_URL;
- secrets;
- body inteiro de auth.

console.error deve conter apenas contexto seguro.

---

## 20. Email Domain

User.email novo:

domínio dentro da lista configurada em ALLOWED_EMAIL_DOMAINS (fail-closed:
variável ausente/vazia/inválida rejeita tudo).

Normalizar:

trim + lowercase.

Legado:
pode permanecer se não for alterado.

Mudança real:
deve migrar para domínio válido e revogar sessão.

---

## 21. Performance Security

Uma mitigação de segurança não deve introduzir:

- N+1;
- query de User em todos os GETs comuns;
- polling;
- chamadas duplicadas;
- query redundante;
- consultas gigantes sem paginação.

Preferir proteção seletiva baseada em risco.

---

## 22. Middleware

Middleware permanece sem Prisma.

Não introduzir conexão PostgreSQL no Edge para revalidar sessão.

---

## 23. Frontend Trust

Nunca considerar seguro porque:

- botão está desabilitado;
- campo está hidden;
- select não oferece opção;
- TypeScript não permite;
- componente não envia.

Usuário pode chamar API manualmente.

Regras sensíveis sempre no backend.

---

## 24. Regression Checklist

Antes de concluir mudança sensível, verificar impacto em:

S3:
solicitar para outro.

S4:
rate limiting.

S5:
revogação de sessão.

S5.1:
AuthProvider / ativo-inativo / edição de colaborador.

S6:
validações já implementadas.

Não precisa explicar todos se estiverem intactos.

Apenas reportar regressão ou risco encontrado.

---

## 25. Testes

Criar testes focados no risco alterado.

Preferir:

- limite;
- limite + 1;
- input inválido;
- autorização inválida;
- ausência de efeito colateral;
- regressão do cenário legítimo.

Não criar testes redundantes apenas para aumentar contagem.

---

## 26. Output

Ao usar esta skill, NÃO produzir automaticamente uma auditoria longa.

Na entrega, priorizar:

1. vulnerabilidades/regressões encontradas;
2. correções realizadas;
3. decisões que precisam de aprovação;
4. testes;
5. riscos residuais.

Se tudo estiver correto, dizer de forma concisa.
