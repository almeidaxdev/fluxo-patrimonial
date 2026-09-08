// src/components/auth/AuthProvider.tsx
'use client'

// Etapa fix/collaborator-session-sync
//
// Antes desta etapa, o dado de sessão exibido no frontend (Sidebar, Header,
// telas que usam useSession()) vinha só das claims do JWT, lidas UMA VEZ no
// server (src/app/(dashboard)/layout.tsx, getSession()) e passadas como prop
// estática para baixo — nunca revalidadas durante a navegação client-side
// dentro do mesmo layout. Resultado observado em homologação: um Admin
// remove `podeSolicitarParaOutro` de um colaborador já logado; a S5
// (versaoSessao) já bloqueia corretamente qualquer MUTAÇÃO daquele
// colaborador com o token antigo, mas a aba já aberta continuava
// EXIBINDO a opção "Solicitar para outro colaborador", porque nada no
// client jamais rechamava o servidor para saber que a claim tinha ficado
// obsoleta.
//
// Este provider fecha essa lacuna SEM introduzir polling nem sem colocar
// Prisma no middleware: GET /api/auth/me passou a revalidar (ver
// src/app/api/auth/me/route.ts) e este componente decide QUANDO chamá-lo —
// na montagem, quando a janela recupera o foco e quando a aba volta a ficar
// visível, com throttle simples para não disparar duas vezes quase juntas.
// Se a revalidação vier 401, a sessão foi REVOGADA (não expirada) — nunca
// atualizamos silenciosamente o JWT antigo com as novas permissões; em vez
// disso, encerramos a sessão local e exigimos novo login, para o usuário
// nunca ficar numa tela com uma mistura de dado novo/antigo.
//
// Também instala um interceptor global de `window.fetch` (só enquanto este
// provider está montado, ou seja, só dentro do layout autenticado) que
// captura 401 de QUALQUER chamada `/api/**` feita pelo app — é o tratamento
// centralizado pedido para mutações que já retornam 401 pela S5 (ex.: uma
// ação numa aba com sessão já revogada), sem precisar reescrever os ~17
// pontos do código que chamam `fetch()` diretamente. Nunca intercepta
// `/api/auth/login`/`/api/auth/cadastro` (são chamados fora deste provider,
// nas páginas públicas — mas a exclusão fica explícita mesmo assim, como
// defesa em profundidade).
//
// Etapa feat/idle-session-timeout — logout automático após 1h SEM atividade
// REAL do usuário (distinto do JWT, que continua absoluto em 24h — ver
// src/lib/auth.ts, inalterado). Mecanismo inteiramente client-side, integrado
// aqui (não uma segunda infraestrutura de sessão paralela): toda a decisão
// (que estado estamos, quando é o próximo marco) é feita pelas funções
// PURAS de src/lib/idle-session.ts, a partir de um timestamp em
// `localStorage` — a mesma chave lida por TODAS as abas, o que resolve
// sincronização multi-aba de graça (ver `aoMudarStorage` abaixo) sem
// BroadcastChannel. Ver docs/ARQUITETURA.md, seção "Idle session timeout",
// para o racional completo e a limitação arquitetural (é client-driven;
// o JWT de 24h continua sendo a única barreira real do servidor).

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { SessaoAtual } from '@/types'
import { useToast } from '@/hooks/use-toast'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import {
  IDLE_STORAGE_KEY,
  calcularEstadoIdle,
  msAteProximoMarco,
  msAteExpirar,
  lerUltimaAtividade,
  registrarAtividade,
  limparAtividade,
} from '@/lib/idle-session'

interface AuthContextValue {
  /** `null` só durante o carregamento inicial ou logo antes do redirect de sessão revogada. */
  user: SessaoAtual | null
  loading: boolean
  /** Força uma revalidação imediata (ignora o throttle) — ex.: após o próprio usuário editar seu perfil. */
  revalidateNow: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

// 20s: suficiente para cobrir focus+visibilitychange disparando quase juntos
// (o mesmo gesto do usuário costuma acionar os dois) sem virar polling —
// não há timer nenhum aqui, só throttle de eventos reais do navegador.
const THROTTLE_REVALIDACAO_MS = 20_000

const ROTAS_SEM_TRATAMENTO_DE_REVOGACAO = ['/api/auth/login', '/api/auth/cadastro']

// Etapa feat/idle-session-timeout — eventos que contam como ATIVIDADE REAL
// (item 3 do pedido): discretos, nunca `mousemove` (que dispara centenas de
// vezes por minuto sem throttle forte). `pointerdown` cobre mouse/caneta/
// toque num único evento moderno; `touchstart` fica como reforço para
// navegadores/versões onde Pointer Events tem suporte parcial a touch;
// `keydown` cobre teclado. `focus`/`visibilitychange` são tratados à parte
// (abaixo) — dispensam uma NOVA verificação do estado, mas nunca uma
// renovação automática do timestamp (item 15).
const EVENTOS_DE_ATIVIDADE = ['pointerdown', 'keydown', 'touchstart'] as const

// Throttle da ESCRITA de atividade (não da detecção) — `keydown` durante
// digitação rápida pode disparar dezenas de vezes por segundo; sem isso,
// cada tecla gravaria em `localStorage` (e disparia um evento `storage` em
// TODAS as outras abas). 2s é imperceptível contra uma janela de 60 minutos.
const THROTTLE_ATIVIDADE_MS = 2_000

function formatarMMSS(ms: number): string {
  const totalSegundos = Math.max(0, Math.ceil(ms / 1000))
  const minutos = Math.floor(totalSegundos / 60)
  const segundos = totalSegundos % 60
  return `${minutos}:${String(segundos).padStart(2, '0')}`
}

export function AuthProvider({ initialUser, children }: { initialUser: SessaoAtual; children: React.ReactNode }) {
  const [user, setUser] = useState<SessaoAtual | null>(initialUser)
  const [loading, setLoading] = useState(false)
  const [avisoIdleAberto, setAvisoIdleAberto] = useState(false)
  const [msRestantes, setMsRestantes] = useState(0)
  const router = useRouter()
  const { toast } = useToast()
  const ultimaRevalidacaoRef = useRef(0)
  // Guarda ÚNICA para qualquer caminho de encerramento involuntário de
  // sessão (revogação S5/S5.1 OU inatividade) — evita disparar mais de um
  // redirect se, por coincidência, duas condições forem detectadas quase
  // juntas (ex.: o 401 de uma revalidação chega no mesmo instante em que o
  // timer de inatividade dispara).
  const sessaoEncerradaRef = useRef(false)
  const avisoAbertoRef = useRef(false) // espelha avisoIdleAberto para leitura síncrona dentro de listeners (evita closure velha)
  const ultimaEscritaAtividadeRef = useRef(0)
  const timerIdleRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const intervaloContagemRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // "Latest ref" para `agendarProximaChecagem` (definida mais abaixo) —
  // declarada aqui, ANTES de qualquer uso, para os `setTimeout`/
  // `setInterval` internos dela conseguirem chamar sempre a versão mais
  // recente de si mesma (recursão agendada) sem precisar recriar os timers
  // a cada render. Populada logo após a definição da função.
  const agendarProximaChecagemRef = useRef<() => void>(() => {})

  const revogarSessao = useCallback(() => {
    if (sessaoEncerradaRef.current) return
    sessaoEncerradaRef.current = true
    setUser(null)
    limparAtividade(window.localStorage) // Etapa feat/idle-session-timeout, item 8: toda sessão revogada também encerra o relógio de inatividade.
    // O cookie "session" já foi limpo pela própria resposta 401
    // (respostaSessaoInvalida(), src/lib/session-validation.ts) — aqui só
    // navegamos; nenhuma chamada extra de logout é necessária.
    router.replace('/login?revogada=1')
  }, [router])

  const revalidate = useCallback(
    async (opts?: { throttle?: boolean }) => {
      if (sessaoEncerradaRef.current) return
      const agora = Date.now()
      if (opts?.throttle && agora - ultimaRevalidacaoRef.current < THROTTLE_REVALIDACAO_MS) return
      ultimaRevalidacaoRef.current = agora

      try {
        const res = await fetch('/api/auth/me', { cache: 'no-store' })
        if (res.status === 401) {
          revogarSessao()
          return
        }
        if (!res.ok) return // erro transitório de servidor/rede — nunca desloga por isso
        const data = await res.json()
        if (data.user) setUser(data.user)
      } catch {
        // Rede indisponível — mantém a última sessão conhecida; só o 401
        // explícito do servidor revoga.
      }
    },
    [revogarSessao]
  )

  // --- Idle session timeout (Etapa feat/idle-session-timeout) -------------

  const pararTimersIdle = useCallback(() => {
    if (timerIdleRef.current) {
      clearTimeout(timerIdleRef.current)
      timerIdleRef.current = null
    }
    if (intervaloContagemRef.current) {
      clearInterval(intervaloContagemRef.current)
      intervaloContagemRef.current = null
    }
  }, [])

  const fecharAvisoIdle = useCallback(() => {
    avisoAbertoRef.current = false
    setAvisoIdleAberto(false)
    if (intervaloContagemRef.current) {
      clearInterval(intervaloContagemRef.current)
      intervaloContagemRef.current = null
    }
  }, [])

  /** Logout AUTOMÁTICO por 1h sem atividade (item 12) — distinto de `sairAgoraDoAviso` (clique explícito) só na mensagem/redirect final. */
  const encerrarPorInatividade = useCallback(() => {
    if (sessaoEncerradaRef.current) return
    sessaoEncerradaRef.current = true
    pararTimersIdle()
    avisoAbertoRef.current = false
    setAvisoIdleAberto(false)
    setUser(null)
    limparAtividade(window.localStorage)
    // Preferência do pedido (item 12): reaproveitar o fluxo REAL de logout
    // para limpar o cookie server-side — nunca uma segunda forma de
    // invalidar sessão. Fire-and-forget: a navegação abaixo não deve ficar
    // refém de latência de rede (o JWT em si só seria usável de novo por
    // quem tivesse o cookie, e o browser está navegando para /login mesmo
    // assim).
    fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
    router.replace('/login?inatividade=1')
  }, [router, pararTimersIdle])

  /** "Sair agora" no modal de aviso (item 11) — logout VOLUNTÁRIO, mesmo fluxo/mensagem do botão "Sair" do Header. */
  const sairAgoraDoAviso = useCallback(async () => {
    if (sessaoEncerradaRef.current) return
    sessaoEncerradaRef.current = true
    pararTimersIdle()
    avisoAbertoRef.current = false
    setAvisoIdleAberto(false)
    limparAtividade(window.localStorage)
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
    setUser(null)
    toast({ title: 'Até logo!', description: 'Você saiu do sistema.' })
    router.push('/login')
    router.refresh()
  }, [router, toast, pararTimersIdle])

  /**
   * Recalcula o estado (ativo/aviso/expirado) a partir do timestamp ATUAL —
   * nunca confia em "quanto tempo o timer disse que passou" (item 16:
   * notebook em suspensão). Chamada na montagem, em focus/visibilitychange,
   * quando outra aba sinaliza atividade, e por ela mesma para reagendar o
   * próximo marco — nunca um polling por segundo (item 17): um único
   * `setTimeout` para o PRÓXIMO marco relevante.
   */
  const agendarProximaChecagem = useCallback(() => {
    if (sessaoEncerradaRef.current || typeof window === 'undefined') return
    if (timerIdleRef.current) {
      clearTimeout(timerIdleRef.current)
      timerIdleRef.current = null
    }

    let ultimaAtividade = lerUltimaAtividade(window.localStorage)
    if (ultimaAtividade === null) {
      // Bootstrap (item 7): nunca houve atividade registrada neste
      // navegador (ou o storage foi limpo) — inicializa AGORA. Não é uma
      // "renovação" — não existia nada antes para renovar.
      ultimaAtividade = Date.now()
      registrarAtividade(window.localStorage, ultimaAtividade)
    }

    const agora = Date.now()
    const estado = calcularEstadoIdle(ultimaAtividade, agora)

    if (estado === 'expirado') {
      encerrarPorInatividade()
      return
    }

    if (estado === 'aviso') {
      if (!avisoAbertoRef.current) {
        avisoAbertoRef.current = true
        setAvisoIdleAberto(true)
      }
      setMsRestantes(msAteExpirar(ultimaAtividade, agora))
      // Contagem regressiva (item 18, opcional) — só existe enquanto o
      // aviso está aberto; sempre relê o timestamp a cada tique (nunca
      // assume que nada mudou), então se outra aba renovar a atividade
      // enquanto este intervalo roda, a PRÓXIMA chamada de
      // `agendarProximaChecagem()` (disparada pelo listener de `storage`,
      // não por este `setInterval`) já fecha o aviso — este timer só
      // atualiza o texto "M:SS" e, defensivamente, força uma reavaliação
      // completa se a contagem chegar a zero sem o `setTimeout` principal
      // ter dito nada ainda.
      if (!intervaloContagemRef.current) {
        intervaloContagemRef.current = setInterval(() => {
          const atividadeAtual = lerUltimaAtividade(window.localStorage) ?? ultimaAtividade!
          const restante = msAteExpirar(atividadeAtual, Date.now())
          setMsRestantes(restante)
          if (restante <= 0) agendarProximaChecagemRef.current()
        }, 1000)
      }
    } else if (avisoAbertoRef.current) {
      // 'ativo', mas o aviso desta aba ainda está aberto — outra aba
      // registrou atividade nesse meio-tempo (item 20).
      fecharAvisoIdle()
    }

    timerIdleRef.current = setTimeout(() => agendarProximaChecagemRef.current(), msAteProximoMarco(ultimaAtividade, agora))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encerrarPorInatividade, fecharAvisoIdle])
  agendarProximaChecagemRef.current = agendarProximaChecagem

  /** Listener dos eventos discretos de atividade (item 3/4) — só ESTE caminho grava um novo timestamp. */
  const aoDetectarAtividade = useCallback(() => {
    if (sessaoEncerradaRef.current) return
    // Item 19: com o aviso aberto, uma interação genérica NUNCA renova
    // silenciosamente — só o botão explícito "Continuar conectado"
    // (`continuarConectado`, chamado direto pelo onClick do modal).
    if (avisoAbertoRef.current) return
    const agora = Date.now()
    if (agora - ultimaEscritaAtividadeRef.current < THROTTLE_ATIVIDADE_MS) return
    ultimaEscritaAtividadeRef.current = agora
    registrarAtividade(window.localStorage, agora)
    agendarProximaChecagemRef.current()
  }, [])

  /** "Continuar conectado" no modal (item 10) — única forma de renovar COM o aviso já aberto. */
  const continuarConectado = useCallback(() => {
    const agora = Date.now()
    ultimaEscritaAtividadeRef.current = agora
    registrarAtividade(window.localStorage, agora)
    fecharAvisoIdle()
    agendarProximaChecagemRef.current()
  }, [fecharAvisoIdle])

  useEffect(() => {
    setLoading(true)
    // Interceptor instalado ANTES da primeira chamada a /api/auth/me, para
    // que ela própria já passe por ele (mesmo mecanismo cobre tanto a
    // revalidação estratégica quanto qualquer outra chamada 401 da API).
    const fetchOriginal = window.fetch
    window.fetch = async (...args) => {
      const resposta = await fetchOriginal(...args)
      const entrada = args[0]
      const url = typeof entrada === 'string' ? entrada : entrada instanceof Request ? entrada.url : String(entrada)
      const éChamadaDeApiInterna = url.startsWith('/api/')
      const éRotaExcluida = ROTAS_SEM_TRATAMENTO_DE_REVOGACAO.some((r) => url.startsWith(r))
      if (resposta.status === 401 && éChamadaDeApiInterna && !éRotaExcluida) {
        revogarSessao()
      }
      return resposta
    }

    revalidate().finally(() => setLoading(false)) // A) inicialização
    agendarProximaChecagemRef.current() // inicialização do idle timeout (item 7)

    function aoFocarJanela() {
      revalidate({ throttle: true }) // B) window focus
      agendarProximaChecagemRef.current() // idle: só VERIFICA, nunca renova (item 15)
    }
    function aoMudarVisibilidade() {
      if (document.visibilityState === 'visible') {
        revalidate({ throttle: true }) // C) aba voltou a ficar visível
        agendarProximaChecagemRef.current() // idle: só VERIFICA, nunca renova (item 15)
      }
    }
    // Multi-aba (item 6/20): `storage` dispara nas OUTRAS abas sempre que
    // esta chave muda em localStorage — nunca na própria aba que escreveu.
    // `newValue` presente = outra aba registrou atividade (ou fez o
    // bootstrap dela) → reavalia e fecha um aviso local desatualizado.
    // `newValue` ausente = outra aba REMOVEU o timestamp (logout explícito
    // OU automático por inatividade, em qualquer aba) → nunca uma segunda
    // forma de encerrar sessão aqui: reaproveita a MESMA revalidação já
    // existente — se o cookie realmente sumiu, `/api/auth/me` devolve 401 e
    // cai no `revogarSessao()` de sempre (mensagem genérica, `?revogada=1`).
    function aoMudarStorage(evento: StorageEvent) {
      if (evento.key !== IDLE_STORAGE_KEY) return
      if (evento.newValue) {
        agendarProximaChecagemRef.current()
      } else {
        revalidate({ throttle: false })
      }
    }

    window.addEventListener('focus', aoFocarJanela)
    document.addEventListener('visibilitychange', aoMudarVisibilidade)
    window.addEventListener('storage', aoMudarStorage)
    for (const evento of EVENTOS_DE_ATIVIDADE) {
      window.addEventListener(evento, aoDetectarAtividade, { passive: true })
    }

    return () => {
      window.removeEventListener('focus', aoFocarJanela)
      document.removeEventListener('visibilitychange', aoMudarVisibilidade)
      window.removeEventListener('storage', aoMudarStorage)
      for (const evento of EVENTOS_DE_ATIVIDADE) {
        window.removeEventListener(evento, aoDetectarAtividade)
      }
      window.fetch = fetchOriginal
      pararTimersIdle()
    }
  }, [revalidate, revogarSessao, aoDetectarAtividade, pararTimersIdle])

  const revalidateNow = useCallback(() => revalidate({ throttle: false }), [revalidate])

  return (
    <AuthContext.Provider value={{ user, loading, revalidateNow }}>
      {children}
      <ConfirmDialog
        open={avisoIdleAberto}
        title="Sessão prestes a expirar"
        description={
          <>
            Você está sem atividade há algum tempo. Por segurança, sua sessão será encerrada em{' '}
            <strong className="text-gray-900 dark:text-white">{formatarMMSS(msRestantes)}</strong>.
          </>
        }
        confirmLabel="Continuar conectado"
        cancelLabel="Sair agora"
        variant="warning"
        disableBackdropClose
        onConfirm={continuarConectado}
        onCancel={sairAgoraDoAviso}
      />
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth() só pode ser usado dentro de <AuthProvider>.')
  return ctx
}
