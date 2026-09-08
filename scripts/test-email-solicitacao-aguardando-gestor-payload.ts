// scripts/test-email-solicitacao-aguardando-gestor-payload.ts
//
// Teste manual (mesmo padrão de scripts/test-email-reserva-confirmada-payload.ts)
// da Etapa email-gestor-pendente:
// construirPayloadSolicitacaoAguardandoGestor(),
// parseSolicitacaoAguardandoGestorPayload() e
// renderSolicitacaoAguardandoGestorFromPayload()
// (src/lib/email/payloads/solicitacao-aguardando-gestor.ts).
//
// Todo o módulo testado é puro (sem Prisma, sem I/O) — este script não abre
// conexão com o banco nem envia e-mail real.
//
// O cenário A é o mais importante: prova que mutar a fonte DEPOIS de
// construir o payload não altera o snapshot já congelado nem a
// renderização feita a partir dele — mesma garantia de RESERVA_CONFIRMADA.
//
// Executar com: npm run test:email-solicitacao-aguardando-gestor-payload

import {
  construirPayloadSolicitacaoAguardandoGestor,
  parseSolicitacaoAguardandoGestorPayload,
  renderSolicitacaoAguardandoGestorFromPayload,
  SolicitacaoAguardandoGestorPayloadError,
  type ConstruirPayloadSolicitacaoAguardandoGestorInput,
} from '../src/lib/email/payloads/solicitacao-aguardando-gestor'

let failures = 0

function assert(condition: boolean, label: string, detalhe?: unknown) {
  if (condition) {
    console.log(`OK   - ${label}`)
  } else {
    failures++
    console.error(`FALHA - ${label}${detalhe !== undefined ? ` (${JSON.stringify(detalhe)})` : ''}`)
  }
}

function assertLanca(fn: () => unknown, label: string) {
  try {
    fn()
    failures++
    console.error(`FALHA - ${label} (não lançou)`)
  } catch (err) {
    const ehTipoCerto = err instanceof SolicitacaoAguardandoGestorPayloadError
    assert(ehTipoCerto, label, err instanceof Error ? err.message : err)
  }
}

function inputBase(overrides: Partial<ConstruirPayloadSolicitacaoAguardandoGestorInput> = {}): ConstruirPayloadSolicitacaoAguardandoGestorInput {
  return {
    numero: 77,
    nomeGestor: 'Beltrano Gestor',
    nomeSolicitante: 'Fulano de Tal',
    data: new Date('2026-09-01T00:00:00.000Z'),
    periodos: ['MANHA'],
    finalidade: null,
    atividadeExterna: 'Feira de tecnologia',
    local: 'Centro de Convenções',
    cidade: 'São Paulo',
    observacoes: null,
    itensPatrimonio: [{ numero: '123', marca: 'Dell', modelo: 'Latitude', categoria: 'Notebook' }],
    itensPapelaria: [{ descricao: 'Caneta', quantidade: 10 }],
    itensServico: [],
    notebooksComDominio: true,
    tipoDominio: 'EDUCACIONAL',
    ...overrides,
  }
}

async function main() {
  // --- A) snapshot imutável ------------------------------------------------
  {
    const itemFonte = { numero: '123', marca: 'Dell', modelo: 'Latitude', categoria: 'Notebook' }
    const input = inputBase({ itensPatrimonio: [itemFonte] })
    const payload = construirPayloadSolicitacaoAguardandoGestor(input)

    // Mutação da fonte DEPOIS de construir o payload — nunca deve alcançar o snapshot.
    itemFonte.marca = 'MUTADO'
    input.nomeGestor = 'NOME MUTADO'

    assert(payload.itensPatrimonio[0].marca === 'Dell', 'A) payload continua com os valores históricos (Dell) mesmo após a fonte ser mutada depois', payload.itensPatrimonio[0])
    assert(payload.nomeGestor === 'Beltrano Gestor', 'A) nomeGestor do payload não é afetado pela mutação da fonte depois', payload.nomeGestor)

    const { html, text } = renderSolicitacaoAguardandoGestorFromPayload(payload, 'https://app.example.com/x')
    assert(html.includes('Dell') && text.includes('Dell'), 'A) renderização a partir do payload contém os valores históricos', { html, text })
    assert(!html.includes('MUTADO') && !text.includes('MUTADO'), 'A) renderização NÃO contém os valores injetados depois na fonte', { html, text })
  }

  // --- E) payload histórico válido — round-trip via JSON (mesmo caminho do dispatcher) ---
  {
    const payloadConstruido = construirPayloadSolicitacaoAguardandoGestor(inputBase())
    const bruto: unknown = JSON.parse(JSON.stringify(payloadConstruido))
    const payloadParseado = parseSolicitacaoAguardandoGestorPayload(bruto)
    assert(payloadParseado.numero === 77, 'E) payload sobrevive ao round-trip JSON (numero)', payloadParseado.numero)
    assert(payloadParseado.tipoDominio === 'EDUCACIONAL', 'E) payload sobrevive ao round-trip JSON (tipoDominio)', payloadParseado.tipoDominio)

    // --- F) dispatcher renderiza SOMENTE a partir do payload — sem qualquer consulta viva ---
    // (o próprio parser é uma função pura, sem Prisma/import de rede — a prova estrutural
    // é que este arquivo inteiro nunca importa `prisma`; a prova comportamental é que a
    // renderização abaixo usa exclusivamente os campos de `payloadParseado`)
    const rendaInline = renderSolicitacaoAguardandoGestorFromPayload(payloadConstruido, 'https://app.example.com/y', null)
    const rendaDispatcher = renderSolicitacaoAguardandoGestorFromPayload(payloadParseado, 'https://app.example.com/y', null)
    assert(
      rendaInline.subject === rendaDispatcher.subject && rendaInline.html === rendaDispatcher.html && rendaInline.text === rendaDispatcher.text,
      'F) caminho inline e caminho dispatcher (via JSON + parser) produzem subject/html/text idênticos, sem dado vivo',
      { rendaInline, rendaDispatcher }
    )
  }

  // --- J) data civil correta no assunto/corpo -------------------------------------------
  {
    const payload = construirPayloadSolicitacaoAguardandoGestor(inputBase({ data: new Date('2026-09-01T00:00:00.000Z') }))
    const { html, text } = renderSolicitacaoAguardandoGestorFromPayload(payload, 'https://app.example.com/x')
    assert(html.includes('01/09/2026') && text.includes('01/09/2026'), 'J) data civil formatada corretamente (formatDataCivil, não Date local)', { html, text })
  }

  // --- K) domínio Educacional aparece corretamente --------------------------------------
  {
    const payload = construirPayloadSolicitacaoAguardandoGestor(inputBase({ notebooksComDominio: true, tipoDominio: 'EDUCACIONAL' }))
    const { html, text } = renderSolicitacaoAguardandoGestorFromPayload(payload, 'https://app.example.com/x')
    assert(html.includes('Educacional') && text.includes('Educacional'), 'K) domínio Educacional aparece no e-mail', { html, text })
  }

  // --- L) domínio Administrativo aparece corretamente -----------------------------------
  {
    const payload = construirPayloadSolicitacaoAguardandoGestor(inputBase({ notebooksComDominio: true, tipoDominio: 'ADMINISTRATIVO' }))
    const { html, text } = renderSolicitacaoAguardandoGestorFromPayload(payload, 'https://app.example.com/x')
    assert(html.includes('Administrativo') && text.includes('Administrativo'), 'L) domínio Administrativo aparece no e-mail', { html, text })
  }

  // --- M) "Sem domínio" (notebooksComDominio=false) e ausência total (null) ------------
  {
    const payloadSemDominioAtivo = construirPayloadSolicitacaoAguardandoGestor(inputBase({ notebooksComDominio: false, tipoDominio: null }))
    const rendaFalse = renderSolicitacaoAguardandoGestorFromPayload(payloadSemDominioAtivo, 'https://app.example.com/x')
    assert(rendaFalse.html.includes('Domínio') && rendaFalse.text.includes('Domínio: Não'), 'M) domínio=false mostra "Domínio: Não"', { html: rendaFalse.html, text: rendaFalse.text })

    const payloadSemNotebook = construirPayloadSolicitacaoAguardandoGestor(inputBase({ itensPatrimonio: [], notebooksComDominio: null, tipoDominio: null }))
    const rendaNull = renderSolicitacaoAguardandoGestorFromPayload(payloadSemNotebook, 'https://app.example.com/x')
    assert(!rendaNull.html.includes('>Domínio<') && !rendaNull.text.includes('Domínio:'), 'M) sem Notebook (domínio=null) não exibe nenhuma linha de domínio', { html: rendaNull.html, text: rendaNull.text })
  }

  // --- payload null/versão/campos malformados → erro controlado (mesma robustez de RESERVA_CONFIRMADA) ---
  assertLanca(() => parseSolicitacaoAguardandoGestorPayload(null), 'payload null lança SolicitacaoAguardandoGestorPayloadError')
  assertLanca(() => parseSolicitacaoAguardandoGestorPayload(undefined), 'payload undefined lança SolicitacaoAguardandoGestorPayloadError')
  {
    const payload = { ...construirPayloadSolicitacaoAguardandoGestor(inputBase()), versao: 2 }
    assertLanca(() => parseSolicitacaoAguardandoGestorPayload(payload), 'versao !== 1 lança erro')
  }
  {
    const base = construirPayloadSolicitacaoAguardandoGestor(inputBase()) as unknown as Record<string, unknown>
    assertLanca(() => parseSolicitacaoAguardandoGestorPayload({ ...base, itensPatrimonio: 'não é array' }), 'itensPatrimonio não-array lança erro')
    assertLanca(() => parseSolicitacaoAguardandoGestorPayload({ ...base, notebooksComDominio: 'sim' }), 'notebooksComDominio malformado (presente e não-boolean) lança erro')
    assertLanca(() => parseSolicitacaoAguardandoGestorPayload({ ...base, tipoDominio: 'OUTRO' }), 'tipoDominio malformado (fora do enum) lança erro')
    assertLanca(() => parseSolicitacaoAguardandoGestorPayload({ ...base, dataIso: 'não-é-uma-data' }), 'dataIso inválida lança erro')
  }

  // --- retrocompatibilidade: payload sem notebooksComDominio/tipoDominio (não deveria existir
  // para este tipo, mas o parser deve continuar tolerante, mesmo padrão de RESERVA_CONFIRMADA) ---
  {
    const completo = construirPayloadSolicitacaoAguardandoGestor(inputBase()) as unknown as Record<string, unknown>
    const { notebooksComDominio: _n, tipoDominio: _t, ...semDominio } = completo
    const parseado = parseSolicitacaoAguardandoGestorPayload(semDominio)
    assert(parseado.notebooksComDominio === null, 'payload sem notebooksComDominio é lido como null (nunca erro)', parseado.notebooksComDominio)
    assert(parseado.tipoDominio === null, 'payload sem tipoDominio é lido como null (nunca erro)', parseado.tipoDominio)
  }

  // --- link/APP_URL nunca entra no payload (mesma garantia de RESERVA_CONFIRMADA) ---------
  {
    const payload = construirPayloadSolicitacaoAguardandoGestor(inputBase()) as unknown as Record<string, unknown>
    assert(!('link' in payload) && !('APP_URL' in payload), 'payload não contém link/APP_URL', Object.keys(payload))
  }

  // --- escaping: snapshot guarda dado bruto; só a renderização HTML escapa ---------------
  {
    const nomePerigoso = '<script>alert(1)</script>'
    const payload = construirPayloadSolicitacaoAguardandoGestor(inputBase({ nomeSolicitante: nomePerigoso }))
    assert(payload.nomeSolicitante === nomePerigoso, 'payload guarda o nome sem transformação de HTML (dado bruto)', payload.nomeSolicitante)

    const { html, text } = renderSolicitacaoAguardandoGestorFromPayload(payload, 'https://app.example.com/x')
    assert(!html.includes('<script>alert(1)</script>'), 'HTML renderizado não contém a tag <script> crua', html)
    assert(html.includes('&lt;script&gt;'), 'HTML renderizado contém a versão escapada do nome perigoso', html)
    assert(text.includes(nomePerigoso), 'texto puro preserva o dado original sem necessidade de escape', text)
  }

  // --- CTA "Analisar solicitação" presente com o link correto -----------------------------
  {
    const payload = construirPayloadSolicitacaoAguardandoGestor(inputBase())
    const { html, text, subject } = renderSolicitacaoAguardandoGestorFromPayload(payload, 'https://app.example.com/solicitacoes/sol-77')
    assert(html.includes('ANALISAR SOLICITAÇÃO') && html.includes('https://app.example.com/solicitacoes/sol-77'), 'botão "Analisar solicitação" aponta para o link fornecido', html)
    assert(text.includes('Analisar solicitação: https://app.example.com/solicitacoes/sol-77'), 'link textual aparece no texto puro', text)
    assert(subject === '[Fluxo Patrimonial] Reserva externa aguardando sua aprovação — #77', 'assunto segue a convenção institucional com o número da solicitação', subject)
  }

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) de payload de SOLICITACAO_AGUARDANDO_GESTOR falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes de payload de SOLICITACAO_AGUARDANDO_GESTOR passaram. Nenhum e-mail real foi enviado, nenhum banco real foi acessado.')
}

main().catch((err) => {
  console.error('Falha inesperada ao executar os testes de payload de SOLICITACAO_AGUARDANDO_GESTOR:', err instanceof Error ? err.message : err)
  process.exit(1)
})
