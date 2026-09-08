// scripts/test-idle-session-timeout.ts
//
// Etapa feat/idle-session-timeout — logout automático após 1h SEM
// atividade real, mecanismo separado da validade absoluta do JWT (24h,
// inalterada). Dois grupos de verificação:
//
//   1) Lógica PURA (src/lib/idle-session.ts) — testada diretamente com
//      timestamps sintéticos, nunca esperando 55/60 minutos reais e sem
//      fake timers de framework (este projeto não usa nenhum): A, B, D, F,
//      G, K.
//   2) Verificação ESTRUTURAL do arquivo-fonte — mesmo padrão já usado em
//      scripts/test-session-revalidation.ts (item AF, para middleware.ts) e
//      scripts/test-patrimonio-operational-ux.ts (itens G/H): confirma que
//      a lógica pura está de fato CONECTADA aos eventos certos do
//      navegador, sem precisar de um renderer de React (ausente neste
//      projeto): C, H, I, J, L, M, N, O, P.
//
// Cobertura (rótulos do pedido):
//   A) atividade inicial cria timestamp.
//   B) atividade antes de 55min renova timestamp.
//   C) focus/visibilitychange sozinhos NÃO chamam registrarAtividade.
//   D) 55min sem atividade → estado 'aviso'.
//   E) "Continuar conectado" grava atividade E fecha o aviso.
//   F) 60min sem atividade → estado 'expirado'.
//   G) uma lacuna muito maior que 60min (ex.: notebook em suspensão) também
//      resulta em 'expirado' — a decisão nunca depende de "quanto tempo os
//      timers rodaram", só da diferença real entre dois timestamps.
//   H) revalidate()/interceptor 401 nunca chamam registrarAtividade.
//   I) evento `storage` (outra aba) recalcula o estado local.
//   J) atividade fresca (calculada a partir do timestamp) reabre em 'ativo'
//      — a mesma condição que fecha um aviso local desatualizado.
//   K) logout (explícito ou automático) remove o timestamp.
//   L) revogação de sessão (S5/S5.1) também limpa o timestamp.
//   M) "?inatividade=1" é exibido só uma vez (guarda + limpeza da URL).
//   N) "?revogada=1" continua funcionando (regressão).
//   O) a guarda de exibição única usa `useRef` (sobrevive a dupla invocação
//      do efeito em React Strict Mode) — mesmo mecanismo já usado e
//      homologado para "?revogada=1".
//   P) JWT continua com validade absoluta de 24h — não alterado por esta
//      etapa.
//   Q) S5/S5.1: não alterados por esta etapa (src/lib/session-validation.ts
//      e src/middleware.ts intocados) — já cobertos exaustivamente por
//      scripts/test-session-revalidation.ts; não duplicado aqui.
//
// Executar com: npm run test:idle-session-timeout

import { readFileSync } from 'fs'
import { join } from 'path'

export {}

let failures = 0

function assert(condition: boolean, label: string, detalhe?: unknown) {
  if (condition) {
    console.log(`OK   - ${label}`)
  } else {
    failures++
    console.error(`FALHA - ${label}${detalhe !== undefined ? ` (${JSON.stringify(detalhe)})` : ''}`)
  }
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function criarStorageFake(): StorageLike {
  const dados = new Map<string, string>()
  return {
    getItem: (k) => (dados.has(k) ? dados.get(k)! : null),
    setItem: (k, v) => { dados.set(k, v) },
    removeItem: (k) => { dados.delete(k) },
  }
}

async function main() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {
    IDLE_STORAGE_KEY,
    INATIVIDADE_TOTAL_MS,
    AVISO_A_PARTIR_DE_MS,
    calcularEstadoIdle,
    msAteProximoMarco,
    msAteExpirar,
    lerUltimaAtividade,
    registrarAtividade,
    limparAtividade,
  } = require('../src/lib/idle-session')

  // ===========================================================================
  // Parte 1 — lógica pura (timestamps sintéticos)
  // ===========================================================================

  const T0 = 1_700_000_000_000 // instante de referência arbitrário (epoch ms)

  // --- A) atividade inicial cria timestamp ---------------------------------
  {
    const storage = criarStorageFake()
    assert(lerUltimaAtividade(storage) === null, 'A) sem atividade prévia, lerUltimaAtividade() é null', true)
    registrarAtividade(storage, T0)
    assert(lerUltimaAtividade(storage) === T0, 'A) registrarAtividade() grava o timestamp, lerUltimaAtividade() o devolve', lerUltimaAtividade(storage))
  }

  // --- B) atividade antes de 55min renova o timestamp -----------------------
  {
    const storage = criarStorageFake()
    registrarAtividade(storage, T0)
    const dezMinutosDepois = T0 + 10 * 60 * 1000
    registrarAtividade(storage, dezMinutosDepois)
    assert(lerUltimaAtividade(storage) === dezMinutosDepois, 'B) nova atividade antes de 55min substitui o timestamp anterior', lerUltimaAtividade(storage))
    assert(calcularEstadoIdle(lerUltimaAtividade(storage)!, dezMinutosDepois) === 'ativo', 'B) logo após renovar, o estado é "ativo"', calcularEstadoIdle(lerUltimaAtividade(storage)!, dezMinutosDepois))
  }

  // --- D) 55 minutos sem atividade → estado "aviso" -------------------------
  {
    const aos55min = T0 + AVISO_A_PARTIR_DE_MS
    assert(calcularEstadoIdle(T0, aos55min) === 'aviso', 'D) exatamente aos 55min, o estado é "aviso"', calcularEstadoIdle(T0, aos55min))
    assert(calcularEstadoIdle(T0, aos55min - 1) === 'ativo', 'D) 1ms antes dos 55min, o estado ainda é "ativo"', calcularEstadoIdle(T0, aos55min - 1))
  }

  // --- E) atividade fresca DURANTE o aviso volta a "ativo" e fecha o aviso --
  // ("Continuar conectado" grava Date.now() como nova atividade — ver
  // AuthProvider.continuarConectado(), verificado estruturalmente na Parte 2.
  // Aqui provamos a PARTE numérica: o mesmo timestamp que o clique gravaria
  // realmente reabre o estado em "ativo", que é a condição que fecha o
  // modal em agendarProximaChecagem().)
  {
    const aos56min = T0 + AVISO_A_PARTIR_DE_MS + 60_000
    assert(calcularEstadoIdle(T0, aos56min) === 'aviso', 'E) pré-condição: aos 56min sem atividade, o estado é "aviso"', calcularEstadoIdle(T0, aos56min))
    assert(calcularEstadoIdle(aos56min, aos56min) === 'ativo', 'E) atividade registrada NO INSTANTE do clique recalcula para "ativo"', calcularEstadoIdle(aos56min, aos56min))
  }

  // --- F) 60 minutos sem atividade → estado "expirado" ----------------------
  {
    const aos60min = T0 + INATIVIDADE_TOTAL_MS
    assert(calcularEstadoIdle(T0, aos60min) === 'expirado', 'F) exatamente aos 60min, o estado é "expirado"', calcularEstadoIdle(T0, aos60min))
    assert(calcularEstadoIdle(T0, aos60min - 1) === 'aviso', 'F) 1ms antes dos 60min, o estado ainda é "aviso"', calcularEstadoIdle(T0, aos60min - 1))
  }

  // --- G) lacuna muito maior que 60min (ex.: notebook em suspensão) --------
  {
    const tresHorasDepois = T0 + 3 * 60 * 60 * 1000
    assert(calcularEstadoIdle(T0, tresHorasDepois) === 'expirado', 'G) uma lacuna de 3h (ex.: suspensão) também resulta em "expirado" — decisão por timestamp, nunca por timer', calcularEstadoIdle(T0, tresHorasDepois))
    assert(msAteExpirar(T0, tresHorasDepois) === 0, 'G) msAteExpirar() nunca fica negativo mesmo muito além do limite', msAteExpirar(T0, tresHorasDepois))
  }

  // --- Sanidade: msAteProximoMarco agenda para o marco certo em cada fase ---
  {
    assert(msAteProximoMarco(T0, T0) === AVISO_A_PARTIR_DE_MS, 'Sanidade) logo após atividade, o próximo marco é o aviso (55min)', msAteProximoMarco(T0, T0))
    const noAviso = T0 + AVISO_A_PARTIR_DE_MS
    assert(msAteProximoMarco(T0, noAviso) === INATIVIDADE_TOTAL_MS - AVISO_A_PARTIR_DE_MS, 'Sanidade) já em aviso, o próximo marco é a expiração (mais 5min)', msAteProximoMarco(T0, noAviso))
  }

  // --- K) logout remove o timestamp ------------------------------------------
  {
    const storage = criarStorageFake()
    registrarAtividade(storage, T0)
    assert(lerUltimaAtividade(storage) === T0, 'K) pré-condição: timestamp presente antes do logout', true)
    limparAtividade(storage)
    assert(lerUltimaAtividade(storage) === null, 'K) limparAtividade() remove o timestamp por completo', lerUltimaAtividade(storage))
  }

  assert(IDLE_STORAGE_KEY === 'fluxo-patrimonial:lastActivityAt', 'Sanidade) chave de storage é específica do projeto (nunca genérica)', IDLE_STORAGE_KEY)

  // ===========================================================================
  // Parte 2 — verificação estrutural (arquitetura conectada corretamente)
  // ===========================================================================

  const authProvider = readFileSync(join(__dirname, '..', 'src', 'components', 'auth', 'AuthProvider.tsx'), 'utf8')

  // --- C) focus/visibilitychange NUNCA chamam registrarAtividade -----------
  {
    const blocoFocus = authProvider.slice(authProvider.indexOf('function aoFocarJanela'), authProvider.indexOf('function aoMudarStorage'))
    assert(blocoFocus.includes('agendarProximaChecagemRef.current()'), 'C) focus/visibilitychange disparam uma VERIFICAÇÃO do estado idle', true)
    assert(!blocoFocus.includes('registrarAtividade('), 'C) focus/visibilitychange NUNCA chamam registrarAtividade() diretamente (só verificam, nunca renovam)', true)
  }

  // --- H) revalidate() (GET /api/auth/me) nunca chama registrarAtividade ---
  {
    const blocoRevalidate = authProvider.slice(authProvider.indexOf('const revalidate = useCallback'), authProvider.indexOf('// --- Idle session timeout'))
    assert(blocoRevalidate.includes("fetch('/api/auth/me'"), 'H) revalidate() é de fato a chamada a GET /api/auth/me', true)
    assert(!blocoRevalidate.includes('registrarAtividade('), 'H) revalidate()/interceptor 401 NUNCA chamam registrarAtividade() (request automático não renova o idle timeout)', true)
  }

  // --- I) evento `storage` de outra aba recalcula o estado -------------------
  {
    assert(/aoMudarStorage[\s\S]{0,80}evento: StorageEvent/.test(authProvider), 'I) existe um listener de `storage`', true)
    assert(/evento\.key !== IDLE_STORAGE_KEY/.test(authProvider), 'I) o listener filtra pela chave específica do idle timeout', true)
    assert(/evento\.newValue[\s\S]{0,40}agendarProximaChecagemRef\.current\(\)/.test(authProvider), 'I) atividade de outra aba (newValue presente) reavalia o estado local', true)
  }

  // --- J) reavaliação em 'ativo' fecha um aviso local desatualizado (item 20) ---
  {
    assert(/estado === 'ativo'|else if \(avisoAbertoRef\.current\)/.test(authProvider), 'J) existe um caminho que fecha o aviso quando o estado recalculado é "ativo"', true)
    assert(authProvider.includes('fecharAvisoIdle()'), 'J) fecharAvisoIdle() é chamável a partir da reavaliação (não só do clique manual)', true)
  }

  // --- L) revogação de sessão (S5/S5.1) também limpa o timestamp ------------
  {
    const blocoRevogar = authProvider.slice(authProvider.indexOf('const revogarSessao = useCallback'), authProvider.indexOf('const revalidate = useCallback'))
    assert(blocoRevogar.includes('limparAtividade(window.localStorage)'), 'L) revogarSessao() (S5/S5.1) também limpa o timestamp de atividade', true)
  }

  // --- K, continuação) logout automático e voluntário também limpam --------
  {
    const blocoAuto = authProvider.slice(authProvider.indexOf('const encerrarPorInatividade'), authProvider.indexOf('const sairAgoraDoAviso'))
    assert(blocoAuto.includes('limparAtividade(window.localStorage)'), 'K) logout AUTOMÁTICO por inatividade limpa o timestamp', true)
    assert(blocoAuto.includes("router.replace('/login?inatividade=1')"), 'K) logout automático redireciona para /login?inatividade=1', true)
    const blocoManual = authProvider.slice(authProvider.indexOf('const sairAgoraDoAviso'), authProvider.indexOf('const agendarProximaChecagem = useCallback'))
    assert(blocoManual.includes('limparAtividade(window.localStorage)'), 'K) "Sair agora" (voluntário) também limpa o timestamp', true)
  }

  // --- E, continuação) "Continuar conectado" grava atividade E fecha o aviso ---
  {
    const blocoContinuar = authProvider.slice(authProvider.indexOf('const continuarConectado'), authProvider.indexOf('useEffect(() => {\n    setLoading(true)'))
    assert(blocoContinuar.includes('registrarAtividade(window.localStorage'), 'E) continuarConectado() grava um novo timestamp de atividade', true)
    assert(blocoContinuar.includes('fecharAvisoIdle()'), 'E) continuarConectado() fecha o modal de aviso', true)
  }

  // --- item 19: atividade genérica NUNCA renova enquanto o aviso está aberto ---
  {
    const blocoDetectar = authProvider.slice(authProvider.indexOf('const aoDetectarAtividade'), authProvider.indexOf('const continuarConectado'))
    assert(/if \(avisoAbertoRef\.current\) return/.test(blocoDetectar), '19) aoDetectarAtividade() ignora eventos genéricos enquanto o aviso está aberto', true)
  }

  // --- disableBackdropClose: clique fora do modal nunca aciona "Sair agora" ---
  {
    assert(authProvider.includes('disableBackdropClose'), 'Segurança) o modal de aviso usa disableBackdropClose (clique fora nunca encerra a sessão por engano)', true)
  }

  // --- M/O) "?inatividade=1" exibido só uma vez, mesma guarda de "?revogada=1" ---
  {
    const loginPage = readFileSync(join(__dirname, '..', 'src', 'app', '(auth)', 'login', 'page.tsx'), 'utf8')
    assert(loginPage.includes("useRef(false)"), 'O) a guarda de exibição única usa useRef (sobrevive a dupla invocação em Strict Mode)', true)
    assert(/avisoInatividadeJaExibidoRef/.test(loginPage), 'M) existe uma guarda dedicada para o aviso de inatividade', true)
    assert(/params\.get\('inatividade'\) === '1'/.test(loginPage), 'M) a página de login lê "?inatividade=1"', true)
    assert(/Sessão encerrada por inatividade/.test(loginPage), 'M) mensagem específica de inatividade (nunca reaproveita o texto de "?revogada=1")', true)
    // --- N) "?revogada=1" continua funcionando (regressão) -------------------
    assert(/avisoRevogacaoJaExibidoRef/.test(loginPage) && /params\.get\('revogada'\) === '1'/.test(loginPage), 'N) "?revogada=1" continua sendo tratado (regressão)', true)
    assert(/window\.history\.replaceState\(null, '', window\.location\.pathname\)/.test(loginPage), 'M/N) a URL é limpa após exibir qualquer um dos dois avisos', true)
  }

  // --- P) JWT continua com validade absoluta de 24h -------------------------
  {
    const authLib = readFileSync(join(__dirname, '..', 'src', 'lib', 'auth.ts'), 'utf8')
    assert(authLib.includes(".setExpirationTime('24h')"), 'P) JWT/cookie continua com validade absoluta de 24h (inalterado por esta etapa)', true)
    assert(!authLib.includes('idle') && !authLib.includes('Idle'), 'P) src/lib/auth.ts não ganhou nenhuma referência a idle timeout (mecanismos permanecem separados)', true)
  }

  // --- Q) S5/S5.1: middleware/session-validation não tocados por esta etapa ---
  {
    const middleware = readFileSync(join(__dirname, '..', 'src', 'middleware.ts'), 'utf8')
    assert(!/prisma/i.test(middleware), 'Q) src/middleware.ts continua sem nenhuma referência a Prisma', true)
    assert(!/idle/i.test(middleware), 'Q) src/middleware.ts não ganhou lógica de idle timeout (fica só no client, ver AuthProvider)', true)
  }

  console.log('')
  if (failures > 0) {
    console.error(`${failures} verificação(ões) falharam.`)
    process.exit(1)
  } else {
    console.log('Todas as verificações passaram.')
  }
}

main().catch((e) => {
  console.error('Erro inesperado ao rodar os testes:', e)
  process.exit(1)
})
