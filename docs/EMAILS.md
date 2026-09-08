# E-mails — Fluxo Patrimonial

## Provedor

**Resend**, acessado através de um único ponto de saída: `src/lib/email/send-email.ts`. Nenhum outro módulo do projeto chama a SDK do Resend diretamente — qualquer envio, de qualquer fluxo, passa por essa função. Ela nunca lança exceção: sempre retorna um resultado estruturado (`{ success: boolean, ... }`), justamente para que uma falha de e-mail nunca vire uma exceção que derrube a transação de negócio que o originou.

## Variáveis de ambiente (nomes apenas)

- `EMAIL_PROVIDER` — único valor suportado atualmente: `"resend"`.
- `EMAIL_API_KEY` — credencial do provedor.
- `EMAIL_FROM_ADDRESS` / `EMAIL_FROM_NAME` — remetente (nome tem default `"Fluxo Patrimonial"` se ausente).
- `EMAIL_REPLY_TO` — opcional; sem Reply-To se vazio.
- `APP_URL` — base para montagem de links usados nos e-mails (ex.: link de assinatura).
- `EMAIL_TEST_MODE` — aceita **somente** os literais exatos `"true"`/`"false"` (sem trim, sem variação de caixa — qualquer outro valor é erro de configuração).
- `EMAIL_TEST_RECIPIENT` — destino físico único quando `EMAIL_TEST_MODE = "true"` (obrigatório nesse caso, sem fallback para destinatário real).
- `EMAIL_PATRIMONIO_RECIPIENT` — caixa de grupo do Patrimônio (validada separadamente das demais, no momento de decidir o destinatário — não exige `EMAIL_API_KEY`/`EMAIL_PROVIDER` válidos só para ser checada).

Ver `docs/VARIAVEIS_AMBIENTE.md` para a tabela completa de todas as variáveis do projeto. Nenhum valor real aparece neste documento.

## EMAIL_TEST_MODE — lógico vs. físico

O sistema distingue **destinatário lógico** (quem, na regra de negócio, deveria receber o e-mail — ex.: o solicitante, o gestor, a caixa de grupo do Patrimônio) do **destinatário físico** (para onde o e-mail realmente é entregue pelo provedor).

- Com `EMAIL_TEST_MODE = "true"`: o destinatário lógico é sempre preservado em `EmailEvento.destinatario` e citado no próprio corpo/banner do e-mail ("destinatário original: ..."), mas o envio físico é **sempre** redirecionado para `EMAIL_TEST_RECIPIENT`. Nenhum destinatário real recebe nada nesse modo — usado em homologação para não vazar e-mail de teste a usuários/gestores reais.
- Com `EMAIL_TEST_MODE` desabilitado (produção): destinatário lógico e físico coincidem.

## Caixa de grupo do Patrimônio

E-mails cujo destinatário operacional é "a equipe Patrimônio" como um todo (não um usuário individual) são sempre endereçados a uma única caixa de grupo, configurada em `EMAIL_PATRIMONIO_RECIPIENT` — nunca um e-mail por usuário com `permissao = 'patrimonio'`. Essa é uma decisão deliberada: evita duplicidade de e-mail quando há vários membros na equipe, e centraliza a triagem operacional em uma caixa compartilhada. As **notificações in-app** (`Notificacao`) não seguem essa regra — continuam sendo criadas individualmente, uma por membro ativo da equipe Patrimônio, para cada evento relevante.

Quando `EMAIL_PATRIMONIO_RECIPIENT` está ausente ou inválida, o sistema registra um log de observabilidade com prefixo `[Email]` explicitando a falha de configuração — não falha silenciosamente, e não derruba a transação de negócio.

## Ciclo de vida do EmailEvento

```
PENDENTE
  → (claim atômico via updateMany PENDENTE→PROCESSANDO; só um processo vence)
PROCESSANDO
  → sucesso no envio ao Resend → ENVIADO
  → falha no envio → FALHA (tentativas incrementado)
  → evento superado por um estado mais novo da solicitação → OBSOLETO
```

Cada linha de `EmailEvento` é criada **dentro da mesma transaction** da ação de negócio que a originou (criação da solicitação, aprovação, confirmação, etc.) — garantindo que o registro do evento nunca fique dessincronizado do estado real da solicitação.

## Retry

`tentativas` é incrementado a cada tentativa de envio malsucedida. O dispatcher (`processarEmailsPendentes`, em `src/lib/email/dispatcher.ts`) é capaz de reprocessar eventos em `PENDENTE`/`FALHA`, mas **não está agendado**: não há rota que o chame em `src/app/`, nem cron configurado (não há `vercel.json` com cron neste projeto). Ele existe como infraestrutura testada e pronta para ser acionada (manualmente ou por um agendador futuro), não como um processo em execução automática hoje.

## Idempotência

Duas camadas:

1. **Estrutural**: a unique constraint `[solicitacaoId, tipo, destinatario]` em `EmailEvento` impede a criação de mais de um evento para a mesma combinação, mesmo que a rota que o cria seja chamada mais de uma vez (ex.: reenvio de link de assinatura não duplica o `ASSINATURA_PENDENTE` já existente — a lógica de reenvio atualiza o evento existente, não cria um novo).
2. **De entrega**: a chamada ao Resend usa uma chave de idempotência que combina o id do `EmailEvento` com uma **geração lógica** do envio (não o contador bruto de `tentativas`) — isso evita reenviar fisicamente um e-mail cuja entrega já havia sido confirmada pelo provedor em uma tentativa anterior ambígua (ex.: timeout de rede após o provedor já ter aceitado o envio).

## Geração (payload)

Eventos cujo conteúdo depende do estado da solicitação **no momento do envio**, não no momento de uma eventual reconsulta futura (ex.: `RESERVA_CONFIRMADA`, que resume os itens/datas/período confirmados), gravam um snapshot em `EmailEvento.payload` (`Json?`) no momento da criação do evento. Isso garante que o corpo do e-mail (mesmo se enviado ou reenviado depois, por retry) reflita o estado da solicitação **quando o evento foi gerado**, não um estado posterior potencialmente diferente.

## Falhas

Uma falha de envio de e-mail **nunca desfaz nem bloqueia a operação de negócio que a originou** — a transação que muda o status da solicitação, grava histórico e cria notificações in-app é sempre commitada independentemente do resultado do envio de e-mail (que, quando síncrono ao fluxo, usa `Promise.allSettled` para isolar falhas de e-mail de outras operações paralelas, evitando que uma falha de e-mail derrube uma resposta HTTP de sucesso). O evento fica registrado em `FALHA` para investigação/retry, mas o usuário nunca vê a ação de negócio falhar por causa de um problema no envio de e-mail.

## Matriz de e-mails

Ver a matriz completa (evento / destinatário / quando) em `docs/REGRAS_DE_NEGOCIO.md`, seção "E-mails" — os mesmos 9 valores de `TipoEmailEvento` documentados ali são os únicos tratados por `construirTemplate()` em `src/lib/email/dispatcher.ts`.
