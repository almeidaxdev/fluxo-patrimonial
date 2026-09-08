// scripts/test-email-assinatura-pendente-payload.ts
//
// Teste manual (mesmo padrão de scripts/test-email-solicitacao-aguardando-gestor-payload.ts)
// da Etapa email-assinatura-pendente: construirPayloadAssinaturaPendente(),
// parseAssinaturaPendentePayload() e renderAssinaturaPendenteFromPayload()
// (src/lib/email/payloads/assinatura-pendente.ts).
//
// Etapa fix/signature-resend (idempotência por geração lógica): o payload
// ganhou o campo `geracao` — cenários G1-G4 abaixo cobrem especificamente
// construção, round-trip, validação e compatibilidade histórica desse
// campo (payloads gravados antes desta etapa nunca o tinham).
//
// Todo o módulo testado é puro (sem Prisma, sem I/O) — este script não abre
// conexão com o banco nem envia e-mail real.
//
// Executar com: npm run test:email-assinatura-pendente-payload

import {
  construirPayloadAssinaturaPendente,
  parseAssinaturaPendentePayload,
  renderAssinaturaPendenteFromPayload,
  AssinaturaPendentePayloadError,
  type ConstruirPayloadAssinaturaPendenteInput,
} from '../src/lib/email/payloads/assinatura-pendente'

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
    const ehTipoCerto = err instanceof AssinaturaPendentePayloadError
    assert(ehTipoCerto, label, err instanceof Error ? err.message : err)
  }
}

function inputBase(overrides: Partial<ConstruirPayloadAssinaturaPendenteInput> = {}): ConstruirPayloadAssinaturaPendenteInput {
  return {
    numero: 88,
    nomeSolicitante: 'Fulano de Tal',
    data: new Date('2026-09-05T00:00:00.000Z'),
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
    const payload = construirPayloadAssinaturaPendente(input, 1)

    itemFonte.marca = 'MUTADO'
    input.nomeSolicitante = 'NOME MUTADO'

    assert(payload.itensPatrimonio[0].marca === 'Dell', 'A) payload continua com os valores históricos (Dell) mesmo após a fonte ser mutada depois', payload.itensPatrimonio[0])
    assert(payload.nomeSolicitante === 'Fulano de Tal', 'A) nomeSolicitante do payload não é afetado pela mutação da fonte depois', payload.nomeSolicitante)

    const { html, text } = renderAssinaturaPendenteFromPayload(payload, 'https://app.example.com/x')
    assert(html.includes('Dell') && text.includes('Dell'), 'A) renderização a partir do payload contém os valores históricos', { html, text })
    assert(!html.includes('MUTADO') && !text.includes('MUTADO'), 'A) renderização NÃO contém os valores injetados depois na fonte', { html, text })
  }

  // --- F) payload histórico completo — round-trip via JSON ---------------------------------
  {
    const payloadConstruido = construirPayloadAssinaturaPendente(inputBase(), 1)
    const bruto: unknown = JSON.parse(JSON.stringify(payloadConstruido))
    const payloadParseado = parseAssinaturaPendentePayload(bruto)
    assert(payloadParseado.numero === 88, 'F) payload sobrevive ao round-trip JSON (numero)', payloadParseado.numero)
    assert(payloadParseado.local === 'Centro de Convenções', 'F) payload sobrevive ao round-trip JSON (local)', payloadParseado.local)
    assert(payloadParseado.itensPatrimonio.length === 1, 'F) payload sobrevive ao round-trip JSON (itensPatrimonio)', payloadParseado.itensPatrimonio)
    assert(payloadParseado.geracao === 1, 'F) geracao sobrevive ao round-trip JSON', payloadParseado.geracao)

    // --- G) dispatcher renderiza SOMENTE a partir do payload — sem qualquer consulta viva ---
    const rendaInline = renderAssinaturaPendenteFromPayload(payloadConstruido, 'https://app.example.com/y', null)
    const rendaDispatcher = renderAssinaturaPendenteFromPayload(payloadParseado, 'https://app.example.com/y', null)
    assert(
      rendaInline.subject === rendaDispatcher.subject && rendaInline.html === rendaDispatcher.html && rendaInline.text === rendaDispatcher.text,
      'G) caminho inline e caminho dispatcher (via JSON + parser) produzem subject/html/text idênticos, sem dado vivo',
      { rendaInline, rendaDispatcher }
    )
  }

  // --- H) CTA "Realizar assinatura" aponta para /solicitacoes/{id}, nunca para Assinatura.link ---
  {
    const payload = construirPayloadAssinaturaPendente(inputBase(), 1)
    const { html, text, subject } = renderAssinaturaPendenteFromPayload(payload, 'https://app.example.com/solicitacoes/sol-88')
    assert(html.includes('REALIZAR ASSINATURA') && html.includes('https://app.example.com/solicitacoes/sol-88'), 'H) botão "Realizar assinatura" aponta para o link de /solicitacoes/{id} fornecido', html)
    assert(text.includes('Realizar assinatura: https://app.example.com/solicitacoes/sol-88'), 'H) link textual aparece no texto puro', text)
    assert(subject === '[Fluxo Patrimonial] Assinatura pendente — Reserva #88', 'H) assunto segue a convenção institucional com o número da solicitação', subject)
  }

  // --- L) data civil correta -----------------------------------------------------------------
  {
    const payload = construirPayloadAssinaturaPendente(inputBase({ data: new Date('2026-09-05T00:00:00.000Z') }), 1)
    const { html, text } = renderAssinaturaPendenteFromPayload(payload, 'https://app.example.com/x')
    assert(html.includes('05/09/2026') && text.includes('05/09/2026'), 'L) data civil formatada corretamente (formatDataCivil, não Date local)', { html, text })
  }

  // --- M) domínio Educacional ----------------------------------------------------------------
  {
    const payload = construirPayloadAssinaturaPendente(inputBase({ notebooksComDominio: true, tipoDominio: 'EDUCACIONAL' }), 1)
    const { html, text } = renderAssinaturaPendenteFromPayload(payload, 'https://app.example.com/x')
    assert(html.includes('Educacional') && text.includes('Educacional'), 'M) domínio Educacional aparece no e-mail', { html, text })
  }

  // --- N) domínio Administrativo -------------------------------------------------------------
  {
    const payload = construirPayloadAssinaturaPendente(inputBase({ notebooksComDominio: true, tipoDominio: 'ADMINISTRATIVO' }), 1)
    const { html, text } = renderAssinaturaPendenteFromPayload(payload, 'https://app.example.com/x')
    assert(html.includes('Administrativo') && text.includes('Administrativo'), 'N) domínio Administrativo aparece no e-mail', { html, text })
  }

  // --- O) sem domínio (notebooksComDominio=false) -------------------------------------------
  {
    const payload = construirPayloadAssinaturaPendente(inputBase({ notebooksComDominio: false, tipoDominio: null }), 1)
    const { html, text } = renderAssinaturaPendenteFromPayload(payload, 'https://app.example.com/x')
    assert(html.includes('Domínio') && text.includes('Domínio: Não'), 'O) domínio=false mostra "Domínio: Não"', { html, text })
  }

  // --- P) sem Notebook (domínio=null) → linha omitida ---------------------------------------
  {
    const payload = construirPayloadAssinaturaPendente(inputBase({ itensPatrimonio: [], notebooksComDominio: null, tipoDominio: null }), 1)
    const { html, text } = renderAssinaturaPendenteFromPayload(payload, 'https://app.example.com/x')
    assert(!html.includes('>Domínio<') && !text.includes('Domínio:'), 'P) sem Notebook (domínio=null) não exibe nenhuma linha de domínio', { html, text })
  }

  // --- Assinatura.link NUNCA entra no payload (decisão de segurança do CTA) ------------------
  {
    const payload = construirPayloadAssinaturaPendente(inputBase(), 1) as unknown as Record<string, unknown>
    assert(!('link' in payload) && !('assinaturaLink' in payload), 'payload não contém link/assinaturaLink — CTA é sempre /solicitacoes/{id}, calculado fora do snapshot', Object.keys(payload))
  }

  // --- G1) construirPayloadAssinaturaPendente grava exatamente a geração recebida ------------
  {
    const payload1 = construirPayloadAssinaturaPendente(inputBase(), 1)
    const payload2 = construirPayloadAssinaturaPendente(inputBase(), 2)
    const payload7 = construirPayloadAssinaturaPendente(inputBase(), 7)
    assert(payload1.geracao === 1, 'G1) geracao=1 gravada corretamente', payload1.geracao)
    assert(payload2.geracao === 2, 'G1) geracao=2 gravada corretamente (reenvio depois de ENVIADO)', payload2.geracao)
    assert(payload7.geracao === 7, 'G1) geracao=7 gravada corretamente (não há limite artificial)', payload7.geracao)
  }

  // --- G2) geracao sobrevive ao round-trip JSON (parser não força para 1) --------------------
  {
    const bruto: unknown = JSON.parse(JSON.stringify(construirPayloadAssinaturaPendente(inputBase(), 3)))
    const parseado = parseAssinaturaPendentePayload(bruto)
    assert(parseado.geracao === 3, 'G2) geracao=3 sobrevive ao round-trip JSON — parser não reseta para 1', parseado.geracao)
  }

  // --- G3) compatibilidade histórica: payload gravado ANTES desta etapa não tem `geracao` ----
  // Simula exatamente um EmailEvento.payload real persistido antes da Etapa
  // fix/signature-resend: todos os campos de sempre, SEM o campo novo.
  {
    const completo = construirPayloadAssinaturaPendente(inputBase(), 1) as unknown as Record<string, unknown>
    const { geracao: _g, ...semGeracao } = completo
    const parseado = parseAssinaturaPendentePayload(semGeracao)
    assert(parseado.geracao === 1, 'G3) payload histórico sem `geracao` é lido como geração 1 (nunca erro, nunca undefined)', parseado.geracao)
    // Confirma que o resto do payload continua íntegro — a compatibilidade
    // histórica não é feita às custas de perder outros campos.
    assert(parseado.numero === 88, 'G3) demais campos do payload histórico continuam corretos', parseado.numero)
  }

  // --- G4) `geracao` malformado (presente, mas inválido) lança erro — nunca fallback silencioso ---
  {
    const base = construirPayloadAssinaturaPendente(inputBase(), 1) as unknown as Record<string, unknown>
    assertLanca(() => parseAssinaturaPendentePayload({ ...base, geracao: 0 }), 'G4) geracao=0 (fora do domínio, mínimo é 1) lança erro')
    assertLanca(() => parseAssinaturaPendentePayload({ ...base, geracao: -1 }), 'G4) geracao negativa lança erro')
    assertLanca(() => parseAssinaturaPendentePayload({ ...base, geracao: 1.5 }), 'G4) geracao não-inteira lança erro')
    assertLanca(() => parseAssinaturaPendentePayload({ ...base, geracao: 'um' }), 'G4) geracao como string lança erro')
  }

  // --- payload null/versão/campos malformados → erro controlado ------------------------------
  assertLanca(() => parseAssinaturaPendentePayload(null), 'payload null lança AssinaturaPendentePayloadError')
  assertLanca(() => parseAssinaturaPendentePayload(undefined), 'payload undefined lança AssinaturaPendentePayloadError')
  {
    const payload = { ...construirPayloadAssinaturaPendente(inputBase(), 1), versao: 2 }
    assertLanca(() => parseAssinaturaPendentePayload(payload), 'versao !== 1 lança erro')
  }
  {
    const base = construirPayloadAssinaturaPendente(inputBase(), 1) as unknown as Record<string, unknown>
    assertLanca(() => parseAssinaturaPendentePayload({ ...base, itensPatrimonio: 'não é array' }), 'itensPatrimonio não-array lança erro')
    assertLanca(() => parseAssinaturaPendentePayload({ ...base, notebooksComDominio: 'sim' }), 'notebooksComDominio malformado (presente e não-boolean) lança erro')
    assertLanca(() => parseAssinaturaPendentePayload({ ...base, tipoDominio: 'OUTRO' }), 'tipoDominio malformado (fora do enum) lança erro')
    assertLanca(() => parseAssinaturaPendentePayload({ ...base, dataIso: 'não-é-uma-data' }), 'dataIso inválida lança erro')
  }

  // --- retrocompatibilidade: payload sem notebooksComDominio/tipoDominio ---------------------
  {
    const completo = construirPayloadAssinaturaPendente(inputBase(), 1) as unknown as Record<string, unknown>
    const { notebooksComDominio: _n, tipoDominio: _t, ...semDominio } = completo
    const parseado = parseAssinaturaPendentePayload(semDominio)
    assert(parseado.notebooksComDominio === null, 'payload sem notebooksComDominio é lido como null (nunca erro)', parseado.notebooksComDominio)
    assert(parseado.tipoDominio === null, 'payload sem tipoDominio é lido como null (nunca erro)', parseado.tipoDominio)
  }

  // --- escaping: snapshot guarda dado bruto; só a renderização HTML escapa -------------------
  {
    const nomePerigoso = '<script>alert(1)</script>'
    const payload = construirPayloadAssinaturaPendente(inputBase({ nomeSolicitante: nomePerigoso }), 1)
    assert(payload.nomeSolicitante === nomePerigoso, 'payload guarda o nome sem transformação de HTML (dado bruto)', payload.nomeSolicitante)

    const { html, text } = renderAssinaturaPendenteFromPayload(payload, 'https://app.example.com/x')
    assert(!html.includes('<script>alert(1)</script>'), 'HTML renderizado não contém a tag <script> crua', html)
    assert(html.includes('&lt;script&gt;'), 'HTML renderizado contém a versão escapada do nome perigoso', html)
    assert(text.includes(nomePerigoso), 'texto puro preserva o dado original sem necessidade de escape', text)
  }

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) de payload de ASSINATURA_PENDENTE falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes de payload de ASSINATURA_PENDENTE passaram. Nenhum e-mail real foi enviado, nenhum banco real foi acessado.')
}

main().catch((err) => {
  console.error('Falha inesperada ao executar os testes de payload de ASSINATURA_PENDENTE:', err instanceof Error ? err.message : err)
  process.exit(1)
})
