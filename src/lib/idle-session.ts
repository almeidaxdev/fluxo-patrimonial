// src/lib/idle-session.ts
//
// Etapa feat/idle-session-timeout — lógica PURA do timeout de inatividade
// (logout automático após 1h sem atividade real). Nenhuma dependência de
// React/DOM aqui de propósito: toda decisão (que estado estamos, quanto
// falta para o próximo marco) é uma função pura de dois números
// (timestamp da última atividade, agora) — testável diretamente com
// timestamps sintéticos, sem esperar 55/60 minutos reais e sem precisar de
// fake timers de um framework de teste (este projeto não tem um). A
// integração com localStorage/eventos do navegador fica inteiramente em
// `src/components/auth/AuthProvider.tsx`.
//
// Mecanismo (ver docs/ARQUITETURA.md, seção "Idle session timeout", para o
// racional arquitetural completo): DOIS relógios independentes, nunca um
// substituindo o outro —
//   - JWT/cookie: validade ABSOLUTA de 24h, inalterada por esta etapa
//     (ver src/lib/auth.ts) — continua sendo a barreira real do servidor.
//   - Idle timeout: 1h SEM atividade real do usuário, decidido inteiramente
//     no client, a partir de um timestamp em `localStorage` — nunca um
//     mecanismo de segurança server-side; ver limitação documentada no
//     comentário de `IDLE_STORAGE_KEY` abaixo.

/** Chave única do projeto em `localStorage` — nunca guarda JWT/senha/dado sensível, só um número (epoch ms). */
export const IDLE_STORAGE_KEY = 'fluxo-patrimonial:lastActivityAt'

/** Tempo total sem atividade até o logout automático. */
export const INATIVIDADE_TOTAL_MS = 60 * 60 * 1000

/** Quanto tempo ANTES da expiração o aviso aparece (aos 55min = 60min − 5min). */
export const AVISO_ANTECEDENCIA_MS = 5 * 60 * 1000

/** Marco (ms decorridos desde a última atividade) em que o aviso começa a ser exibido. */
export const AVISO_A_PARTIR_DE_MS = INATIVIDADE_TOTAL_MS - AVISO_ANTECEDENCIA_MS

export type EstadoIdle = 'ativo' | 'aviso' | 'expirado'

/**
 * Decide o estado atual a partir de DOIS TIMESTAMPS — nunca de um contador
 * de timer. Um `setTimeout` que "deveria" disparar aos 55min não é
 * confiável sozinho (ex.: notebook em suspensão — ver Etapa, item 16): ao
 * retomar, o cálculo aqui usa o `agora` REAL, então detecta corretamente
 * "já passou de 60min" mesmo que nenhum timer tenha rodado nesse meio-tempo.
 */
export function calcularEstadoIdle(ultimaAtividadeEm: number, agora: number): EstadoIdle {
  const decorridoMs = agora - ultimaAtividadeEm
  if (decorridoMs >= INATIVIDADE_TOTAL_MS) return 'expirado'
  if (decorridoMs >= AVISO_A_PARTIR_DE_MS) return 'aviso'
  return 'ativo'
}

/**
 * Milissegundos até o PRÓXIMO marco relevante (aviso, se ainda não chegou;
 * senão a expiração) — usado para agendar um único `setTimeout` para esse
 * instante, nunca um polling por segundo (Etapa, item 17). Nunca negativo.
 */
export function msAteProximoMarco(ultimaAtividadeEm: number, agora: number): number {
  const decorridoMs = agora - ultimaAtividadeEm
  if (decorridoMs < AVISO_A_PARTIR_DE_MS) return AVISO_A_PARTIR_DE_MS - decorridoMs
  return Math.max(0, INATIVIDADE_TOTAL_MS - decorridoMs)
}

/** Milissegundos restantes até a expiração — usado só para a contagem regressiva do modal de aviso (Etapa, item 18). Nunca negativo. */
export function msAteExpirar(ultimaAtividadeEm: number, agora: number): number {
  return Math.max(0, INATIVIDADE_TOTAL_MS - (agora - ultimaAtividadeEm))
}

/**
 * Interface mínima de `Storage` (compatível com `window.localStorage`) —
 * injetada em vez de acessar o global diretamente, para as funções abaixo
 * serem chamáveis em testes (Node, sem DOM) com um fake em memória.
 */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Lê o timestamp persistido — `null` se ausente ou corrompido (nunca lança, nunca usa um valor não numérico). */
export function lerUltimaAtividade(storage: StorageLike): number | null {
  const bruto = storage.getItem(IDLE_STORAGE_KEY)
  if (bruto === null) return null
  const valor = Number(bruto)
  return Number.isFinite(valor) ? valor : null
}

/** Registra `agora` como última atividade. */
export function registrarAtividade(storage: StorageLike, agora: number = Date.now()): void {
  storage.setItem(IDLE_STORAGE_KEY, String(agora))
}

/** Remove o timestamp — chamado em todo caminho de encerramento de sessão (logout explícito, automático por inatividade, ou revogação S5/S5.1). */
export function limparAtividade(storage: StorageLike): void {
  storage.removeItem(IDLE_STORAGE_KEY)
}
