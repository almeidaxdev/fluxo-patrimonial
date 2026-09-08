# Testes — Fluxo Patrimonial

O projeto usa scripts de teste próprios (`ts-node` + `tsconfig-paths`), sem framework de teste (não usa Jest/Vitest). Cada script sobe um cenário isolado com mocks em memória de Prisma, sessão e envio de e-mail — **sem banco real, sem envio real de e-mail**. Total atual: **46 scripts**, todos registrados em `package.json` sob o prefixo `test:` — contagem tirada diretamente de `package.json` (`Object.keys(scripts).filter(k => k.startsWith('test:')).length`), nunca de memória; recontar sempre que um script for adicionado/removido.

Não há medição de cobertura de código configurada no projeto — nenhuma métrica de "% de cobertura" é reportada aqui porque nenhuma ferramenta a calcula atualmente.

## Como rodar

```bash
npm run test:<nome-do-script>
```

Cada script roda isoladamente (não há um runner único tipo `npm test` que execute todos em sequência hoje). Para rodar todos manualmente, execute cada `test:*` listado em `package.json` um a um — o exit code de cada `ts-node` reflete sucesso/falha do respectivo script.

## Scripts por área

### Infraestrutura de e-mail (config, outbox, dispatcher)
- `test:email-config` — validação de `getEmailConfig()`.
- `test:email-processar-evento` — processamento individual de um `EmailEvento`.
- `test:email-dispatcher` — `processarEmailsPendentes()` (`src/lib/email/dispatcher.ts`).
- `test:email-validade-evento` / `test:validade-evento` — regras de validade/estado de um evento antes do envio.
- `test:email-destinatarios` — resolução de destinatário lógico (inclui a caixa de grupo do Patrimônio).

### Payload de e-mail por tipo de evento
- `test:email-reserva-confirmada` / `test:email-reserva-confirmada-payload`
- `test:email-data-civil` / `test:data-civil`
- `test:email-solicitacao-aguardando-gestor-payload`
- `test:email-assinatura-pendente-payload`
- `test:email-rejeicao-payload`
- `test:email-cancelamento-payload`
- `test:email-aguardando-patrimonio-payload`

Cobrem a montagem do conteúdo de cada um dos 9 tipos de `TipoEmailEvento` (ver `docs/EMAILS.md`).

### Concorrência
- `test:separacao-concorrencia`
- `test:confirmar-patrimonio-concorrencia`
- `test:assinatura-confirmar-concorrencia`

Simulam duas requisições simultâneas para a mesma transição de status, confirmando que o padrão `updateMany` condicionado (ver `docs/ARQUITETURA.md`, seção Concorrência) garante que só uma vence.

### Fluxo de solicitações (rotas de negócio)
- `test:confirmar-patrimonio-reserva-confirmada`
- `test:assinatura-confirmar-reserva-confirmada`
- `test:solicitacoes-post-aguardando-gestor`
- `test:solicitacoes-assinatura-pendente`
- `test:solicitacoes-rejeicoes`
- `test:solicitacoes-cancelar`
- `test:solicitacoes-aprovar-gestor`
- `test:solicitacoes-email-patrimonio-interna`
- `test:solicitacoes-ambiente-interno`
- `test:solicitacoes-para-outro` (Etapa `security/request-for-another`) — autorização de "solicitar para outro colaborador" (capacidade `podeSolicitarParaOutro`, papéis Gestor/Patrimônio/Admin, tentativa de forjar a capacidade pelo body, edição da capacidade pelo Admin).

### Colaboradores
- `test:colaboradores-reset-senha` — redefinição de senha temporária por Administrador.
- `test:colaboradores-perfil` (Etapa `fix/collaborator-session-sync`) — edição de nome/e-mail (validação do domínio permitido (ALLOWED_EMAIL_DOMAINS) `@example.com`, normalização, unicidade, um único incremento de `versaoSessao` por chamada mesmo com vários campos sensíveis juntos), status da conta (ativar/desativar, proteção contra auto-desativação, login bloqueado para inativo), rejeição de domínio em toda criação de `User` (cadastro público e criação pelo Admin), normalização de e-mail no login, e o cenário de regressão fim-a-fim de capacidade removida em sessão já aberta.

### Segurança / sessão
- `test:security-headers` — headers de segurança aplicados a toda rota (`next.config.js`).
- `test:rate-limit` (Etapa S4) — `checkSensitiveRateLimit()`/namespaces por ação sensível.
- `test:session-jwt` (Etapa `security/session-revocation`) — `signToken()`/`verifyToken()`/`setSession()`: claim `versaoSessao`, expiração de 24h, cookie.
- `test:session-revalidation` (Etapas `security/session-revocation` + `fix/collaborator-session-sync`) — `getValidatedMutationSession()` isolado, `GET /api/auth/me`, gatilhos de `versaoSessao` via `PATCH /api/colaboradores/[id]`/`PATCH /api/auth/senha`, os dois GETs privilegiados revalidados (`GET /api/patrimonios`, `GET /api/solicitacoes?escopo=todas`) e a prova fim-a-fim de que uma sessão revogada por gatilho (não por expiração) para de mutar imediatamente.
- `test:idle-session-timeout` (Etapa `feat/idle-session-timeout`) — lógica pura de `src/lib/idle-session.ts` (estado ativo/aviso/expirado a partir de timestamps sintéticos, incluindo o caso de lacuna muito maior que 1h — notebook em suspensão) e verificação estrutural de que `AuthProvider`/`login/page.tsx` conectam essa lógica corretamente: atividade real nunca inclui `focus`/`visibilitychange`/requisições automáticas, multi-aba via evento `storage`, `?inatividade=1` com guarda de exibição única, JWT 24h e S5/S5.1 (`middleware.ts` sem Prisma) inalterados.

### Hardening de input (Etapa `security/input-hardening` — S6, B1-B5)
- `test:senha-hardening` (B1) — mínimo 8 code points/máximo 72 bytes UTF-8 da senha nova, regra mais fraca da senha atual/login, ausência de trim/normalização, geração segura de senha temporária.
- `test:input-hardening-b2` (B2) — limites de `LIMITES_INPUT` e enums explícitos (`permissaoEnum`/`statusSolicitacaoEnum`/`escopoSolicitacaoEnum`/`tipoEmprestimoEnum`/`tipoDominioEnum`/`periodoEnum`), em isolamento e através dos handlers reais.
- `test:input-hardening-b3` (B3) — limites de array (`patrimonioIds`/`itensPapelaria`/`servicos`/`periodos`), números (`quantidade`), paginação real (`GET /api/solicitacoes`, `/api/patrimonios`) e datas (`Invalid Date`/calendário civil) nas rotas reais.
- `test:input-hardening-b4` (B4) — `.strict()` rejeitando campo extra nos schemas que recebem o objeto inteiro do cliente, `enviarAssinaturaSchema` restrito a `http(s)`, e corpo JSON malformado devolvendo `400` (nunca `500`) nas rotas reais.
- `test:input-hardening-b5` (B5) — `escapeHtml()` em isolamento, um template de e-mail real confirmando que campos do usuário chegam escapados no HTML (nunca no texto puro), e verificação estrutural de que nenhum arquivo em `src/` usa `dangerouslySetInnerHTML`.

### Painel do Patrimônio (Etapa `feat/patrimonio-operational-ux`)
- `test:patrimonio-operational-ux` — páginas pessoais de colaborador (`/nova-solicitacao`, `/minhas-solicitacoes`) bloqueadas por middleware para o perfil PATRIMONIO (nunca só o Sidebar), regressão das rotas operacionais e dos perfis Admin/Colaborador/Gestor, `naoRetiradas` em `GET /api/dashboard` só para Patrimônio/Admin, `STATUS_PENDENCIA_PATRIMONIO` restrito a status com ação real, e a cadeia completa card → query string → filtro aplicado em `/todas-solicitacoes` (via as funções reais de `filtros.ts`, não só o href do card).

### Dashboard do Administrador (Etapa `feat/admin-dashboard-operational`)
- `test:admin-dashboard-operational` — verificação estrutural de `lobby/page.tsx`/`PainelPatrimonio.tsx`/`OperacaoPatrimonio.tsx`/`Sidebar.tsx`: Admin mantém todos os cards/ações pessoais ("Minha atividade": Nova Solicitação, Minhas solicitações em andamento, assinaturas pendentes, prontas para retirada, aprovações condicionais), a seção "Operação do Patrimônio" reaproveita o MESMO componente compartilhado (`OperacaoPatrimonio`) e a MESMA função de soma (`calcularTotalAtencaoPatrimonio`, chamada diretamente aqui com valores sintéticos) do Painel do Patrimônio — nunca uma segunda definição, exibida só para `permissao === 'administrador'`, sem nenhum dos status operacionais hardcodado fora do componente compartilhado (`/todas-solicitacoes?status=...` nunca aparece em `lobby/page.tsx`), e o contrato `PatrimonioStats` (em `src/lib/patrimonio-dashboard.ts`, módulo sem JSX) sem os campos antigos (`aguardandoAssinatura`, `internos`, `externos`).

### Cards pessoais do Dashboard (Etapa `feat/admin-dashboard-operational` — homologação pós-entrega)
- `test:dashboard-personal-filters` — a homologação encontrou os cards pessoais ("Minhas solicitações em andamento", "Assinaturas pendentes", "Prontas para retirada") levando para `/minhas-solicitacoes` SEM nenhum filtro aplicado. Cobre: `STATUS_EM_ANDAMENTO_SOLICITANTE` (`src/lib/status.ts`) contém exatamente os 9 status "não terminais/negativos" do solicitante — a MESMA lista usada pelo contador `minhasPendentes` de `GET /api/dashboard` (ver `test:dashboard`, cenário A) e pelo preset `filtro=em_andamento` de `GET /api/solicitacoes`; "Assinaturas pendentes" filtra por `AGUARDANDO_ASSINATURA` do próprio solicitante (nunca confundido com `AGUARDANDO_ENVIO_ASSINATURA`, ação do Patrimônio); "Prontas para retirada" filtra por `PRONTA_RETIRADA`; `/minhas-solicitacoes` usa `useSearchParams()` como única fonte do filtro (sobrevive a F5, sincroniza a URL, permite limpar); os mesmos 3 hrefs valem para Administrador/Colaborador/Gestor (arquivo-fonte único, `lobby/page.tsx`); "Atividades externas" (Gestor) continua abrindo `/aprovacoes` sem filtro adicional (a própria rota já restringe ao gestor autenticado); e chamadas REAIS de `GET /api/solicitacoes` (Prisma mockado) provam que `status=AGUARDANDO_ASSINATURA`/`status=PRONTA_RETIRADA`/`filtro=em_andamento` chegam ao `where` exatamente como esperado, incluindo `filtro` fora do conjunto fechado (`filtroSolicitacaoEnum`) retornando 400.

### Listagem/performance
- `test:patrimonios-pagination` — paginação real de `GET /api/patrimonios`.
- `test:patrimonios-disponibilidade` — cálculo de disponibilidade por categoria/data/período.
- `test:dashboard` — indicadores agregados do dashboard.

## Antes de cada push

`tsc --noEmit`, `eslint` e os scripts `test:*` relevantes à área alterada devem passar localmente antes de qualquer push em `main` — nenhum desses passos roda automaticamente como gate de CI hoje (não há workflow do GitHub Actions configurado neste repositório); a validação é manual, feita pelo desenvolvedor antes do push.
