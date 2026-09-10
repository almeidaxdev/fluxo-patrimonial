# Modo Demo — Fluxo Patrimonial

Documento técnico do ambiente de demonstração pública ("Fluxo Patrimonial —
Demo"), uma instância separada do produto, com infraestrutura própria
(Vercel/Supabase/JWT/secrets independentes do ambiente de produção normal),
usada para mostrar o sistema funcionando a quem não tem acesso a uma conta
real. Nunca compartilha banco, credenciais ou deploy com nenhum outro
ambiente.

## Finalidade

Permitir que qualquer visitante experimente o produto de ponta a ponta
(criar reserva, aprovar, separar, retirar, devolver, ver relatórios) sem
comprometer dados reais e sem exigir credenciais privadas — mantendo, ao
mesmo tempo, a instância sempre em condições de ser mostrada de novo
(reset periódico).

## Variáveis de ambiente

| Variável | Finalidade |
|---|---|
| `DEMO_MODE` | `"true"` ativa as proteções descritas abaixo; `"false"` ou ausente preserva o comportamento normal do produto, sem nenhuma alteração. |
| `DEMO_ACCOUNT_EMAIL` | E-mail da conta demonstrativa pública usada por "Acessar demonstração". Padrão: `admin@example.com`. |
| `DEMO_RESET_SECRET` | Secret exigido (header `x-demo-reset-secret`) para acionar o reset do dataset. Nunca configurado no repositório — só no ambiente da demo. |
| `DEMO_MAX_SOLICITACOES` | Limite global de solicitações simultâneas na demo (defesa em profundidade — ver seção "Rate limiting" abaixo). Só inteiro positivo é aceito; ausente/inválido usa o default seguro (`200`). |
| `EMAIL_PROVIDER=disabled` | Desliga o envio real de e-mail (nenhuma chamada de rede, nenhuma credencial exigida) — normalmente usado junto de `DEMO_MODE=true`, mas é uma opção independente. |

## Modelo: dados mestres somente leitura, core mutável

Implementado em `src/lib/demo-mode.ts` (`assertDemoActionAllowed()`), chamado
no início de cada rota afetada. Nunca depende de esconder um botão no
frontend — mesmo uma chamada direta à API é bloqueada com `403` e a
mensagem `"Ação desabilitada no ambiente de demonstração."`.

Bloqueio POR RECURSO inteiro, não por campo: as telas administrativas
continuam **visíveis** (o visitante navega e vê os dados fictícios), mas
qualquer `POST`/`PATCH`/`DELETE` nelas é recusado, sem exceção:

- **Colaboradores** — criar, editar (qualquer campo, inclusive nome) ou
  excluir. Cobre automaticamente a conta demonstrativa (`DEMO_ACCOUNT_EMAIL`)
  — ela não é mais um caso especial, é só mais um colaborador, e todo
  colaborador é somente-leitura na demo.
- **Patrimônios** — criar, editar ou excluir.
- **Categorias** — criar, editar ou excluir.
- **Tipos de serviço** — sem rota de mutação nesta base de código; nada a
  bloquear (documentado/testado para o caso de uma rota futura).
- Trocar a própria senha (`PATCH /api/auth/senha`).
- Autocadastro (`POST /api/auth/cadastro`).

Continuam liberados por inteiro (é o que a demo existe para mostrar, e é
restaurado pelo reset a cada ciclo): todo o fluxo de solicitações — criar,
aprovar/rejeitar por gestor e Patrimônio, separar, retirar, devolver,
cancelar, assinatura, atendimento imediato — e consultas/relatórios.
Verificado por dois meios em `scripts/test-demo-mode-routes.ts`: chamada
dinâmica real às rotas do fluxo (prova que a resposta nunca é o 403 do gate
de demo) e verificação estática de que nenhuma delas importa
`src/lib/demo-mode` (única forma possível de serem afetadas).

## Acesso público ("Acessar demonstração")

`POST /api/demo/entrar` autentica diretamente na conta configurada em
`DEMO_ACCOUNT_EMAIL`, usando exatamente o mesmo mecanismo de sessão do login
normal (`src/lib/auth.ts`) — sem pedir e-mail/senha do visitante, sem expor
hash/senha em nenhum momento. Só existe (responde diferente de `404`)
quando `DEMO_MODE=true`. Protegido por rate limit (mesma infraestrutura de
`src/lib/rate-limit.ts`).

## Reset do dataset

O dataset demonstrativo (usuários, categorias, tipos de serviço, patrimônios
e solicitações) é definido uma única vez em `src/lib/demo/dataset.ts` —
tanto `prisma/seed.ts` (carga inicial) quanto a rota de reset usam a mesma
fonte, nunca duas definições divergentes.

`POST /api/internal/demo-reset` restaura o dataset. Foco principal: as
tabelas TRANSACIONAIS (solicitações e tudo que pende delas — itens,
histórico, assinaturas, notificações, eventos de e-mail) são apagadas e
recriadas do zero a cada reset — é o único lugar onde um visitante consegue
alterar algo, já que dados mestres são somente-leitura (ver seção acima).
Usuários/categorias/tipos de serviço/patrimônios continuam sendo
validados/restaurados via `upsert` (nunca com `deleteMany`) como defesa em
profundidade — não porque um visitante possa criar registros extras (não
pode mais), mas para o caso de uma divergência introduzida fora da API
(ex.: edição manual no banco). Tudo dentro de uma única transação.

Protegida por:
- só responde quando `DEMO_MODE=true` (`404` fora disso);
- exige o secret `DEMO_RESET_SECRET` no header `x-demo-reset-secret` (nunca
  em query string), comparado em tempo constante;
- nunca aceita uma sessão de usuário comum como autenticação — nem o
  Administrador Demo consegue disparar isto.

Reset manual (ex.: antes de uma apresentação ao vivo): `npm run demo:reset`
(lê `APP_URL`/`DEMO_RESET_SECRET` do ambiente local, nunca expõe o secret ao
navegador). Reset periódico automático: preparado no código, mas nenhum
cron foi configurado ainda — ver `docs/DEPLOY.md` quando a infraestrutura da
demo for provisionada.

## E-mail desabilitado

Com `EMAIL_PROVIDER=disabled`, `sendEmail()` (`src/lib/email/send-email.ts`)
usa um provedor no-op (`src/lib/email/providers/disabled.ts`) que nunca faz
nenhuma chamada de rede. `EmailEvento.status` tem um estado terminal
dedicado — `SUPRIMIDO` (`prisma/schema.prisma`/`prisma/consolidated.sql`) —
nunca confundido com `ENVIADO` (que significa entrega real confirmada pelo
provedor): `providerId` fica registrado como `"disabled"`,
`erro`/`enviadoEm` permanecem `null` (nada falhou, nada foi de fato
entregue). O restante do fluxo (dispatcher, outbox) continua funcionando
normalmente — só sem nenhuma mensagem saindo do sistema.

Como o banco da demo ainda não existe, `SUPRIMIDO` já nasceu no schema
(nenhuma migração aplicada em ambiente real) — ao provisionar o banco da
demo, `prisma/consolidated.sql` já inclui o valor no `CREATE TYPE`.

## Rate limiting — natureza e limites reais

`src/lib/rate-limit.ts` delega para `@vercel/firewall` (`checkRateLimit()`),
que fala com a regra de Firewall configurada no painel da Vercel — não é um
contador em memória local do processo Node. Nesse sentido, o ESTADO do
contador é compartilhado entre todas as instâncias serverless do projeto
(não é por-instância).

Duas ressalvas importantes, já documentadas no próprio arquivo e reforçadas
aqui para quem for provisionar a demo:

1. **Opt-in manual por projeto**: a regra ("Rate Limit ID") precisa ser
   criada manualmente no Dashboard da Vercel do projeto da demo (Firewall →
   Custom Rules) — não existe por padrão num projeto novo. Até essa
   configuração acontecer, `checkRateLimit()` recebe "not-found" do Firewall
   e o código trata isso como fail-open (`limited: false`) — ou seja, **zero
   limitação de fato** enquanto a regra não for publicada manualmente.
2. **Fail-open sempre**: qualquer erro de rede/infraestrutura ao consultar o
   Firewall também resulta em `limited: false` (decisão deliberada — ver
   comentário em `checkSensitiveRateLimit()` — para uma falha do Firewall
   nunca virar indisponibilidade do login/cadastro/demo).

Conclusão prática: trate o rate limit como **mitigação best-effort**, nunca
como barreira de segurança absoluta — mesmo depois de configurado. Ele reduz
automação trivial, mas não impede um agente determinado.

**Cobertura atual**: `login`, `cadastro`, reenvio de assinatura,
`POST /api/demo/entrar`, `POST /api/internal/demo-reset` e, desde esta etapa,
`POST /api/solicitacoes` (só quando `DEMO_MODE=true` — ver abaixo) chamam
`checkSensitiveRateLimit()`. Nenhuma outra rota do workflow (aprovação,
rejeição, separação, retirada, devolução, cancelamento, assinatura) tem
rate limit — nem precisa: elas operam sobre um registro que **já existe**
(não fazem o volume de dados crescer) e são centrais para a experiência da
demonstração, então nunca foram alvo desta proteção.

### Criação de solicitações na demo — duas camadas independentes

`POST /api/solicitacoes`, só quando `DEMO_MODE=true` (fora disso, o handler
é preservado byte a byte — verificado em teste que `prisma.solicitacao.count()`
sequer é chamado nesse caso):

1. **Rate limit por sessão** (`checkSensitiveRateLimit()`, namespace
   `demo-solicitacoes-criar`, chave = id do usuário autenticado — todo
   visitante da demo pública compartilha a MESMA conta via
   `POST /api/demo/entrar`, então um balde por conta é o comportamento
   certo). Sujeito às mesmas ressalvas de best-effort/fail-open acima.
2. **Limite global independente** (`DEMO_MAX_SOLICITACOES`, checado
   DEPOIS do rate limit — se o rate limit já bloqueou, a contagem nem chega
   a ser consultada): conta `prisma.solicitacao.count()` e recusa nova
   criação com `429` e mensagem genérica
   (`"Limite temporário da demonstração atingido. Tente novamente após a
   restauração do ambiente."`) quando o total já atingiu o configurado.
   Não depende do Firewall/Vercel — só do próprio banco — e por isso
   continua funcionando mesmo se o rate limit estiver fail-open por falta
   de configuração no Dashboard.

Nenhuma das duas é uma garantia matemática sob concorrência extrema (duas
requisições simultâneas podem, em teoria, ambas ler a contagem antes de
qualquer uma criar) — deliberado: é uma válvula de segurança para o
contexto de demo pública, não uma arquitetura de controle de concorrência.
As três camadas juntas (rate limit + limite global + reset periódico que
volta tudo ao dataset original) são consideradas suficientes para este
contexto — nenhuma delas, isolada ou em conjunto, deve ser apresentada como
proteção absoluta contra abuso.

## Diferença entre demo e produção

A demo é uma instância separada, nunca um modo de operação da produção:
banco (Supabase) próprio, projeto Vercel próprio, `JWT_SECRET` próprio,
`DEMO_RESET_SECRET` próprio — nenhuma credencial do ambiente institucional é
reaproveitada. `DEMO_MODE=false` (ou ausente) em qualquer outro ambiente
preserva o produto exatamente como sempre foi.
