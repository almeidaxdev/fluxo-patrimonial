// scripts/test-email-aguardando-patrimonio-payload.ts
//
// Teste manual (mesmo padrão de scripts/test-email-solicitacao-aguardando-gestor-payload.ts)
// da Etapa email-aguardando-patrimonio: construirPayloadSolicitacaoAguardandoPatrimonio(),
// parseSolicitacaoAguardandoPatrimonioPayload() e
// renderSolicitacaoAguardandoPatrimonioFromPayload()
// (src/lib/email/payloads/solicitacao-aguardando-patrimonio.ts) — payload
// ÚNICO, reaproveitado para todos os destinatários Patrimônio.
//
// Todo o módulo testado é puro (sem Prisma, sem I/O).
//
// Executar com: npm run test:email-aguardando-patrimonio-payload

import {
  construirPayloadSolicitacaoAguardandoPatrimonio,
  parseSolicitacaoAguardandoPatrimonioPayload,
  renderSolicitacaoAguardandoPatrimonioFromPayload,
  SolicitacaoAguardandoPatrimonioPayloadError,
  type ConstruirPayloadSolicitacaoAguardandoPatrimonioInput,
} from '../src/lib/email/payloads/solicitacao-aguardando-patrimonio'

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
    assert(err instanceof SolicitacaoAguardandoPatrimonioPayloadError, label, err instanceof Error ? err.message : err)
  }
}

function inputBase(overrides: Partial<ConstruirPayloadSolicitacaoAguardandoPatrimonioInput> = {}): ConstruirPayloadSolicitacaoAguardandoPatrimonioInput {
  return {
    numero: 44,
    nomeSolicitante: 'Fulano de Tal',
    nomeGestorAprovador: 'Ciclana Gestora',
    tipoEmprestimo: 'externo',
    data: new Date('2026-09-25T00:00:00.000Z'),
    periodos: ['MANHA'],
    ambiente: null,
    finalidade: null,
    atividadeExterna: 'Feira de tecnologia',
    local: 'Centro de Convenções',
    cidade: 'São Paulo',
    observacoes: null,
    itensPatrimonio: [{ numero: '789', marca: 'Dell', modelo: 'Latitude', categoria: 'Notebook' }],
    itensPapelaria: [],
    itensServico: [],
    notebooksComDominio: true,
    tipoDominio: 'EDUCACIONAL',
    ...overrides,
  }
}

function inputBaseInterna(overrides: Partial<ConstruirPayloadSolicitacaoAguardandoPatrimonioInput> = {}): ConstruirPayloadSolicitacaoAguardandoPatrimonioInput {
  return inputBase({
    nomeGestorAprovador: null,
    tipoEmprestimo: 'interno',
    ambiente: 'Sala 12',
    atividadeExterna: null,
    local: null,
    cidade: null,
    ...overrides,
  })
}

async function main() {
  // --- L) nome do solicitante --- M) gestor aprovador --------------------------------
  {
    const itemFonte = { numero: '789', marca: 'Dell', modelo: 'Latitude', categoria: 'Notebook' }
    const input = inputBase({ itensPatrimonio: [itemFonte] })
    const payload = construirPayloadSolicitacaoAguardandoPatrimonio(input)

    itemFonte.marca = 'MUTADO'
    input.nomeGestorAprovador = 'MUTADO'

    assert(payload.itensPatrimonio[0].marca === 'Dell', 'payload continua com os valores históricos (Dell) mesmo após a fonte ser mutada depois', payload.itensPatrimonio[0])
    assert(payload.nomeGestorAprovador === 'Ciclana Gestora', 'nomeGestorAprovador do payload não é afetado pela mutação da fonte depois', payload.nomeGestorAprovador)
    assert(payload.nomeSolicitante === 'Fulano de Tal', 'L) nome do solicitante persistido no payload', payload.nomeSolicitante)
    assert(payload.nomeGestorAprovador === 'Ciclana Gestora', 'M) nome do gestor aprovador persistido no payload', payload.nomeGestorAprovador)
  }

  // --- K) payload histórico completo — round-trip via JSON ---------------------------
  const payloadConstruido = construirPayloadSolicitacaoAguardandoPatrimonio(inputBase())
  const bruto: unknown = JSON.parse(JSON.stringify(payloadConstruido))
  const payloadParseado = parseSolicitacaoAguardandoPatrimonioPayload(bruto)
  assert(payloadParseado.numero === 44, 'K) payload sobrevive ao round-trip JSON (numero)', payloadParseado.numero)
  assert(payloadParseado.nomeGestorAprovador === 'Ciclana Gestora', 'K) payload sobrevive ao round-trip JSON (nomeGestorAprovador)', payloadParseado.nomeGestorAprovador)

  // --- Y) dispatcher renderiza SOMENTE a partir do payload ----------------------------
  const rendaInline = renderSolicitacaoAguardandoPatrimonioFromPayload(payloadConstruido, 'https://app.example.com/y', null)
  const rendaDispatcher = renderSolicitacaoAguardandoPatrimonioFromPayload(payloadParseado, 'https://app.example.com/y', null)
  assert(
    rendaInline.subject === rendaDispatcher.subject && rendaInline.html === rendaDispatcher.html && rendaInline.text === rendaDispatcher.text,
    'Y) caminho inline e caminho dispatcher (via JSON + parser) produzem subject/html/text idênticos, sem dado vivo'
  )

  // --- X) assunto correto --------------------------------------------------------------
  assert(rendaInline.subject === '[Fluxo Patrimonial] Solicitação aguardando análise — #44', 'X) assunto segue a convenção institucional', rendaInline.subject)

  // --- M) gestor aparece no corpo -------------------------------------------------------
  assert(rendaInline.html.includes('Ciclana Gestora') && rendaInline.text.includes('Ciclana Gestora'), 'M) gestor responsável aparece no e-mail', rendaInline.text)
  assert(rendaInline.html.includes('Fulano de Tal') && rendaInline.text.includes('Fulano de Tal'), 'L) solicitante aparece no e-mail', rendaInline.text)

  // --- W) CTA correto --------------------------------------------------------------
  const { html, text } = renderSolicitacaoAguardandoPatrimonioFromPayload(payloadConstruido, 'https://app.example.com/solicitacoes/sol-44')
  assert(html.includes('ANALISAR SOLICITAÇÃO') && html.includes('https://app.example.com/solicitacoes/sol-44'), 'W) botão "Analisar solicitação" aponta para /solicitacoes/{id}', html)
  assert(text.includes('Analisar solicitação: https://app.example.com/solicitacoes/sol-44'), 'W) link textual aparece no texto puro', text)

  // --- N) data civil correta ------------------------------------------------------
  assert(html.includes('25/09/2026') && text.includes('25/09/2026'), 'N) data civil formatada corretamente (formatDataCivil, não Date local)', { html })

  // --- O) períodos ------------------------------------------------------------------
  const payloadTarde = construirPayloadSolicitacaoAguardandoPatrimonio(inputBase({ periodos: ['TARDE', 'NOITE'] }))
  const rendaTarde = renderSolicitacaoAguardandoPatrimonioFromPayload(payloadTarde, 'https://x')
  assert(rendaTarde.text.includes('Tarde') && rendaTarde.text.includes('Noite'), 'O) períodos aparecem formatados no e-mail', rendaTarde.text)

  // --- P) itens patrimoniais --- Q) papelaria --- R) serviços -------------------------
  const payloadItens = construirPayloadSolicitacaoAguardandoPatrimonio(
    inputBase({
      itensPatrimonio: [{ numero: '1', marca: 'Dell', modelo: 'Latitude', categoria: 'Notebook' }],
      itensPapelaria: [{ descricao: 'Cartolina branca', quantidade: 10 }],
      itensServico: [{ tipoServicoNome: 'Montagem de palco', quantidade: 1, ambiente: 'Auditório' }],
    })
  )
  const rendaItens = renderSolicitacaoAguardandoPatrimonioFromPayload(payloadItens, 'https://x')
  assert(rendaItens.text.includes('Dell Latitude') && rendaItens.text.includes('patrimônio 1'), 'P) item patrimonial aparece no e-mail', rendaItens.text)
  assert(rendaItens.text.includes('Cartolina branca'), 'Q) item de papelaria aparece no e-mail', rendaItens.text)
  assert(rendaItens.text.includes('Montagem de palco') && rendaItens.text.includes('Auditório'), 'R) serviço aparece no e-mail', rendaItens.text)

  // --- S/T/U domínio ------------------------------------------------------------------
  const payloadEduc = construirPayloadSolicitacaoAguardandoPatrimonio(inputBase({ notebooksComDominio: true, tipoDominio: 'EDUCACIONAL' }))
  assert(renderSolicitacaoAguardandoPatrimonioFromPayload(payloadEduc, 'https://x').html.includes('Educacional'), 'S) domínio Educacional aparece no e-mail')

  const payloadAdmin = construirPayloadSolicitacaoAguardandoPatrimonio(inputBase({ notebooksComDominio: true, tipoDominio: 'ADMINISTRATIVO' }))
  assert(renderSolicitacaoAguardandoPatrimonioFromPayload(payloadAdmin, 'https://x').html.includes('Administrativo'), 'T) domínio Administrativo aparece no e-mail')

  const payloadSem = construirPayloadSolicitacaoAguardandoPatrimonio(inputBase({ notebooksComDominio: false, tipoDominio: null }))
  const rendaSem = renderSolicitacaoAguardandoPatrimonioFromPayload(payloadSem, 'https://x')
  assert(rendaSem.text.includes('Domínio: Não'), 'U) domínio=false mostra "Domínio: Não"')

  // --- V) sem Notebook → linha omitida -----------------------------------------------
  const payloadSemNotebook = construirPayloadSolicitacaoAguardandoPatrimonio(inputBase({ itensPatrimonio: [], notebooksComDominio: null, tipoDominio: null }))
  const rendaSemNotebook = renderSolicitacaoAguardandoPatrimonioFromPayload(payloadSemNotebook, 'https://x')
  assert(!rendaSemNotebook.html.includes('>Domínio<') && !rendaSemNotebook.text.includes('Domínio:'), 'V) sem Notebook (domínio=null) não exibe nenhuma linha de domínio')

  // --- payload malformado → erro controlado -------------------------------------------
  assertLanca(() => parseSolicitacaoAguardandoPatrimonioPayload(null), 'payload null lança SolicitacaoAguardandoPatrimonioPayloadError')
  assertLanca(() => parseSolicitacaoAguardandoPatrimonioPayload(undefined), 'payload undefined lança SolicitacaoAguardandoPatrimonioPayloadError')
  {
    const base = construirPayloadSolicitacaoAguardandoPatrimonio(inputBase()) as unknown as Record<string, unknown>
    assertLanca(() => parseSolicitacaoAguardandoPatrimonioPayload({ ...base, versao: 2 }), 'versao !== 1 lança erro')
    assertLanca(() => parseSolicitacaoAguardandoPatrimonioPayload({ ...base, nomeGestorAprovador: '' }), 'nomeGestorAprovador vazio lança erro')
    assertLanca(() => parseSolicitacaoAguardandoPatrimonioPayload({ ...base, nomeSolicitante: '' }), 'nomeSolicitante vazio lança erro')
    assertLanca(() => parseSolicitacaoAguardandoPatrimonioPayload({ ...base, tipoDominio: 'OUTRO' }), 'tipoDominio malformado lança erro')
  }

  // --- link/APP_URL nunca entra no payload ------------------------------------------
  {
    const payload = construirPayloadSolicitacaoAguardandoPatrimonio(inputBase()) as unknown as Record<string, unknown>
    assert(!('link' in payload), 'payload não contém link/APP_URL', Object.keys(payload))
  }

  // --- escaping ------------------------------------------------------------------------
  {
    const observacaoPerigosa = '<script>alert(1)</script>'
    const payload = construirPayloadSolicitacaoAguardandoPatrimonio(inputBase({ observacoes: observacaoPerigosa }))
    const { html: htmlEsc, text: textEsc } = renderSolicitacaoAguardandoPatrimonioFromPayload(payload, 'https://x')
    assert(!htmlEsc.includes('<script>alert(1)</script>'), 'HTML renderizado não contém a tag <script> crua nas observações', htmlEsc)
    assert(htmlEsc.includes('&lt;script&gt;'), 'HTML renderizado contém a versão escapada de observações perigosas', htmlEsc)
    assert(textEsc.includes(observacaoPerigosa), 'texto puro preserva a observação original sem necessidade de escape', textEsc)
  }

  // --- Etapa email-patrimonio-solicitacao-interna ------------------------------------

  // J) ambiente interno aparece corretamente / L) template usa texto adequado para INTERNA
  {
    const payloadInterna = construirPayloadSolicitacaoAguardandoPatrimonio(inputBaseInterna())
    const rendaInterna = renderSolicitacaoAguardandoPatrimonioFromPayload(payloadInterna, 'https://x')
    assert(
      rendaInterna.text.includes('Uma nova solicitação está aguardando análise do Patrimônio.'),
      'L) frase de abertura interna não afirma aprovação de gestor',
      rendaInterna.text
    )
    assert(!rendaInterna.text.includes('aprovada pelo gestor'), 'L) texto interno não menciona aprovação de gestor', rendaInterna.text)
    assert(rendaInterna.text.includes('Ambiente: Sala 12'), 'J) ambiente interno aparece no e-mail', rendaInterna.text)

    // K) campos exclusivos de externa não são inventados
    assert(!rendaInterna.html.includes('Gestor responsável'), 'K) e-mail interno não exibe linha "Gestor responsável" (nomeGestorAprovador é null)', rendaInterna.html)
    assert(!rendaInterna.text.includes('Atividade:') && !rendaInterna.text.includes('Cidade:'), 'K) e-mail interno não inventa atividade externa/cidade', rendaInterna.text)
  }

  // Frase/linhas do fluxo externo continuam intactas (regressão)
  {
    const rendaExterna = renderSolicitacaoAguardandoPatrimonioFromPayload(construirPayloadSolicitacaoAguardandoPatrimonio(inputBase()), 'https://x')
    assert(
      rendaExterna.text.includes('Uma solicitação externa foi aprovada pelo gestor responsável e agora aguarda análise do Patrimônio.'),
      'T) frase de abertura externa continua igual à de antes desta etapa',
      rendaExterna.text
    )
    assert(rendaExterna.html.includes('Gestor responsável') && rendaExterna.html.includes('Ciclana Gestora'), 'T) e-mail externo continua exibindo o gestor aprovador', rendaExterna.html)
    assert(!rendaExterna.text.includes('Ambiente:'), 'T) e-mail externo não exibe "Ambiente" (sempre null nesse fluxo)', rendaExterna.text)
  }

  // Payload histórico (persistido ANTES desta etapa, sem tipoEmprestimo/ambiente) →
  // parser trata como externo, compatibilidade preservada (item T do pedido)
  {
    const payloadAntigoBruto = construirPayloadSolicitacaoAguardandoPatrimonio(inputBase()) as unknown as Record<string, unknown>
    delete payloadAntigoBruto.tipoEmprestimo
    delete payloadAntigoBruto.ambiente
    const payloadAntigoParseado = parseSolicitacaoAguardandoPatrimonioPayload(payloadAntigoBruto)
    assert(payloadAntigoParseado.tipoEmprestimo === 'externo', 'T) payload histórico sem tipoEmprestimo é tratado como externo', payloadAntigoParseado.tipoEmprestimo)
    assert(payloadAntigoParseado.ambiente === null, 'T) payload histórico sem ambiente é normalizado para null', payloadAntigoParseado.ambiente)
    const rendaAntiga = renderSolicitacaoAguardandoPatrimonioFromPayload(payloadAntigoParseado, 'https://x')
    assert(
      rendaAntiga.text.includes('Uma solicitação externa foi aprovada pelo gestor responsável e agora aguarda análise do Patrimônio.'),
      'T) payload histórico renderiza a mesma frase externa de antes desta etapa',
      rendaAntiga.text
    )
  }

  // nomeGestorAprovador === null é um payload válido (interno), não um erro de parse
  {
    const payloadInternaBruto = JSON.parse(JSON.stringify(construirPayloadSolicitacaoAguardandoPatrimonio(inputBaseInterna())))
    const payloadInternaParseado = parseSolicitacaoAguardandoPatrimonioPayload(payloadInternaBruto)
    assert(payloadInternaParseado.nomeGestorAprovador === null, 'nomeGestorAprovador null sobrevive ao round-trip JSON sem lançar erro', payloadInternaParseado.nomeGestorAprovador)
    assert(payloadInternaParseado.tipoEmprestimo === 'interno', 'tipoEmprestimo=interno sobrevive ao round-trip JSON', payloadInternaParseado.tipoEmprestimo)
  }

  // tipoEmprestimo malformado → erro controlado
  {
    const base = construirPayloadSolicitacaoAguardandoPatrimonio(inputBase()) as unknown as Record<string, unknown>
    assertLanca(() => parseSolicitacaoAguardandoPatrimonioPayload({ ...base, tipoEmprestimo: 'hibrido' }), 'tipoEmprestimo malformado lança erro')
    assertLanca(() => parseSolicitacaoAguardandoPatrimonioPayload({ ...base, ambiente: 123 }), 'ambiente com tipo inválido lança erro')
  }

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) de payload de SOLICITACAO_AGUARDANDO_PATRIMONIO falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes de payload de SOLICITACAO_AGUARDANDO_PATRIMONIO passaram. Nenhum e-mail real foi enviado, nenhum banco real foi acessado.')
}

main().catch((err) => {
  console.error('Falha inesperada ao executar os testes de payload de aguardando-patrimônio:', err instanceof Error ? err.message : err)
  process.exit(1)
})
