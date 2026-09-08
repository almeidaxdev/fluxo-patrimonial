// scripts/test-email-reserva-confirmada-payload.ts
//
// Teste manual (mesmo padrão de scripts/test-email-destinatarios.ts) da
// Etapa D.3.6.3: construirPayloadReservaConfirmada(), parseReservaConfirmadaPayload()
// e renderReservaConfirmadaFromPayload() (src/lib/email/payloads/reserva-confirmada.ts).
//
// Todo o módulo testado é puro (sem Prisma, sem I/O) — este script não abre
// conexão com o banco nem envia e-mail real; nenhuma rota nem o dispatcher
// são exercitados aqui (ainda não usam o payload — ver D.3.6.4/D.3.6.5).
//
// O cenário A é o mais importante: reproduz DIRETAMENTE o finding do Codex
// Review (Etapa D.3) — prova que mutar a fonte DEPOIS de construir o
// payload não altera o snapshot já congelado nem a renderização feita a
// partir dele.
//
// Executar com: npm run test:email-reserva-confirmada-payload

import {
  construirPayloadReservaConfirmada,
  parseReservaConfirmadaPayload,
  renderReservaConfirmadaFromPayload,
  ReservaConfirmadaPayloadError,
  type ConstruirPayloadReservaConfirmadaInput,
} from '../src/lib/email/payloads/reserva-confirmada'

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
    const ehTipoCerto = err instanceof ReservaConfirmadaPayloadError
    assert(ehTipoCerto, label, err instanceof Error ? err.message : err)
  }
}

function inputBase(overrides: Partial<ConstruirPayloadReservaConfirmadaInput> = {}): ConstruirPayloadReservaConfirmadaInput {
  return {
    numero: 42,
    nomeSolicitante: 'Fulano de Tal',
    tipoEmprestimo: 'interno',
    data: new Date('2026-08-20T00:00:00.000Z'),
    periodos: ['TARDE'],
    ambiente: 'Lab 1',
    finalidade: 'Aula prática',
    atividadeExterna: null,
    local: null,
    cidade: null,
    observacoes: null,
    itensPatrimonio: [{ numero: '123', marca: 'Dell', modelo: 'Latitude', categoria: 'Notebook' }],
    itensPapelaria: [{ descricao: 'Caneta', quantidade: 10 }],
    itensServico: [{ tipoServicoNome: 'Manutenção', quantidade: 1, ambiente: 'Sala 2' }],
    notebooksComDominio: true,
    tipoDominio: 'EDUCACIONAL',
    assinaturaConfirmadaEm: null,
    ...overrides,
  }
}

async function main() {
  // --- A) snapshot imutável — reproduz o finding do Codex diretamente -----
  {
    const itemFonte = { numero: '123', marca: 'Dell', modelo: 'Latitude', categoria: 'Notebook' }
    const input = inputBase({ itensPatrimonio: [itemFonte] })
    const payload = construirPayloadReservaConfirmada(input, 'solicitante')

    // Muta a fonte DEPOIS de já ter construído o payload — simula um
    // administrador editando o catálogo entre a confirmação e o envio.
    itemFonte.numero = '999'
    itemFonte.marca = 'Lenovo'
    itemFonte.modelo = 'ThinkCentre'
    itemFonte.categoria = 'Equipamento'
    input.itensPatrimonio.push({ numero: '000', marca: 'Injetado', modelo: 'Depois', categoria: 'Outro' })

    assert(
      payload.itensPatrimonio.length === 1 &&
        payload.itensPatrimonio[0].numero === '123' &&
        payload.itensPatrimonio[0].marca === 'Dell' &&
        payload.itensPatrimonio[0].modelo === 'Latitude' &&
        payload.itensPatrimonio[0].categoria === 'Notebook',
      'A) payload continua com os valores históricos (123/Dell/Latitude/Notebook) mesmo após a fonte ser mutada depois',
      payload.itensPatrimonio
    )

    const html = renderReservaConfirmadaFromPayload(payload, 'https://app.example.com/solicitacoes/1').html
    assert(html.includes('123') && html.includes('Dell') && html.includes('Latitude'), 'A) renderização a partir do payload contém os valores históricos', html)
    assert(!html.includes('999') && !html.includes('Lenovo') && !html.includes('ThinkCentre') && !html.includes('Injetado'), 'A) renderização NÃO contém os valores injetados depois na fonte', html)
  }

  // --- B) papel solicitante persistido e renderizado ------------------------
  {
    const payload = construirPayloadReservaConfirmada(inputBase(), 'solicitante')
    assert(payload.papel === 'solicitante', 'B) papel solicitante persistido no payload', payload.papel)
    const { subject } = renderReservaConfirmadaFromPayload(payload, 'https://app.example.com/x')
    assert(subject.startsWith('[Fluxo Patrimonial] Sua reserva foi confirmada'), 'B) assunto renderizado usa a variante solicitante', subject)
  }

  // --- C) papel patrimonio persistido e renderizado --------------------------
  {
    const payload = construirPayloadReservaConfirmada(inputBase(), 'patrimonio')
    assert(payload.papel === 'patrimonio', 'C) papel patrimonio persistido no payload', payload.papel)
    const { subject } = renderReservaConfirmadaFromPayload(payload, 'https://app.example.com/x')
    assert(subject.startsWith('[Fluxo Patrimonial] Reserva confirmada —'), 'C) assunto renderizado usa a variante patrimonio', subject)
  }

  // --- D) interno --------------------------------------------------------------
  {
    const payload = construirPayloadReservaConfirmada(inputBase({ tipoEmprestimo: 'interno' }), 'solicitante')
    const { html } = renderReservaConfirmadaFromPayload(payload, 'https://app.example.com/x')
    assert(html.includes('Sua reserva foi confirmada pelo Patrimônio.'), 'D) fluxo interno usa a frase de abertura interna', html)
  }

  // --- E) externo ----------------------------------------------------------------
  {
    const payload = construirPayloadReservaConfirmada(
      inputBase({ tipoEmprestimo: 'externo', atividadeExterna: 'Feira', local: 'Centro', cidade: 'SP', assinaturaConfirmadaEm: new Date('2026-08-19T10:00:00.000Z') }),
      'solicitante'
    )
    const { html } = renderReservaConfirmadaFromPayload(payload, 'https://app.example.com/x')
    assert(html.includes('Sua reserva foi confirmada após a conclusão da etapa de assinatura.'), 'E) fluxo externo usa a frase de abertura externa', html)
  }

  // --- F) assinaturaConfirmadaEmIso correta -----------------------------------
  {
    const confirmadaEm = new Date('2026-08-19T14:30:00.000Z')
    const payload = construirPayloadReservaConfirmada(inputBase({ tipoEmprestimo: 'externo', assinaturaConfirmadaEm: confirmadaEm }), 'solicitante')
    assert(payload.assinaturaConfirmadaEmIso === confirmadaEm.toISOString(), 'F) assinaturaConfirmadaEmIso bate com o ISO da data original', payload.assinaturaConfirmadaEmIso)
    const { html } = renderReservaConfirmadaFromPayload(payload, 'https://app.example.com/x')
    assert(html.includes('Assinatura confirmada em'), 'F) valor chega ao template renderizado', html)
  }

  // --- G) assinatura null aceita -----------------------------------------------
  {
    const payload = construirPayloadReservaConfirmada(inputBase({ tipoEmprestimo: 'externo', assinaturaConfirmadaEm: null }), 'solicitante')
    assert(payload.assinaturaConfirmadaEmIso === null, 'G) assinaturaConfirmadaEmIso é null quando a entrada é null', payload.assinaturaConfirmadaEmIso)
    const { html } = renderReservaConfirmadaFromPayload(payload, 'https://app.example.com/x')
    assert(!html.includes('undefined') && !html.includes('null'), 'G) render não contém "undefined"/"null" com assinatura ausente', html)
  }

  // --- H) datas são strings ISO no payload --------------------------------------
  {
    const payload = construirPayloadReservaConfirmada(inputBase(), 'solicitante')
    assert(typeof payload.dataIso === 'string' && !Number.isNaN(Date.parse(payload.dataIso)), 'H) dataIso é string ISO parseável', payload.dataIso)
  }

  // --- I) renderização determinística -------------------------------------------
  {
    const payload = construirPayloadReservaConfirmada(inputBase(), 'patrimonio')
    const r1 = renderReservaConfirmadaFromPayload(payload, 'https://app.example.com/x', null)
    const r2 = renderReservaConfirmadaFromPayload(payload, 'https://app.example.com/x', null)
    assert(r1.subject === r2.subject && r1.html === r2.html && r1.text === r2.text, 'I) mesmo payload + mesmo link/banner produz renderização idêntica', { r1, r2 })
  }

  // --- J) inline conceitual vs dispatcher conceitual produzem o mesmo e-mail ---
  {
    const payloadConstruido = construirPayloadReservaConfirmada(inputBase({ tipoEmprestimo: 'externo', assinaturaConfirmadaEm: new Date('2026-08-19T10:00:00.000Z') }), 'patrimonio')

    // "inline": usa o payload recém-construído diretamente (sem round-trip de JSON).
    const rendaInline = renderReservaConfirmadaFromPayload(payloadConstruido, 'https://app.example.com/y', null)

    // "dispatcher": simula o que Prisma Json devolveria — serializa e desserializa,
    // depois valida com o parser antes de renderizar.
    const bruto: unknown = JSON.parse(JSON.stringify(payloadConstruido))
    const payloadParseado = parseReservaConfirmadaPayload(bruto)
    const rendaDispatcher = renderReservaConfirmadaFromPayload(payloadParseado, 'https://app.example.com/y', null)

    assert(
      rendaInline.subject === rendaDispatcher.subject && rendaInline.html === rendaDispatcher.html && rendaInline.text === rendaDispatcher.text,
      'J) caminho inline conceitual e caminho dispatcher conceitual (via JSON + parser) produzem subject/html/text idênticos',
      { rendaInline, rendaDispatcher }
    )
  }

  // --- K) payload null → erro controlado ----------------------------------------
  assertLanca(() => parseReservaConfirmadaPayload(null), 'K) payload null lança ReservaConfirmadaPayloadError')
  assertLanca(() => parseReservaConfirmadaPayload(undefined), 'K) payload undefined lança ReservaConfirmadaPayloadError')

  // --- L) payload sem versao → erro -----------------------------------------------
  {
    const payload = construirPayloadReservaConfirmada(inputBase(), 'solicitante') as unknown as Record<string, unknown>
    const { versao: _semVersao, ...semVersao } = payload
    assertLanca(() => parseReservaConfirmadaPayload(semVersao), 'L) payload sem "versao" lança erro')
  }

  // --- M) versao diferente de 1 → erro ---------------------------------------------
  {
    const payload = { ...construirPayloadReservaConfirmada(inputBase(), 'solicitante'), versao: 2 }
    assertLanca(() => parseReservaConfirmadaPayload(payload), 'M) versao !== 1 lança erro')
  }

  // --- N) papel inválido → erro ------------------------------------------------------
  {
    const payload = { ...construirPayloadReservaConfirmada(inputBase(), 'solicitante'), papel: 'admin' }
    assertLanca(() => parseReservaConfirmadaPayload(payload), 'N) papel inválido lança erro')
  }

  // --- O) tipoEmprestimo inválido → erro --------------------------------------------
  {
    const payload = { ...construirPayloadReservaConfirmada(inputBase(), 'solicitante'), tipoEmprestimo: 'hibrido' }
    assertLanca(() => parseReservaConfirmadaPayload(payload), 'O) tipoEmprestimo inválido lança erro')
  }

  // --- P) arrays inválidos → erro --------------------------------------------------
  {
    const base = construirPayloadReservaConfirmada(inputBase(), 'solicitante')
    assertLanca(() => parseReservaConfirmadaPayload({ ...base, itensPatrimonio: 'não é array' }), 'P) itensPatrimonio não-array lança erro')
    assertLanca(() => parseReservaConfirmadaPayload({ ...base, itensPatrimonio: [{ numero: 123 }] }), 'P) item de itensPatrimonio malformado lança erro')
    assertLanca(() => parseReservaConfirmadaPayload({ ...base, itensPapelaria: [{ descricao: 'x', quantidade: 'dez' }] }), 'P) item de itensPapelaria malformado lança erro')
    assertLanca(() => parseReservaConfirmadaPayload({ ...base, itensServico: [{ tipoServicoNome: 'x', quantidade: 'um', ambiente: null }] }), 'P) item de itensServico malformado lança erro')
  }

  // --- Q) dataIso inválida → erro ----------------------------------------------------
  {
    const base = construirPayloadReservaConfirmada(inputBase(), 'solicitante')
    assertLanca(() => parseReservaConfirmadaPayload({ ...base, dataIso: 'não-é-uma-data' }), 'Q) dataIso inválida lança erro')
    assertLanca(() => parseReservaConfirmadaPayload({ ...base, assinaturaConfirmadaEmIso: 'também-inválida' }), 'Q) assinaturaConfirmadaEmIso inválida lança erro')
  }

  // --- R) nenhum erro inclui dump completo do JSON ------------------------------
  {
    const dadoSensivel = 'DADO_SENSIVEL_NAO_DEVE_APARECER_NO_ERRO'
    try {
      parseReservaConfirmadaPayload({ versao: 1, papel: dadoSensivel })
      failures++
      console.error('FALHA - R) esperava lançar erro')
    } catch (err) {
      const mensagem = err instanceof Error ? err.message : String(err)
      assert(!mensagem.includes(dadoSensivel), 'R) mensagem de erro não inclui o valor do campo inválido', mensagem)
      assert(mensagem.length < 200, 'R) mensagem de erro é curta (não é um dump do payload)', mensagem)
    }
  }

  // --- S) APP_URL/link não entra no payload --------------------------------------
  {
    const payload = construirPayloadReservaConfirmada(inputBase(), 'solicitante') as unknown as Record<string, unknown>
    assert(!('link' in payload) && !('APP_URL' in payload) && !('appUrl' in payload), 'S) payload não contém link/APP_URL', Object.keys(payload))
  }

  // --- T) banner/destinatário físico de teste não entram no payload --------------
  {
    const payload = construirPayloadReservaConfirmada(inputBase(), 'solicitante') as unknown as Record<string, unknown>
    assert(
      !('bannerDestinatarioOriginal' in payload) && !('destinatarioFisico' in payload) && !('EMAIL_TEST_RECIPIENT' in payload),
      'T) payload não contém banner/destinatário físico de teste',
      Object.keys(payload)
    )
  }

  // --- U) escaping: snapshot guarda dado bruto; só a renderização HTML escapa ---
  {
    const nomePerigoso = '<script>alert(1)</script>'
    const payload = construirPayloadReservaConfirmada(inputBase({ nomeSolicitante: nomePerigoso }), 'patrimonio')
    assert(payload.nomeSolicitante === nomePerigoso, 'U) payload guarda o nome sem transformação de HTML (dado bruto)', payload.nomeSolicitante)

    const { html, text } = renderReservaConfirmadaFromPayload(payload, 'https://app.example.com/x')
    assert(!html.includes('<script>alert(1)</script>'), 'U) HTML renderizado não contém a tag <script> crua', html)
    assert(html.includes('&lt;script&gt;'), 'U) HTML renderizado contém a versão escapada do nome perigoso', html)
    assert(text.includes(nomePerigoso), 'U) texto puro preserva o dado original sem necessidade de escape', text)
  }

  // --- V) Etapa domain-flow: payload legado (sem notebooksComDominio/tipoDominio) --
  {
    const payloadCompleto = construirPayloadReservaConfirmada(inputBase(), 'solicitante') as unknown as Record<string, unknown>
    const { notebooksComDominio: _n, tipoDominio: _t, ...payloadLegado } = payloadCompleto
    const parseado = parseReservaConfirmadaPayload(payloadLegado)
    assert(parseado.notebooksComDominio === null, 'V) payload sem notebooksComDominio é lido como null (nunca erro)', parseado.notebooksComDominio)
    assert(parseado.tipoDominio === null, 'V) payload sem tipoDominio é lido como null (nunca erro)', parseado.tipoDominio)

    const { html, text } = renderReservaConfirmadaFromPayload(parseado, 'https://app.example.com/z')
    assert(!html.includes('>Domínio<'), 'V) e-mail de payload legado sem domínio não exibe a linha "Domínio"', html)
    assert(!text.includes('Domínio:'), 'V) texto puro de payload legado sem domínio não exibe "Domínio:"', text)

    assertLanca(
      () => parseReservaConfirmadaPayload({ ...payloadLegado, notebooksComDominio: 'sim' }),
      'V) notebooksComDominio malformado (presente e não-boolean) lança erro'
    )
    assertLanca(
      () => parseReservaConfirmadaPayload({ ...payloadLegado, tipoDominio: 'OUTRO' }),
      'V) tipoDominio malformado (fora do enum) lança erro'
    )
  }

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) de payload de reserva-confirmada (Etapa D.3.6.3) falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes de payload de reserva-confirmada (Etapa D.3.6.3) passaram. Nenhum e-mail real foi enviado, nenhum banco real foi acessado.')
}

main().catch((err) => {
  console.error('Falha inesperada ao executar os testes de payload de reserva-confirmada:', err instanceof Error ? err.message : err)
  process.exit(1)
})
