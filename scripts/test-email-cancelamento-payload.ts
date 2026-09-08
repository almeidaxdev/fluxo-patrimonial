// scripts/test-email-cancelamento-payload.ts
//
// Teste manual (mesmo padrão de scripts/test-email-rejeicao-payload.ts) da
// Etapa email-cancelamento: construirPayloadCancelamento(),
// parseCancelamentoPayload() e renderCancelamentoFromPayload()
// (src/lib/email/payloads/cancelamento.ts) — um payload por destinatário
// (`papel: 'solicitante' | 'patrimonio'`), mesmo princípio de
// RESERVA_CONFIRMADA.
//
// Todo o módulo testado é puro (sem Prisma, sem I/O).
//
// Executar com: npm run test:email-cancelamento-payload

import {
  construirPayloadCancelamento,
  parseCancelamentoPayload,
  renderCancelamentoFromPayload,
  CancelamentoPayloadError,
  type ConstruirPayloadCancelamentoInput,
} from '../src/lib/email/payloads/cancelamento'
import type { PapelDestinatario } from '../src/lib/email/templates/cancelamento'

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
    assert(err instanceof CancelamentoPayloadError, label, err instanceof Error ? err.message : err)
  }
}

function inputBase(overrides: Partial<ConstruirPayloadCancelamentoInput> = {}): ConstruirPayloadCancelamentoInput {
  return {
    numero: 55,
    nomeSolicitante: 'Fulano de Tal',
    tipoEmprestimo: 'externo',
    data: new Date('2026-09-15T00:00:00.000Z'),
    periodos: ['MANHA'],
    ambiente: null,
    finalidade: null,
    atividadeExterna: 'Feira de tecnologia',
    local: 'Centro de Convenções',
    cidade: 'São Paulo',
    observacoes: null,
    itensPatrimonio: [{ numero: '321', marca: 'Dell', modelo: 'Latitude', categoria: 'Notebook' }],
    itensPapelaria: [],
    itensServico: [],
    notebooksComDominio: true,
    tipoDominio: 'EDUCACIONAL',
    canceladoPorNome: 'Ciclana Gestora',
    motivo: null,
    ...overrides,
  }
}

async function main() {
  // --- snapshot imutável --------------------------------------------------
  {
    const itemFonte = { numero: '321', marca: 'Dell', modelo: 'Latitude', categoria: 'Notebook' }
    const input = inputBase({ itensPatrimonio: [itemFonte] })
    const payload = construirPayloadCancelamento(input, 'solicitante')

    itemFonte.marca = 'MUTADO'
    input.canceladoPorNome = 'MUTADO'

    assert(payload.itensPatrimonio[0].marca === 'Dell', 'payload continua com os valores históricos (Dell) mesmo após a fonte ser mutada depois', payload.itensPatrimonio[0])
    assert(payload.canceladoPorNome === 'Ciclana Gestora', 'canceladoPorNome do payload não é afetado pela mutação da fonte depois', payload.canceladoPorNome)
  }

  for (const papel of ['solicitante', 'patrimonio'] as PapelDestinatario[]) {
    // --- payload histórico completo — round-trip via JSON -------------------
    const payloadConstruido = construirPayloadCancelamento(inputBase(), papel)
    const bruto: unknown = JSON.parse(JSON.stringify(payloadConstruido))
    const payloadParseado = parseCancelamentoPayload(bruto)
    assert(payloadParseado.papel === papel, `[${papel}] payload sobrevive ao round-trip JSON (papel)`, payloadParseado.papel)
    assert(payloadParseado.canceladoPorNome === 'Ciclana Gestora', `[${papel}] payload sobrevive ao round-trip JSON (canceladoPorNome)`, payloadParseado.canceladoPorNome)

    // --- dispatcher renderiza SOMENTE a partir do payload -------------------------
    const rendaInline = renderCancelamentoFromPayload(payloadConstruido, 'https://app.example.com/y', null)
    const rendaDispatcher = renderCancelamentoFromPayload(payloadParseado, 'https://app.example.com/y', null)
    assert(
      rendaInline.subject === rendaDispatcher.subject && rendaInline.html === rendaDispatcher.html && rendaInline.text === rendaDispatcher.text,
      `[${papel}] caminho inline e caminho dispatcher (via JSON + parser) produzem subject/html/text idênticos, sem dado vivo`
    )

    // --- assunto correto (mesmo assunto para os dois papéis) ------------------------
    assert(rendaInline.subject === '[Fluxo Patrimonial] Solicitação cancelada — #55', `[${papel}] assunto segue a convenção institucional`, rendaInline.subject)

    // --- C) motivo ausente (realidade atual da rota) → linha omitida ------------------
    assert(!rendaInline.html.includes('Motivo do cancelamento') && !rendaInline.text.includes('Motivo do cancelamento'), `[${papel}] motivo=null (rota não coleta motivo hoje) → linha "Motivo do cancelamento" omitida`, rendaInline.text)

    // --- C, variante forward-compat) motivo presente (se algum dia a rota passar a coletar) --
    const payloadComMotivo = construirPayloadCancelamento(inputBase({ motivo: 'Item danificado, cancelado preventivamente.' }), papel)
    const rendaComMotivo = renderCancelamentoFromPayload(payloadComMotivo, 'https://x')
    assert(rendaComMotivo.html.includes('Item danificado') && rendaComMotivo.text.includes('Item danificado'), `[${papel}] quando motivo está presente no payload, aparece no e-mail`, rendaComMotivo.text)

    // --- L) CTA correto --------------------------------------------------------------
    const { html, text } = renderCancelamentoFromPayload(payloadConstruido, 'https://app.example.com/solicitacoes/sol-55')
    assert(html.includes('VER SOLICITAÇÃO') && html.includes('https://app.example.com/solicitacoes/sol-55'), `[${papel}] botão "Ver solicitação" aponta para /solicitacoes/{id}`, html)
    assert(text.includes('Ver solicitação: https://app.example.com/solicitacoes/sol-55'), `[${papel}] link textual aparece no texto puro`, text)

    // --- G) data civil correta ------------------------------------------------------
    assert(html.includes('15/09/2026') && text.includes('15/09/2026'), `[${papel}] data civil formatada corretamente (formatDataCivil, não Date local)`, { html })

    // --- H/I/J domínio ------------------------------------------------------------------
    const payloadEduc = construirPayloadCancelamento(inputBase({ notebooksComDominio: true, tipoDominio: 'EDUCACIONAL' }), papel)
    assert(renderCancelamentoFromPayload(payloadEduc, 'https://x').html.includes('Educacional'), `[${papel}] domínio Educacional aparece no e-mail`)

    const payloadAdmin = construirPayloadCancelamento(inputBase({ notebooksComDominio: true, tipoDominio: 'ADMINISTRATIVO' }), papel)
    assert(renderCancelamentoFromPayload(payloadAdmin, 'https://x').html.includes('Administrativo'), `[${papel}] domínio Administrativo aparece no e-mail`)

    const payloadSem = construirPayloadCancelamento(inputBase({ notebooksComDominio: false, tipoDominio: null }), papel)
    const rendaSem = renderCancelamentoFromPayload(payloadSem, 'https://x')
    assert(rendaSem.text.includes('Domínio: Não'), `[${papel}] domínio=false mostra "Domínio: Não"`)

    // --- K) sem Notebook → linha omitida -----------------------------------------------
    const payloadSemNotebook = construirPayloadCancelamento(inputBase({ itensPatrimonio: [], notebooksComDominio: null, tipoDominio: null }), papel)
    const rendaSemNotebook = renderCancelamentoFromPayload(payloadSemNotebook, 'https://x')
    assert(!rendaSemNotebook.html.includes('>Domínio<') && !rendaSemNotebook.text.includes('Domínio:'), `[${papel}] sem Notebook (domínio=null) não exibe nenhuma linha de domínio`)

    // --- "cancelado por" aparece no resumo, para os dois papéis -----------------------
    assert(rendaInline.text.includes('Cancelado por: Ciclana Gestora'), `[${papel}] linha "Cancelado por" aparece no resumo`, rendaInline.text)
  }

  // --- frases de abertura distintas por papel ------------------------------------------
  {
    const payloadSolicitante = construirPayloadCancelamento(inputBase(), 'solicitante')
    const rendaSolicitante = renderCancelamentoFromPayload(payloadSolicitante, 'https://x')
    assert(rendaSolicitante.text.includes('Sua solicitação foi cancelada.'), 'solicitante recebe frase em primeira pessoa', rendaSolicitante.text)

    const payloadPatrimonio = construirPayloadCancelamento(inputBase(), 'patrimonio')
    const rendaPatrimonio = renderCancelamentoFromPayload(payloadPatrimonio, 'https://x')
    assert(
      rendaPatrimonio.text.includes('não deve mais ser preparada/entregue'),
      'Patrimônio recebe frase operacional explícita ("não deve mais ser preparada/entregue")',
      rendaPatrimonio.text
    )
    assert(rendaPatrimonio.text.includes('Solicitante: Fulano de Tal'), 'Patrimônio vê o nome do solicitante no resumo (solicitante não vê essa linha redundante)', rendaPatrimonio.text)
    assert(!rendaSolicitante.text.includes('Solicitante: Fulano de Tal'), 'solicitante não vê uma linha "Solicitante" redundante sobre si mesmo', rendaSolicitante.text)
  }

  // --- reserva interna cancelada (ambiente, não atividade) ------------------------------
  {
    const payload = construirPayloadCancelamento(
      inputBase({ tipoEmprestimo: 'interno', ambiente: 'Laboratório 2', atividadeExterna: null, local: null, cidade: null }),
      'patrimonio'
    )
    const { html, text } = renderCancelamentoFromPayload(payload, 'https://x')
    assert(html.includes('Laboratório 2') && text.includes('Laboratório 2'), 'reserva interna cancelada mostra Ambiente (não Atividade/Local/Cidade)', { html })
  }

  // --- payload malformado → erro controlado -------------------------------------------
  assertLanca(() => parseCancelamentoPayload(null), 'payload null lança CancelamentoPayloadError')
  assertLanca(() => parseCancelamentoPayload(undefined), 'payload undefined lança CancelamentoPayloadError')
  {
    const base = construirPayloadCancelamento(inputBase(), 'solicitante') as unknown as Record<string, unknown>
    assertLanca(() => parseCancelamentoPayload({ ...base, versao: 2 }), 'versao !== 1 lança erro')
    assertLanca(() => parseCancelamentoPayload({ ...base, papel: 'gestor' }), 'papel inválido (não é solicitante/patrimonio) lança erro')
    assertLanca(() => parseCancelamentoPayload({ ...base, canceladoPorNome: '' }), 'canceladoPorNome vazio lança erro')
    assertLanca(() => parseCancelamentoPayload({ ...base, motivo: 123 }), 'motivo de tipo inválido (nem string nem null) lança erro')
    assertLanca(() => parseCancelamentoPayload({ ...base, tipoDominio: 'OUTRO' }), 'tipoDominio malformado lança erro')
  }

  // --- motivo null é aceito explicitamente pelo parser (não é campo ausente) ------------
  {
    const payload = construirPayloadCancelamento(inputBase({ motivo: null }), 'solicitante')
    const bruto = JSON.parse(JSON.stringify(payload))
    const parseado = parseCancelamentoPayload(bruto)
    assert(parseado.motivo === null, 'motivo: null sobrevive ao round-trip JSON sem lançar erro', parseado.motivo)
  }

  // --- link/APP_URL nunca entra no payload ------------------------------------------
  {
    const payload = construirPayloadCancelamento(inputBase(), 'solicitante') as unknown as Record<string, unknown>
    assert(!('link' in payload), 'payload não contém link/APP_URL', Object.keys(payload))
  }

  // --- escaping ------------------------------------------------------------------------
  {
    const motivoPerigoso = '<script>alert(1)</script>'
    const payload = construirPayloadCancelamento(inputBase({ motivo: motivoPerigoso }), 'solicitante')
    const { html, text } = renderCancelamentoFromPayload(payload, 'https://x')
    assert(!html.includes('<script>alert(1)</script>'), 'HTML renderizado não contém a tag <script> crua no motivo', html)
    assert(html.includes('&lt;script&gt;'), 'HTML renderizado contém a versão escapada do motivo perigoso', html)
    assert(text.includes(motivoPerigoso), 'texto puro preserva o motivo original sem necessidade de escape', text)
  }

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) de payload de cancelamento falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes de payload de cancelamento (CANCELAMENTO) passaram. Nenhum e-mail real foi enviado, nenhum banco real foi acessado.')
}

main().catch((err) => {
  console.error('Falha inesperada ao executar os testes de payload de cancelamento:', err instanceof Error ? err.message : err)
  process.exit(1)
})
