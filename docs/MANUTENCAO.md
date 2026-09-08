# Manutenção — Guia para Desenvolvimento Contínuo

Guia para quem for alterar este projeto depois. Reúne convenções já estabelecidas no código e lições já registradas em incidentes/decisões anteriores — não é uma lista de boas práticas genéricas.

## Antes de alterar qualquer coisa

1. Leia `docs/REGRAS_DE_NEGOCIO.md` e `docs/ARQUITETURA.md` para a área que vai mexer — várias regras (prazos, transições de status, obrigatoriedade de campo) existem por decisão de negócio específica, não por acaso.
2. Confira `src/lib/status.ts` antes de tocar em qualquer transição de status — `TRANSICOES_PERMITIDAS` é a única fonte de verdade sobre o que pode virar o quê; nunca compare/atribua `status` livremente numa rota.
3. Se a alteração envolve e-mail, leia `docs/EMAILS.md` primeiro — o padrão de outbox (`EmailEvento`) e a distinção destinatário lógico/físico existem para evitar reenvio duplicado e vazamento de e-mail em homologação.

## Nova feature

- Toda operação que muda `Solicitacao.status` deve rodar dentro de `prisma.$transaction`, escrevendo status, histórico (`HistoricoSolicitacao`), notificação(ões) in-app e `EmailEvento` juntos, atomicamente.
- Toda transição de status deve usar `updateMany` condicionado ao status **exato** lido antes (`WHERE id = ? AND status = ?`) — nunca `findUnique` + `update` incondicional. Ver `docs/ARQUITETURA.md`, seção Concorrência, e os testes `test:*-concorrencia`.
- Cada API Route deve validar sessão e permissão no próprio handler — nunca confiar apenas na proteção de página do `middleware.ts`. Toda rota de **mutação de negócio** (POST/PATCH/DELETE que muda dado, não só leitura) deve usar `getValidatedMutationSession()` (`src/lib/session-validation.ts`), não `getSession()` puro — ver `docs/ARQUITETURA.md`, seção "Revogação de sessão".
- Se a feature adiciona ou altera um campo em `User` que afeta autenticação/autorização (nova capacidade, novo tipo de permissão, credencial), decida se ele deve incrementar `User.versaoSessao` ao mudar de valor: incrementa se o campo influencia **quem o usuário pode ser/fazer** (mesmo critério já aplicado a `permissao`/`ativo`/`podeSerGestor`/`podeSolicitarParaOutro`/senha/`email`); não incrementa se é só um dado visual/informativo (ex.: `nome`, `gestorPadraoId`). Se decidir que incrementa, adicione o gatilho em `PATCH /api/colaboradores/[id]` (ou na rota equivalente) no mesmo padrão dos gatilhos existentes — um ÚNICO `if` com OR cobrindo todos os campos-gatilho, nunca um `{ increment: 1 }` por campo (uma chamada que muda vários campos sensíveis de uma vez incrementa só +1) — e um teste correspondente em `scripts/test-session-revalidation.ts`/`scripts/test-colaboradores-perfil.ts`. **Edição de e-mail já implementada** (Etapa `fix/collaborator-session-sync`): `PATCH /api/colaboradores/[id]` aceita `email` (validado por `emailPermitidoSchema`, `src/lib/validations.ts` — só `@example.com`, normalizado trim+lowercase) e incrementa `versaoSessao` quando o valor normalizado realmente muda — mesma regra em toda criação de `User` (`POST /api/colaboradores`, `POST /api/auth/cadastro`).
- Se a feature precisa de um novo tipo de e-mail, ele precisa: (a) um novo valor em `TipoEmailEvento`, (b) tratamento em `construirTemplate()` (`src/lib/email/dispatcher.ts`), (c) entrada na matriz de `docs/REGRAS_DE_NEGOCIO.md` e `docs/EMAILS.md`.

## Correção de bug

- Priorize entender a causa raiz antes de alargar timeout, adicionar `try/catch` amplo ou outro contorno — o histórico deste projeto já teve um caso real de erro **P2028** (`Transaction not found`) causado por acúmulo de round-trips numa transaction em ambiente serverless; a correção certa foi reduzir round-trips e dimensionar `maxWait`/`timeout` para o pior caso real da rota, não simplesmente aumentar um número arbitrariamente.
- Uma falha de e-mail nunca deve poder derrubar uma operação de negócio já bem-sucedida — sempre isole envio de e-mail do resultado HTTP da ação principal (`Promise.allSettled` quando paralelo, e outbox assíncrono como padrão preferido).

## Testes

- Todo novo tipo de e-mail, nova transição de status ou nova rota de negócio relevante deve ganhar um script `test:*` correspondente, seguindo o padrão dos scripts existentes (mock de Prisma/sessão/e-mail em memória, sem banco real). Ver `docs/TESTES.md`.
- Arquivos de script sem nenhum `import`/`export` viram **escopo global** quando `tsc` compila o projeto inteiro (o `tsconfig.json` raiz inclui `scripts/**/*.ts`) — isso já causou colisão de nome (`TS2451`) entre scripts com `const`/`function` de mesmo nome. Todo script novo sem imports próprios deve começar com `export {}` para forçá-lo a ser um módulo isolado (convenção já seguida por todos os scripts atuais).

## Build

- `npm run build` deve passar localmente antes de qualquer push em `main` — não há CI configurado neste repositório (sem GitHub Actions) que bloqueie um build quebrado antes do deploy da Vercel.
- `postinstall: prisma generate` já roda automaticamente; não é necessário (nem deve ser adicionado) um passo manual de `prisma generate` antes do build.

## Banco

- Nunca rodar `prisma migrate`/`prisma db push` contra produção como parte de um deploy normal. Qualquer alteração de schema é planejada, revisada e aplicada manualmente (ver `docs/BANCO_DE_DADOS.md`).
- Preferir alterações **aditivas** (nova coluna opcional, novo valor de enum, nova tabela) a alterações destrutivas. Se uma coluna precisa ser descontinuada, considere o padrão já usado no projeto (`observacoesDevolucaoLegado`): manter o campo antigo como legado em vez de apagar dado histórico.

## Sessão e revogação

Ver `docs/ARQUITETURA.md`, seção "Revogação de sessão", para o mecanismo completo (`versaoSessao`, `getValidatedMutationSession()`). Pontos operacionais:

- **Forçar logout de um usuário hoje** (sem esperar o JWT expirar, até 24h): pela tela de Colaboradores (Administrador), qualquer uma destas ações já revoga a sessão do usuário ALVO imediatamente para ações de mutação — desativar (`ativo = false`), resetar a senha, mudar `permissao`, mudar `podeSerGestor`, mudar `podeSolicitarParaOutro`, mudar `email`. Não existe hoje um botão dedicado "encerrar sessão" que não seja uma dessas mudanças — se essa necessidade aparecer, considere adicionar um endpoint que só incrementa `versaoSessao` sem mudar mais nada, em vez de reaproveitar um campo de negócio como pretexto.
- **A revogação agora é percebida pelo FRONTEND, não só pelo backend** (Etapa `fix/collaborator-session-sync`): antes, uma sessão revogada só se manifestava como um 401 na próxima mutação tentada — a tela continuava mostrando as permissões antigas até isso acontecer. O `AuthProvider` (`src/components/auth/AuthProvider.tsx`) revalida `GET /api/auth/me` na montagem, no foco da janela e quando a aba volta a ficar visível (com throttle de 20s) e, ao receber 401, limpa o estado local e redireciona para `/login` — ver `docs/ARQUITETURA.md`, seção "AuthProvider".
- **A revogação é imediata só para mutações e para os GETs privilegiados já revalidados** (ver lista em `docs/ARQUITETURA.md`) — o usuário revogado ainda consegue navegar em telas comuns/GETs não revalidados até o token expirar OU até o AuthProvider revalidar estrategicamente (foco/visibilidade). Isso é esperado, não um bug.
- **Trocar a própria senha sempre encerra a sessão atual** (`PATCH /api/auth/senha`) — o cookie é limpo na própria resposta e o frontend (`/alterar-senha`) redireciona para `/login` automaticamente; não é possível continuar navegando com o token antigo depois de trocar a própria senha.
- **Um token emitido antes desta etapa (sem a claim `versaoSessao`) é sempre rejeitado** na primeira mutação que tentar — nunca tratado como versão `0` (sem fallback `?? 0`, deliberado). Isso significa que, no primeiro deploy desta etapa, TODO usuário já logado será forçado a um novo login na primeira ação de mutação, mesmo sem nenhuma mudança de segurança ter ocorrido — comportamento esperado, avisar o time/usuários antes do deploy se relevante.
- **Nunca** implementar uma forma de invalidar sessão fora de `versaoSessao` (ex.: uma tabela de sessões/blocklist separada) sem revisar esta seção primeiro — o objetivo desta etapa foi resolver revogação sem introduzir estado de sessão no servidor além de um contador por usuário.

## E-mails

- Nunca chamar a SDK do provedor (Resend) fora de `src/lib/email/send-email.ts` — esse é o único ponto de saída, e é o que garante que uma falha de envio nunca vira exceção não tratada.
- Nunca criar um segundo `EmailEvento` para a mesma combinação `[solicitacaoId, tipo, destinatario]` fora do fluxo de reenvio já existente — a unique constraint existe para isso; se precisar de um "reenvio", atualize o evento existente.
- Ao adicionar um novo evento com destinatário "equipe Patrimônio", use sempre `getEmailPatrimonioRecipient()` — nunca volte a montar uma lista de e-mails individuais de usuários com `permissao = 'patrimonio'`.

## Rate limiting

- **Nunca** proteger uma rota nova com `Map`/`Set`/cache em memória do processo — não funciona de forma confiável em serverless (múltiplas instâncias, sem estado compartilhado). Use sempre `checkSensitiveRateLimit()` de `src/lib/rate-limit.ts`.
- O plano Vercel atual (Hobby) só permite **1 regra de Rate Limit por projeto** — por isso todas as ações sensíveis compartilham o mesmo Rate Limit ID (`fluxo-patrimonial-sensitive-actions`) e se isolam por **namespace** dentro da `rateLimitKey` (`login:`, `cadastro:`, `assinatura:`, ...). Para proteger uma nova ação, escolha um namespace novo e distinto — nunca reaproveite um namespace existente para uma ação diferente (os contadores se misturariam).
- Identificadores (e-mail, IP, qualquer dado que possa identificar uma pessoa) **sempre** passam por `checkSensitiveRateLimit()`, que normaliza e faz SHA-256 antes de compor a chave — nunca compor uma `rateLimitKey` manualmente com um identificador em texto puro.
- Se o projeto migrar para um plano Vercel superior (Pro/Enterprise) no futuro, é possível voltar a considerar regras nativas por Dashboard (chave nativa por IP, sem precisar do SDK) para as camadas que hoje usam IP — mas o namespace-por-chave continua sendo a forma correta de isolar contadores de ações diferentes sob o mesmo Rate Limit ID, então não é obrigatório migrar.
- Comportamento em falha de infraestrutura do Firewall: **fail-open** (documentado em `docs/ARQUITETURA.md`, seção "Rate limiting") — nunca transformar uma indisponibilidade temporária do Firewall em indisponibilidade total do login/cadastro.

## Security headers — pendência: CSP

`next.config.js` já aplica os headers simples (`X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, `Permissions-Policy`, `Strict-Transport-Security` em produção), mas **não envia `Content-Security-Policy`** ainda. Antes de habilitar CSP (mesmo em modo `Report-Only`), resolver:

1. **Script inline do `next-themes`**: o `ThemeProvider` injeta um `<script>` inline no `<head>` para evitar flash de tema errado antes da hidratação — um `script-src` sem `'unsafe-inline'` quebra a troca de tema. `next-themes` aceita uma prop `nonce`; isso exige gerar um nonce por request (`src/middleware.ts`) e propagá-lo tanto para o header CSP quanto para o `ThemeProvider`.
2. **Endpoint de report**: sem um `report-uri`/`report-to` configurado, um `Content-Security-Policy-Report-Only` não tem para onde mandar violações — só serviria para inspeção manual no DevTools, o que não vale o ruído de manter uma policy sem visibilidade real de produção.

Recursos externos já mapeados (confirmar que continuam válidos antes de escrever a policy): `style-src`/`font-src` precisam liberar `fonts.googleapis.com`/`fonts.gstatic.com` (Google Fonts, importado em `src/app/globals.css`); nenhum outro domínio externo é usado no client (Resend/Supabase são exclusivamente server-side).

## Boas práticas de performance aprendidas neste projeto

- Preferir `Promise.all`/`Promise.allSettled` para consultas independentes em vez de `await` sequencial.
- Usar `select` enxuto para listagens (GET de lista) e reservar `include` completo apenas para onde o dado é de fato necessário (ex.: montagem de payload de e-mail, tela de detalhe).
- Usar `findFirst` (não `findMany`) quando a pergunta é apenas "existe?".
- Listagens grandes (Todas/Minhas Solicitações, Patrimônios, Colaboradores) devem ter paginação real no backend, não paginação client-side sobre um `findMany` sem `take`/`skip`.
- Busca por texto em listagens deve ter debounce no client (padrão adotado: 300ms) para não disparar uma requisição por tecla.
- Disponibilidade de bens nunca deve ser cacheada — precisa refletir o estado mais atual possível das solicitações que bloqueiam disponibilidade.

## Checklist antes de todo push

- [ ] `npx tsc --noEmit` sem erros.
- [ ] `npm run lint` sem erros.
- [ ] Scripts `test:*` relevantes à área alterada passam.
- [ ] `npm run build` completa sem erros.
- [ ] Nenhum segredo (senha, `DATABASE_URL`/`DIRECT_URL` real, API key, `JWT_SECRET`) foi adicionado a qualquer arquivo versionado.
- [ ] Se houve alteração de schema: NÃO foi aplicada automaticamente contra produção; processo manual documentado em `docs/BANCO_DE_DADOS.md` foi seguido.
- [ ] Se houve novo tipo/fluxo de e-mail: matriz em `docs/REGRAS_DE_NEGOCIO.md`/`docs/EMAILS.md` atualizada.
