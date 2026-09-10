// scripts/test-email-disabled.ts
//
// Teste manual (mesmo padrão de scripts/test-email-config.ts) do provedor
// EMAIL_PROVIDER=disabled (Fluxo Patrimonial — Demo). Verifica:
//   - getEmailConfig() aceita "disabled" sem exigir EMAIL_API_KEY/
//     EMAIL_FROM_ADDRESS/EMAIL_TEST_MODE/EMAIL_TEST_RECIPIENT.
//   - sendEmail() com provider "disabled" NUNCA faz uma requisição de rede —
//     verificado substituindo `global.fetch` por um espião que falha o
//     teste se for chamado (a SDK do Resend usa fetch internamente; se o
//     provedor "disabled" estivesse, por engano, delegando para o Resend,
//     este espião pegaria).
//   - sendEmail() retorna success:true E suppressed:true em modo disabled.
//   - processarEmailEvento() (handler REAL, não reimplementado) persiste
//     EmailEvento.status = 'SUPRIMIDO' — nunca 'ENVIADO' — quando o envio
//     foi suprimido pela configuração do ambiente.
//
// Executar com: npm run test:email-disabled

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

async function main() {
  process.env.APP_URL = 'http://localhost:3000'
  process.env.EMAIL_PROVIDER = 'disabled'
  delete process.env.EMAIL_API_KEY
  delete process.env.EMAIL_FROM_ADDRESS
  delete process.env.EMAIL_FROM_NAME
  delete process.env.EMAIL_REPLY_TO
  delete process.env.EMAIL_TEST_MODE
  delete process.env.EMAIL_TEST_RECIPIENT

  const { getEmailConfig, resetEmailConfigCache } = require('@/lib/email/config')
  resetEmailConfigCache()

  // --- getEmailConfig(): nenhuma credencial exigida em modo disabled ------
  let config: ReturnType<typeof getEmailConfig> | undefined
  let erroConfig: unknown
  try {
    config = getEmailConfig()
  } catch (e) {
    erroConfig = e
  }
  assert(erroConfig === undefined, 'EMAIL_PROVIDER=disabled → getEmailConfig() não lança mesmo sem EMAIL_API_KEY/EMAIL_FROM_ADDRESS', erroConfig)
  assert(config?.provider === 'disabled', 'getEmailConfig() reporta provider "disabled"', config?.provider)

  // --- Espião em global.fetch: nenhuma chamada de rede pode acontecer -----
  const fetchOriginal = global.fetch
  let fetchChamado = false
  global.fetch = (async (...args: unknown[]) => {
    fetchChamado = true
    throw new Error(`fetch() foi chamado em modo disabled — nunca deveria acontecer. Args: ${JSON.stringify(args)}`)
  }) as typeof fetch

  try {
    const { sendEmail } = require('@/lib/email/send-email')
    const resultado = await sendEmail({
      to: 'destinatario-teste@example.com',
      subject: 'Assunto de teste',
      html: '<p>Corpo de teste</p>',
    })

    assert(fetchChamado === false, 'EMAIL_PROVIDER=disabled → sendEmail() nunca chama fetch() (nenhuma chamada de rede)')
    assert(resultado.success === true, 'EMAIL_PROVIDER=disabled → sendEmail() retorna success:true (resto do fluxo continua funcionando)', resultado)
    assert(resultado.suppressed === true, 'EMAIL_PROVIDER=disabled → sendEmail() retorna suppressed:true', resultado.suppressed)
    assert(resultado.providerId === 'disabled', 'EMAIL_PROVIDER=disabled → providerId identifica a origem como "disabled"', resultado.providerId)
    assert(resultado.originalRecipient === 'destinatario-teste@example.com', 'EMAIL_PROVIDER=disabled → destinatário lógico original é preservado no resultado', resultado.originalRecipient)
  } finally {
    global.fetch = fetchOriginal
  }

  // --- processarEmailEvento() end-to-end: status final deve ser SUPRIMIDO -
  // (handler REAL de src/lib/email/processar-evento.ts — só prisma.emailEvento
  // é mockado em memória, mesmo padrão de scripts/test-email-processar-evento.ts).
  {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { prisma } = require('@/lib/prisma')
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { processarEmailEvento } = require('@/lib/email/processar-evento')

    const EVENTO_ID = 'evento-disabled-1'
    const eventoFake = {
      id: EVENTO_ID,
      destinatario: 'solicitante@example.com',
      status: 'PENDENTE' as string,
      tentativas: 0,
      erro: null as string | null,
      enviadoEm: null as Date | null,
      payload: null as unknown,
    }

    prisma.emailEvento = {
      updateMany: async ({ where, data }: { where: { id: string; status?: string }; data: Record<string, unknown> }) => {
        if (eventoFake.id !== where.id) return { count: 0 }
        if (where.status !== undefined && eventoFake.status !== where.status) return { count: 0 }
        if (typeof data.status === 'string') eventoFake.status = data.status
        const tentativasOp = data.tentativas as { increment?: number } | undefined
        if (tentativasOp?.increment) eventoFake.tentativas += tentativasOp.increment
        return { count: 1 }
      },
      findUniqueOrThrow: async () => ({ destinatario: eventoFake.destinatario, payload: eventoFake.payload }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(eventoFake, data)
        return { ...eventoFake }
      },
    }

    const resultado = await processarEmailEvento(EVENTO_ID, () => ({
      subject: 'Assunto de teste',
      html: '<p>Corpo de teste</p>',
      text: 'Corpo de teste',
    }))

    assert(resultado === 'SUPRIMIDO', 'processarEmailEvento() com EMAIL_PROVIDER=disabled retorna "SUPRIMIDO"', resultado)
    assert(eventoFake.status === 'SUPRIMIDO', 'EmailEvento.status final é "SUPRIMIDO" (nunca "ENVIADO")', eventoFake.status)
    assert(eventoFake.erro === null, 'EmailEvento.erro permanece null em SUPRIMIDO (não é um erro técnico)', eventoFake.erro)
    assert(eventoFake.enviadoEm === null, 'EmailEvento.enviadoEm permanece null em SUPRIMIDO (nada foi entregue de fato)', eventoFake.enviadoEm)
  }

  console.log(`\n${failures === 0 ? '✅ Todos os testes passaram.' : `❌ ${failures} teste(s) falharam.`}`)
  if (failures > 0) process.exit(1)
}

main()
