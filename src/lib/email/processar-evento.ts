// src/lib/email/processar-evento.ts
//
// Etapa D.2 — outbox robusto: ponte entre um EmailEvento já persistido
// (PENDENTE, criado dentro da transação de negócio) e o envio real, feito
// SEMPRE depois do commit dessa transação (ver rotas de separação/não-
// retirada) OU por um dispatcher que varre eventos PENDENTE abandonados
// (ver dispatcher.ts). Nunca deve ser chamado de dentro de um
// prisma.$transaction: o envio de e-mail é uma chamada de rede para um
// provedor externo e não pode segurar a transação.
//
// Claim atômico (PENDENTE → PROCESSANDO): a rota que criou o evento e um
// dispatcher que o encontre depois podem, em teoria, chamar
// processarEmailEvento() para o MESMO eventoId por acidente (ex.: o
// processo da rota morreu logo após o COMMIT, antes de terminar de
// processar, e um dispatcher pega o evento ainda PENDENTE). O
// `updateMany` abaixo é a ÚNICA fonte de verdade sobre "quem processa este
// evento" — sob READ COMMITTED (padrão do Postgres/Prisma), duas chamadas
// concorrentes fazendo UPDATE na mesma linha serializam: a primeira muda
// `status` para 'PROCESSANDO' e commita: a segunda, ao ser liberada,
// reavalia o WHERE contra esse valor já commitado — `status: 'PENDENTE'`
// não bate mais, então `count === 0` e ela sai sem enviar nada. Diferente
// de uma trava otimista baseada em `updatedAt` (insuficiente aqui: como o
// valor mudaria a cada claim, um SEGUNDO processo que lesse o registro
// LOGO DEPOIS do primeiro claim conseguiria reivindicar de novo enquanto o
// primeiro ainda está processando), a mudança de `status` em si é a trava —
// exclusiva de verdade, não uma corrida entre leituras.
//
// PROCESSANDO "preso" — TRÊS causas possíveis: processamento em andamento
// (normal, transitório); processo morto no meio (ex.: crash antes de
// chamar o provedor); ou o provedor confirmou o envio mas a persistência
// do status ENVIADO falhou (ver bloco de sucesso abaixo). Por misturar
// "em andamento" com "talvez já entregue", NÃO é seguro reprocessar um
// evento PROCESSANDO automaticamente nesta fase — nem o dispatcher
// (dispatcher.ts) nem processarEmailEvento() fazem isso. Reconciliação de
// eventos PROCESSANDO presos fica para uma fase futura.
//
// OBSOLETO (Etapa D.2 — correção pós-Codex-Review) NÃO é uma dessas causas
// de PROCESSANDO preso: é um estado TERMINAL dedicado, distinto de FALHA
// (não houve erro técnico — a condição de negócio que motivou o envio
// deixou de ser verdadeira, ex.: a solicitação avançou para outro status
// enquanto um EmailEvento PRONTA_RETIRADA ainda estava PENDENTE) e distinto
// de PROCESSANDO (aqui já SABEMOS que não deve mais ser enviado — não é
// incerteza a reconciliar). Também nunca reprocessado automaticamente,
// mas por ser deliberado, não por estar "preso". Ver `aindaValido` abaixo.

import { prisma } from '../prisma'
import { sendEmail } from './send-email'
import { resolvePhysicalRecipient } from './recipient'

export interface RenderedEmail {
  subject: string
  html: string
  text: string
}

export interface BuildEmailContext {
  /** Destinatário lógico original — o mesmo valor persistido em EmailEvento.destinatario. */
  destinatario: string
  /**
   * Igual a `destinatario` quando o envio será redirecionado pelo modo de
   * teste (para o template exibir o banner "AMBIENTE DE TESTE" com o
   * destinatário original); `null` fora do modo de teste.
   */
  bannerDestinatarioOriginal: string | null
}

export type BuildEmailTemplate = (ctx: BuildEmailContext) => RenderedEmail

export interface ProcessarEmailEventoOptions {
  /**
   * Executado logo APÓS o claim bem-sucedido (PENDENTE → PROCESSANDO) e
   * ANTES de montar/enviar qualquer coisa — nunca antes do claim, para não
   * abrir uma janela de corrida entre "validar" e "reivindicar" (ver Etapa
   * D.2, correção pós-Codex-Review: validar antes do claim permitiria que o
   * estado mudasse entre a validação e a reivindicação; validar depois,
   * com posse exclusiva já garantida, elimina essa janela).
   *
   * Retornar `false` sinaliza que o evento ficou OBSOLETO — a condição de
   * negócio que motivou sua criação não é mais verdadeira (ex.: a
   * solicitação avançou para outro status enquanto o EmailEvento
   * PRONTA_RETIRADA ainda estava PENDENTE). Nesse caso, `build`/`sendEmail`
   * NUNCA são chamados — ver ResultadoProcessamento.OBSOLETO.
   *
   * processarEmailEvento() é deliberadamente agnóstico de regra de negócio
   * (não sabe o que "válido" significa para um tipo de evento) — quem
   * fornece este hook é o chamador (ver dispatcher.ts).
   */
  aindaValido?: () => Promise<boolean>
}

/**
 * Desfecho de UMA chamada a processarEmailEvento():
 * - ENVIADO: enviado e persistido com sucesso.
 * - FALHA: falhou antes ou durante o envio (config, template, provedor, ou
 *   a própria validação em `aindaValido`) — persistido como FALHA.
 * - NAO_REIVINDICADO: o evento não estava PENDENTE quando tentamos
 *   reivindicá-lo (já processado por outro chamador, já concluído, ou
 *   inexistente) — nenhuma escrita de conteúdo foi feita, nada foi enviado.
 * - PERSISTENCIA_FALHOU: o provedor confirmou a entrega, mas a escrita de
 *   ENVIADO no banco falhou — o e-mail FOI enviado; o evento permanece
 *   PROCESSANDO (ver comentário no topo do arquivo).
 * - OBSOLETO: `aindaValido` (se fornecido) retornou `false` — nada foi
 *   montado, nada foi enviado, o provedor nunca foi chamado. Persistido
 *   como `status: 'OBSOLETO'`, `erro: null`, `enviadoEm: null` — estado
 *   terminal dedicado (não FALHA: não houve erro técnico), nunca
 *   reprocessado automaticamente.
 * - SUPRIMIDO (Fluxo Patrimonial — Demo): `sendEmail()` reportou
 *   `success: true` e `suppressed: true` (EMAIL_PROVIDER=disabled) — o
 *   provedor nunca foi chamado de verdade, nenhuma mensagem saiu do
 *   sistema. Persistido como `status: 'SUPRIMIDO'`, `erro: null`,
 *   `enviadoEm: null` — nunca confundido com ENVIADO (que implica entrega
 *   real confirmada pelo provedor).
 */
export type ResultadoProcessamento = 'ENVIADO' | 'FALHA' | 'NAO_REIVINDICADO' | 'PERSISTENCIA_FALHOU' | 'OBSOLETO' | 'SUPRIMIDO'

// Este limite é uma defesa extra contra mensagens inesperadamente grandes
// (ex.: payload de erro bruto de rede) indo parar na coluna `erro` — tanto
// para erros já sanitizados vindos de sendEmail()/EmailProviderError quanto
// para qualquer outra exceção lançada durante o processamento (ex.:
// EmailConfigError de buildAppUrl(), erro de renderização de template).
const TAMANHO_MAXIMO_ERRO = 500

/**
 * Reduz qualquer exceção lançada durante o processamento a uma mensagem
 * curta e segura para persistir em EmailEvento.erro: só `Error.message`
 * (nunca stack trace) e truncada.
 */
function sanitizarErro(err: unknown): string {
  const mensagem = err instanceof Error ? err.message : 'Erro desconhecido ao processar e-mail.'
  return mensagem.slice(0, TAMANHO_MAXIMO_ERRO)
}

/**
 * Chave de idempotência por EmailEvento + GERAÇÃO LÓGICA (Etapa D.2,
 * revisada duas vezes na Etapa fix/signature-resend — ver histórico
 * abaixo). "Geração" é DELIBERADAMENTE distinta de `EmailEvento.tentativas`
 * — são dois conceitos diferentes, que a auditoria de arquitetura desta
 * etapa mostrou não poderem ser confundidos:
 *
 * - `tentativas` (inalterado, ver o claim logo abaixo): quantas vezes este
 *   evento foi RECLAMADO tecnicamente (PENDENTE → PROCESSANDO). Incrementa
 *   em TODO claim, sem exceção — é um contador técnico de processamento,
 *   útil para diagnóstico/observabilidade, nunca usado para compor a chave.
 * - "geração" (novo, ver geracaoIdempotenciaDoPayload abaixo): quantas
 *   INTENÇÕES LÓGICAS distintas de envio já existiram para este evento.
 *   Só incrementa quando um reenvio EXPLÍCITO reabre um evento que estava
 *   ENVIADO (entrega já CONFIRMADA pelo provedor) — nunca quando reabre de
 *   FALHA ou OBSOLETO, porque esses dois estados significam "o provedor
 *   NUNCA confirmou entrega para esta tentativa" (pode ter sido uma
 *   rejeição definitiva, ou pode ter sido um timeout/erro de rede DEPOIS
 *   de o provedor já ter aceitado a requisição — a aplicação não distingue
 *   os dois casos, então precisa tratar ambos como possivelmente já
 *   enviados). Ver a decisão completa em assinatura/route.ts (Gate 2).
 *
 * Por que a distinção importa (histórico desta etapa):
 * - Versão 1 (Etapa D.2): chave só de `eventoId`, estável para sempre.
 *   Resultado: reenvio de um evento ENVIADO reusava a MESMA chave de um
 *   envio já confirmado — o Resend podia deduplicar e nunca reentregar
 *   fisicamente. Corrigido usando `tentativas` na chave (versão 2).
 * - Versão 2 (1ª rodada da Etapa fix/signature-resend): chave por
 *   `tentativas`. Resolveu o problema acima, mas criou um NOVO: um retry
 *   depois de uma FALHA AMBÍGUA (provedor pode ter aceitado a requisição
 *   antes do nosso timeout) também incrementa `tentativas` e por isso
 *   também trocava de chave — arriscando ENVIAR FISICAMENTE DUAS VEZES o
 *   mesmo e-mail se a tentativa "falha" tiver, na verdade, chegado ao
 *   provedor. Essa é exatamente a garantia que uma chave estável existe
 *   para proteger, e a versão 2 a perdia silenciosamente nesse caso.
 * - Versão 3 (esta): "geração" resolve os dois ao mesmo tempo — retry de
 *   FALHA/OBSOLETO preserva a chave (seguro contra a ambiguidade do
 *   provedor); reenvio explícito de ENVIADO troca de chave (não depende de
 *   dedup do provedor para ser entregue de novo).
 *
 * `geracao` não é um campo de EmailEvento (sem migração de schema nesta
 * etapa) — é lido do próprio `EmailEvento.payload` (Json já existente, sem
 * schema rígido) de forma GENÉRICA, sem este arquivo conhecer o formato de
 * payload de nenhum tipo de e-mail específico — ver
 * geracaoIdempotenciaDoPayload logo abaixo. Só ASSINATURA_PENDENTE grava
 * esse campo hoje; os outros 7 tipos simplesmente não o têm no payload, e
 * o fallback (sempre 1) mantém o comportamento deles idêntico ao de antes
 * — nenhum deles tem mecanismo de reabertura, então nunca teriam uma
 * "geração" diferente de 1 de qualquer forma.
 */
export function idempotencyKeyParaEvento(eventoId: string, geracao: number): string {
  return `fluxo-patrimonial-email-evento-${eventoId}-geracao-${geracao}`
}

/**
 * Lê o componente de "geração lógica" (ver idempotencyKeyParaEvento acima)
 * de um EmailEvento.payload SEM conhecer o formato de negócio do tipo —
 * só espera, opcionalmente, um campo numérico `geracao` (inteiro >= 1) na
 * raiz do JSON. Deliberadamente tolerante (nunca lança): payload ausente,
 * não-objeto, sem o campo, ou com o campo malformado — tudo cai no mesmo
 * fallback, 1, que é o valor correto tanto para "este tipo nunca grava
 * geração" (os outros 7 tipos) quanto para "este é o primeiro claim de
 * qualquer evento novo" (geração inicial, sempre 1). A validação RIGOROSA
 * do payload (o de fato usado para montar o e-mail) continua acontecendo
 * só no `build` do chamador, via o parser específico do tipo — esta função
 * nunca é a fonte de verdade sobre "o payload é válido", só sobre "qual
 * geração usar na chave", com um fallback seguro quando a pergunta não se
 * aplica.
 */
export function geracaoIdempotenciaDoPayload(payload: unknown): number {
  if (typeof payload !== 'object' || payload === null) return 1
  const geracao = (payload as Record<string, unknown>).geracao
  if (typeof geracao !== 'number' || !Number.isInteger(geracao) || geracao < 1) return 1
  return geracao
}

async function marcarFalha(eventoId: string, err: unknown): Promise<void> {
  const erro = sanitizarErro(err)
  try {
    await prisma.emailEvento.update({
      where: { id: eventoId },
      data: { status: 'FALHA', erro },
    })
  } catch (erroAoAtualizar) {
    // Última linha de defesa: a transição de negócio que originou este
    // evento já foi commitada e não pode (nem deve) ser revertida por
    // causa disto — só logamos, sem propagar e sem retry recursivo.
    console.error(
      `Falha ao registrar FALHA no EmailEvento ${eventoId} (erro original: ${erro}):`,
      erroAoAtualizar instanceof Error ? erroAoAtualizar.message : erroAoAtualizar
    )
  }
}

/**
 * Persiste OBSOLETO. Se a própria persistência falhar, o evento fica como
 * estava (PROCESSANDO) — mesma postura de "só logar, nunca propagar, nunca
 * retry recursivo" de marcarFalha() acima. Não é ideal (mistura-se com o
 * bucket "PROCESSANDO preso" documentado no topo do arquivo), mas é o
 * comportamento mais seguro possível diante de uma falha de banco neste
 * ponto: nunca reenvia, nunca inventa um status que não foi confirmado.
 */
async function marcarObsoleto(eventoId: string): Promise<void> {
  try {
    await prisma.emailEvento.update({
      where: { id: eventoId },
      data: { status: 'OBSOLETO', erro: null, enviadoEm: null },
    })
  } catch (erroAoAtualizar) {
    console.error(
      `Falha ao registrar OBSOLETO no EmailEvento ${eventoId} — evento permanece PROCESSANDO:`,
      erroAoAtualizar instanceof Error ? erroAoAtualizar.message : erroAoAtualizar
    )
  }
}

/**
 * Persiste SUPRIMIDO (Fluxo Patrimonial — Demo, EMAIL_PROVIDER=disabled).
 * Mesma postura de falha das duas funções acima: se a própria persistência
 * falhar, o evento fica como estava (PROCESSANDO) — nunca inventa um
 * status não confirmado, nunca propaga, nunca faz retry recursivo.
 */
async function marcarSuprimido(eventoId: string): Promise<void> {
  try {
    await prisma.emailEvento.update({
      where: { id: eventoId },
      data: { status: 'SUPRIMIDO', erro: null, enviadoEm: null },
    })
  } catch (erroAoAtualizar) {
    console.error(
      `Falha ao registrar SUPRIMIDO no EmailEvento ${eventoId} — evento permanece PROCESSANDO:`,
      erroAoAtualizar instanceof Error ? erroAoAtualizar.message : erroAoAtualizar
    )
  }
}

/**
 * Processa um EmailEvento: reivindica com exclusividade (PENDENTE →
 * PROCESSANDO), resolve o destinatário, monta a mensagem via `build` e
 * envia através de sendEmail() (única porta de saída para provedores —
 * nunca a SDK do Resend diretamente), gravando o resultado de volta no
 * próprio EmailEvento.
 *
 * Uma reivindicação bem-sucedida representa UMA tentativa, sempre —
 * `tentativas` é incrementado no claim (PENDENTE → PROCESSANDO) e nunca
 * mais depois, independentemente do desfecho.
 *
 * Nunca lança: falha do provedor, de configuração, de template ou de rede
 * sempre termina em EmailEvento.status = 'FALHA' com erro sanitizado —
 * nunca como exceção não tratada. A única exceção a "nunca lança" é
 * conceitual, não literal: se o provedor CONFIRMAR a entrega e a
 * persistência de ENVIADO falhar, o evento NÃO é marcado como FALHA (o
 * e-mail foi mesmo entregue) — ver PERSISTENCIA_FALHOU acima.
 */
export async function processarEmailEvento(
  eventoId: string,
  build: BuildEmailTemplate,
  options?: ProcessarEmailEventoOptions
): Promise<ResultadoProcessamento> {
  let claim: { count: number }
  try {
    claim = await prisma.emailEvento.updateMany({
      where: { id: eventoId, status: 'PENDENTE' },
      data: { status: 'PROCESSANDO', tentativas: { increment: 1 } },
    })
  } catch (err) {
    console.error(`Falha ao reivindicar EmailEvento ${eventoId} para processamento:`, err instanceof Error ? err.message : err)
    return 'NAO_REIVINDICADO'
  }

  if (claim.count === 0) {
    // Evento inexistente, ou não estava PENDENTE (já ENVIADO/FALHA, ou já
    // PROCESSANDO por outro chamador) — nada a fazer, nada foi enviado.
    return 'NAO_REIVINDICADO'
  }

  // A partir daqui somos os únicos donos deste evento — nenhum outro
  // chamador pode reivindicá-lo (status já não é mais 'PENDENTE'). É por
  // isso que a validação de "ainda faz sentido enviar isto?" roda AQUI
  // (depois do claim), não antes: rodar antes deixaria uma janela entre a
  // leitura de validação e o claim em que o estado poderia mudar de novo.
  if (options?.aindaValido) {
    let valido: boolean
    try {
      valido = await options.aindaValido()
    } catch (err) {
      await marcarFalha(eventoId, err)
      return 'FALHA'
    }

    if (!valido) {
      // Nada é montado, nada é enviado, o provedor nunca é chamado —
      // `build`/`sendEmail`/idempotencyKey só entram em cena mais abaixo,
      // que nunca é alcançado neste caminho.
      await marcarObsoleto(eventoId)
      return 'OBSOLETO'
    }
  }

  // `payload` (não `tentativas`) é o que este claim precisa a partir daqui
  // — ver geracaoIdempotenciaDoPayload()/idempotencyKeyParaEvento() acima.
  let evento: { destinatario: string; payload: unknown }
  try {
    evento = await prisma.emailEvento.findUniqueOrThrow({ where: { id: eventoId }, select: { destinatario: true, payload: true } })
  } catch (err) {
    await marcarFalha(eventoId, err)
    return 'FALHA'
  }

  let isTest = false
  try {
    isTest = resolvePhysicalRecipient(evento.destinatario).isTest
  } catch {
    // Configuração inválida (ex.: EMAIL_TEST_MODE mal configurado): o
    // banner é só cosmético — sendEmail() abaixo tenta resolver o mesmo
    // destinatário de novo e, se a config seguir inválida, retorna
    // success:false com o erro real, tratado abaixo.
  }

  let mensagem: RenderedEmail
  try {
    mensagem = build({
      destinatario: evento.destinatario,
      bannerDestinatarioOriginal: isTest ? evento.destinatario : null,
    })
  } catch (err) {
    await marcarFalha(eventoId, err)
    return 'FALHA'
  }

  const resultado = await sendEmail({
    to: evento.destinatario,
    subject: mensagem.subject,
    html: mensagem.html,
    text: mensagem.text,
    idempotencyKey: idempotencyKeyParaEvento(eventoId, geracaoIdempotenciaDoPayload(evento.payload)),
  })

  if (!resultado.success) {
    await marcarFalha(eventoId, new Error(resultado.error ?? 'Erro desconhecido ao enviar e-mail.'))
    return 'FALHA'
  }

  if (resultado.suppressed) {
    // EMAIL_PROVIDER=disabled: `success: true`, mas o provedor NUNCA foi
    // chamado de verdade — persistido como SUPRIMIDO, nunca como ENVIADO
    // (que implicaria entrega real confirmada).
    await marcarSuprimido(eventoId)
    return 'SUPRIMIDO'
  }

  // Entrega CONFIRMADA pelo provedor a partir daqui. Uma falha ao
  // PERSISTIR o status ENVIADO nunca pode virar FALHA nem voltar para
  // PENDENTE — o e-mail já foi enviado de verdade, e qualquer uma dessas
  // duas alternativas abriria caminho para um reenvio físico. O evento
  // fica PROCESSANDO (estado em que já está); reconciliação fica para uma
  // fase futura (ver comentário no topo do arquivo).
  try {
    await prisma.emailEvento.update({
      where: { id: eventoId },
      data: { status: 'ENVIADO', enviadoEm: new Date(), erro: null },
    })
    return 'ENVIADO'
  } catch (erroPersistencia) {
    console.error(
      `CRÍTICO: e-mail do EmailEvento ${eventoId} foi entregue pelo provedor, mas a persistência de ENVIADO falhou — evento permanece PROCESSANDO. Requer reconciliação manual (consultar o provedor pelo id/idempotencyKey acima); NÃO reenviar automaticamente:`,
      erroPersistencia instanceof Error ? erroPersistencia.message : erroPersistencia
    )
    return 'PERSISTENCIA_FALHOU'
  }
}
