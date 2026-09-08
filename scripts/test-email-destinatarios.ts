// scripts/test-email-destinatarios.ts
//
// Teste manual (mesmo padrão de scripts/test-validade-evento.ts) do helper
// de montagem/deduplicação da lista de destinatários de e-mails cujo
// destinatário operacional é "o Patrimônio" (RESERVA_CONFIRMADA,
// CANCELAMENTO, SOLICITACAO_AGUARDANDO_PATRIMONIO) — src/lib/email/destinatarios.ts.
//
// Etapa email-patrimonio-caixa-grupo: reescrito por completo — o Patrimônio
// deixou de ser uma LISTA de e-mails individuais (um por usuário ativo com
// permissao='patrimonio') para virar um único endereço fixo
// (EMAIL_PATRIMONIO_RECIPIENT). deduplicarDestinatarios() agora recebe um
// único `emailPatrimonio` (não mais um array), e buscarDestinatariosReservaConfirmada()
// só consulta o banco para saber SE existe algum membro ativo (gate de
// elegibilidade, `findFirst`) — nunca mais para trazer e-mails individuais.
//
// Cobre a função pura deduplicarDestinatarios(), o resolver seguro
// resolverEmailPatrimonioOuNull() (nunca lança, mesmo com env ausente/
// inválida) e buscarDestinatariosReservaConfirmada() com um `tx` mockado em
// memória — não abre conexão real com o banco nem envia e-mail real (este
// módulo nem chama sendEmail/processarEmailEvento).
//
// Executar com: npm run test:email-destinatarios

import { deduplicarDestinatarios, buscarDestinatariosReservaConfirmada, resolverEmailPatrimonioOuNull } from '../src/lib/email/destinatarios'
import { resetEmailPatrimonioRecipientCache } from '../src/lib/email/config'

// require() puro de propósito — ver scripts/test-email-processar-evento.ts
// para a explicação completa de por que `import` não serve aqui.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { prisma } = require('../src/lib/prisma')

let failures = 0

function assert(condition: boolean, label: string, detalhe?: unknown) {
  if (condition) {
    console.log(`OK   - ${label}`)
  } else {
    failures++
    console.error(`FALHA - ${label}${detalhe !== undefined ? ` (${JSON.stringify(detalhe)})` : ''}`)
  }
}

function assertSemDuplicatas(lista: { email: string }[], label: string) {
  const normalizados = lista.map((d) => d.email.trim().toLowerCase())
  const unicos = new Set(normalizados)
  assert(unicos.size === normalizados.length, label, lista)
}

async function silenciado(fn: () => void | Promise<void>): Promise<void> {
  const original = console.error
  console.error = () => {}
  try {
    await fn()
  } finally {
    console.error = original
  }
}

// Etapa email-patrimonio-caixa-grupo (observabilidade): captura as chamadas
// a console.error em vez de só silenciá-las, para provar que a ausência/
// invalidez de EMAIL_PATRIMONIO_RECIPIENT é sinalizada de forma explícita e
// greppável nos Runtime Logs — não apenas silenciosamente ignorada.
async function capturarConsoleError(fn: () => void | Promise<void>): Promise<string[]> {
  const chamadas: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => {
    chamadas.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
  }
  try {
    await fn()
  } finally {
    console.error = original
  }
  return chamadas
}

async function main() {
  // === deduplicarDestinatarios() — função pura ============================

  // --- A) solicitante + caixa de grupo do Patrimônio → 2 destinatários ----
  {
    const resultado = deduplicarDestinatarios('solicitante@example.com', 'grupopatrimonio@example.com')
    assert(resultado.length === 2, 'A) 2 destinatários no total', resultado)
    assert(resultado[0].email === 'solicitante@example.com' && resultado[0].papel === 'solicitante', 'A) solicitante presente e primeiro')
    assert(resultado[1].email === 'grupopatrimonio@example.com' && resultado[1].papel === 'patrimonio', 'A) caixa de grupo presente com papel patrimonio')
    assertSemDuplicatas(resultado, 'A) nenhuma duplicata no resultado')
  }

  // --- B) solicitante com o MESMO e-mail da caixa de grupo → 1 entrada, papel=solicitante
  {
    const resultado = deduplicarDestinatarios('pessoa@example.com', 'pessoa@example.com')
    assert(resultado.length === 1, 'B) e-mail compartilhado aparece uma única vez', resultado)
    assert(resultado[0]?.papel === 'solicitante', 'B) papel final é solicitante (precedência)', resultado)
  }

  // --- C) diferença de maiúsculas/minúsculas entre solicitante e grupo → mesma pessoa
  {
    const resultado = deduplicarDestinatarios('Pessoa@Example.com', 'PESSOA@EXAMPLE.COM')
    assert(resultado.length === 1 && resultado[0].papel === 'solicitante', 'C) variação de case entre solicitante e grupo ainda reconhecida como o mesmo endereço', resultado)
  }

  // --- D) e-mails com espaços nas bordas → normalizados corretamente -------
  {
    const resultado = deduplicarDestinatarios('  solicitante@example.com  ', '  grupopatrimonio@example.com  ')
    assert(resultado[0].email === 'solicitante@example.com', 'D) e-mail do solicitante trimado no resultado', resultado[0])
    assert(resultado[1].email === 'grupopatrimonio@example.com', 'D) e-mail da caixa de grupo trimado no resultado', resultado[1])
  }

  // --- E) ordem: solicitante sempre primeiro quando presente ---------------
  {
    const resultado = deduplicarDestinatarios('solicitante@example.com', 'grupopatrimonio@example.com')
    assert(resultado[0].papel === 'solicitante', 'E) primeira entrada é sempre o solicitante quando presente', resultado)
  }

  // --- F) patrimônio ausente (null) → retorna só o solicitante -------------
  {
    const resultado = deduplicarDestinatarios('solicitante@example.com', null)
    assert(resultado.length === 1 && resultado[0].papel === 'solicitante', 'F) patrimônio null retorna só o solicitante', resultado)
  }

  // --- G) dados inesperados/vazios → ignorados sem lançar erro -------------
  {
    for (const valorInvalido of ['', '   ', null, undefined, 123 as unknown as string]) {
      const resultado = deduplicarDestinatarios('solicitante@example.com', valorInvalido)
      assert(resultado.length === 1 && resultado[0].papel === 'solicitante', `G) valor inválido de patrimônio (${JSON.stringify(valorInvalido)}) é ignorado sem lançar`, resultado)
    }
  }
  {
    const resultado = deduplicarDestinatarios('', 'grupopatrimonio@example.com')
    assert(resultado.length === 1 && resultado[0].papel === 'patrimonio', 'G) solicitante com e-mail vazio é ignorado sem lançar erro', resultado)
  }
  {
    const resultado = deduplicarDestinatarios(undefined, null)
    assert(resultado.length === 0, 'G) solicitante e patrimônio ambos vazios/ausentes não lança erro, retorna lista vazia', resultado)
  }

  // === resolverEmailPatrimonioOuNull() — nunca lança =======================

  // --- H) EMAIL_PATRIMONIO_RECIPIENT configurada → retorna o endereço ------
  {
    process.env.EMAIL_PATRIMONIO_RECIPIENT = 'grupopatrimonio@example.com'
    resetEmailPatrimonioRecipientCache()
    const resultado = resolverEmailPatrimonioOuNull('TESTE')
    assert(resultado === 'grupopatrimonio@example.com', 'H) resolve o endereço configurado', resultado)
  }

  // --- I) EMAIL_PATRIMONIO_RECIPIENT ausente → retorna null, nunca lança,
  //        e sinaliza explicitamente via console.error (observabilidade) ---
  {
    delete process.env.EMAIL_PATRIMONIO_RECIPIENT
    resetEmailPatrimonioRecipientCache()
    let resultado: string | null = 'valor-nao-sobrescrito' as unknown as null
    const chamadas = await capturarConsoleError(() => {
      resultado = resolverEmailPatrimonioOuNull('CANCELAMENTO')
    })
    assert(resultado === null, 'I) variável ausente retorna null (nunca lança, nunca cai para destinatário individual)', resultado)
    assert(chamadas.length === 1, 'I) exatamente 1 chamada a console.error (sinalização não é silenciosa)', chamadas)
    assert(chamadas[0]?.includes('[Email]'), 'I) log traz o prefixo "[Email]" — greppável nos Runtime Logs do Vercel', chamadas[0])
    assert(chamadas[0]?.includes('EMAIL_PATRIMONIO_RECIPIENT'), 'I) log identifica exatamente a variável de ambiente envolvida', chamadas[0])
    assert(chamadas[0]?.includes('CANCELAMENTO'), 'I) log inclui o contexto (tipo do EmailEvento não criado)', chamadas[0])
    assert(
      !/postgresql:\/\/|re_[A-Za-z0-9]|eyJ[A-Za-z0-9]|Bearer\s/.test(chamadas[0] ?? ''),
      'I) log não contém padrões de segredo real (connection string, chave Resend, JWT, Bearer token)',
      chamadas[0]
    )
  }

  // --- J) EMAIL_PATRIMONIO_RECIPIENT inválida (não é e-mail) → retorna null
  {
    process.env.EMAIL_PATRIMONIO_RECIPIENT = 'isto-nao-e-um-email'
    resetEmailPatrimonioRecipientCache()
    let resultado: string | null = 'valor-nao-sobrescrito' as unknown as null
    await silenciado(() => {
      resultado = resolverEmailPatrimonioOuNull('TESTE')
    })
    assert(resultado === null, 'J) valor mal formatado retorna null (nunca lança)', resultado)
    process.env.EMAIL_PATRIMONIO_RECIPIENT = 'grupopatrimonio@example.com'
    resetEmailPatrimonioRecipientCache()
  }

  // === buscarDestinatariosReservaConfirmada() — gate via tx.user.findFirst ==

  // --- K) existe membro ativo → caixa de grupo incluída, findFirst (não findMany)
  {
    const usuarios = [
      { email: 'admin@example.com', ativo: true, permissao: 'administrador' },
      { email: 'ti@example.com', ativo: true, permissao: 'colaborador' },
      { email: 'inativo@example.com', ativo: false, permissao: 'patrimonio' },
      { email: 'patrimonio1@example.com', ativo: true, permissao: 'patrimonio' },
      { email: 'patrimonio2@example.com', ativo: true, permissao: 'patrimonio' },
    ]

    let whereRecebido: unknown
    let selectRecebido: unknown
    let findManyChamado = false
    prisma.user = {
      findFirst: async ({ where, select }: { where: Record<string, unknown>; select: Record<string, unknown> }) => {
        whereRecebido = where
        selectRecebido = select
        return usuarios.find((u) => (where.ativo === undefined || u.ativo === where.ativo) && (where.permissao === undefined || u.permissao === where.permissao)) ?? null
      },
      findMany: async () => {
        findManyChamado = true
        return []
      },
    }

    const resultado = await buscarDestinatariosReservaConfirmada(prisma, 'solicitante@example.com')

    assert(
      JSON.stringify(whereRecebido) === JSON.stringify({ ativo: true, permissao: 'patrimonio' }),
      'K) filtro do Prisma é exatamente { ativo: true, permissao: "patrimonio" }',
      whereRecebido
    )
    assert(JSON.stringify(selectRecebido) === JSON.stringify({ id: true }), 'K) select do Prisma é { id: true } — nunca mais e-mail individual', selectRecebido)
    assert(!findManyChamado, 'K) NUNCA usa findMany — só findFirst (gate de existência, não lista de e-mails)', findManyChamado)
    assert(resultado.length === 2, 'K) resultado tem exatamente 2 entradas (solicitante + caixa de grupo)', resultado)
    assert(
      resultado.some((d) => d.email === 'grupopatrimonio@example.com' && d.papel === 'patrimonio'),
      'K) a caixa de grupo (não um e-mail individual) recebe o papel patrimonio',
      resultado
    )
    assert(
      !resultado.some((d) => d.email === 'patrimonio1@example.com' || d.email === 'patrimonio2@example.com'),
      'K) nenhum e-mail INDIVIDUAL de membro do Patrimônio aparece no resultado',
      resultado
    )
  }

  // --- L) nenhum membro ativo → só o solicitante ----------------------------
  {
    prisma.user = { findFirst: async () => null }
    const resultado = await buscarDestinatariosReservaConfirmada(prisma, 'solicitante@example.com')
    assert(resultado.length === 1 && resultado[0].papel === 'solicitante', 'L) sem membro ativo, resultado é só o solicitante — nenhum e-mail de grupo criado', resultado)
  }

  // --- M) membro ativo existe, mas EMAIL_PATRIMONIO_RECIPIENT ausente → só o solicitante, sem lançar
  {
    prisma.user = { findFirst: async () => ({ email: 'patrimonio1@example.com' }) }
    delete process.env.EMAIL_PATRIMONIO_RECIPIENT
    resetEmailPatrimonioRecipientCache()

    let resultado: Awaited<ReturnType<typeof buscarDestinatariosReservaConfirmada>> = []
    await silenciado(async () => {
      resultado = await buscarDestinatariosReservaConfirmada(prisma, 'solicitante@example.com')
    })

    assert(resultado.length === 1 && resultado[0].papel === 'solicitante', 'M) config ausente: só o solicitante, NUNCA cai para e-mails individuais da equipe', resultado)

    process.env.EMAIL_PATRIMONIO_RECIPIENT = 'grupopatrimonio@example.com'
    resetEmailPatrimonioRecipientCache()
  }

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) de destinatários (caixa de grupo do Patrimônio) falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes de destinatários (caixa de grupo do Patrimônio) passaram. Nenhum e-mail real foi enviado, nenhum banco real foi acessado.')
}

main().catch((err) => {
  console.error('Falha inesperada ao executar os testes de destinatários:', err instanceof Error ? err.message : err)
  process.exit(1)
})
