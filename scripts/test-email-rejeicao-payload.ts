// scripts/test-email-rejeicao-payload.ts
//
// Teste manual (mesmo padrão de scripts/test-email-solicitacao-aguardando-gestor-payload.ts)
// da Etapa email-rejeicoes: construirPayloadRejeicao(), parseRejeicaoPayload()
// e renderRejeicaoFromPayload() (src/lib/email/payloads/rejeicao.ts) — módulo
// ÚNICO compartilhado por REJEICAO_GESTOR e REJEICAO_PATRIMONIO (só `papel` muda).
//
// Todo o módulo testado é puro (sem Prisma, sem I/O).
//
// Executar com: npm run test:email-rejeicao-payload

import {
  construirPayloadRejeicao,
  parseRejeicaoPayload,
  renderRejeicaoFromPayload,
  RejeicaoPayloadError,
  type ConstruirPayloadRejeicaoInput,
} from '../src/lib/email/payloads/rejeicao'
import type { PapelRejeicao } from '../src/lib/email/templates/rejeicao'

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
    assert(err instanceof RejeicaoPayloadError, label, err instanceof Error ? err.message : err)
  }
}

function inputBase(overrides: Partial<ConstruirPayloadRejeicaoInput> = {}): ConstruirPayloadRejeicaoInput {
  return {
    numero: 99,
    nomeSolicitante: 'Fulano de Tal',
    tipoEmprestimo: 'externo',
    data: new Date('2026-09-10T00:00:00.000Z'),
    periodos: ['TARDE'],
    ambiente: null,
    finalidade: null,
    atividadeExterna: 'Feira de tecnologia',
    local: 'Centro de Convenções',
    cidade: 'São Paulo',
    observacoes: null,
    itensPatrimonio: [{ numero: '123', marca: 'Dell', modelo: 'Latitude', categoria: 'Notebook' }],
    itensPapelaria: [],
    itensServico: [],
    notebooksComDominio: true,
    tipoDominio: 'EDUCACIONAL',
    motivo: 'Documentação incompleta para a atividade externa.',
    ...overrides,
  }
}

async function main() {
  // --- snapshot imutável (mesmo princípio de RESERVA_CONFIRMADA/etc.) --------------
  {
    const itemFonte = { numero: '123', marca: 'Dell', modelo: 'Latitude', categoria: 'Notebook' }
    const input = inputBase({ itensPatrimonio: [itemFonte] })
    const payload = construirPayloadRejeicao(input, 'gestor')

    itemFonte.marca = 'MUTADO'
    input.motivo = 'MOTIVO MUTADO'

    assert(payload.itensPatrimonio[0].marca === 'Dell', 'payload continua com os valores históricos (Dell) mesmo após a fonte ser mutada depois', payload.itensPatrimonio[0])
    assert(payload.motivo === 'Documentação incompleta para a atividade externa.', 'motivo do payload não é afetado pela mutação da fonte depois', payload.motivo)
  }

  for (const papel of ['gestor', 'patrimonio'] as PapelRejeicao[]) {
    // --- A/P) payload histórico completo — round-trip via JSON -------------------
    const payloadConstruido = construirPayloadRejeicao(inputBase(), papel)
    const bruto: unknown = JSON.parse(JSON.stringify(payloadConstruido))
    const payloadParseado = parseRejeicaoPayload(bruto)
    assert(payloadParseado.papel === papel, `[${papel}] payload sobrevive ao round-trip JSON (papel)`, payloadParseado.papel)
    assert(payloadParseado.motivo === 'Documentação incompleta para a atividade externa.', `[${papel}] payload sobrevive ao round-trip JSON (motivo)`, payloadParseado.motivo)

    // --- dispatcher renderiza SOMENTE a partir do payload -------------------------
    const rendaInline = renderRejeicaoFromPayload(payloadConstruido, 'https://app.example.com/y', null)
    const rendaDispatcher = renderRejeicaoFromPayload(payloadParseado, 'https://app.example.com/y', null)
    assert(
      rendaInline.subject === rendaDispatcher.subject && rendaInline.html === rendaDispatcher.html && rendaInline.text === rendaDispatcher.text,
      `[${papel}] caminho inline e caminho dispatcher (via JSON + parser) produzem subject/html/text idênticos, sem dado vivo`
    )

    // --- E/T) motivo aparece no template -------------------------------------------
    assert(rendaInline.html.includes('Documentação incompleta') && rendaInline.text.includes('Documentação incompleta'), `[${papel}] motivo da rejeição aparece no e-mail`, { html: rendaInline.html })

    // --- assunto correto por papel --------------------------------------------------
    const assuntoEsperado =
      papel === 'gestor' ? '[Fluxo Patrimonial] Solicitação rejeitada pelo gestor — #99' : '[Fluxo Patrimonial] Solicitação rejeitada pelo Patrimônio — #99'
    assert(rendaInline.subject === assuntoEsperado, `[${papel}] assunto segue a convenção institucional e identifica quem rejeitou`, rendaInline.subject)

    // --- O/CTA correto --------------------------------------------------------------
    const { html, text } = renderRejeicaoFromPayload(payloadConstruido, 'https://app.example.com/solicitacoes/sol-99')
    assert(html.includes('VER SOLICITAÇÃO') && html.includes('https://app.example.com/solicitacoes/sol-99'), `[${papel}] botão "Ver solicitação" aponta para /solicitacoes/{id}`, html)
    assert(text.includes('Ver solicitação: https://app.example.com/solicitacoes/sol-99'), `[${papel}] link textual aparece no texto puro`, text)

    // --- I/X) data civil correta ------------------------------------------------------
    assert(html.includes('10/09/2026') && text.includes('10/09/2026'), `[${papel}] data civil formatada corretamente (formatDataCivil, não Date local)`, { html })

    // --- J/K/L domínio ------------------------------------------------------------------
    const payloadEduc = construirPayloadRejeicao(inputBase({ notebooksComDominio: true, tipoDominio: 'EDUCACIONAL' }), papel)
    assert(renderRejeicaoFromPayload(payloadEduc, 'https://x').html.includes('Educacional'), `[${papel}] domínio Educacional aparece no e-mail`)

    const payloadAdmin = construirPayloadRejeicao(inputBase({ notebooksComDominio: true, tipoDominio: 'ADMINISTRATIVO' }), papel)
    assert(renderRejeicaoFromPayload(payloadAdmin, 'https://x').html.includes('Administrativo'), `[${papel}] domínio Administrativo aparece no e-mail`)

    const payloadSem = construirPayloadRejeicao(inputBase({ notebooksComDominio: false, tipoDominio: null }), papel)
    const rendaSem = renderRejeicaoFromPayload(payloadSem, 'https://x')
    assert(rendaSem.text.includes('Domínio: Não'), `[${papel}] domínio=false mostra "Domínio: Não"`)

    // --- M) sem Notebook → linha omitida -----------------------------------------------
    const payloadSemNotebook = construirPayloadRejeicao(inputBase({ itensPatrimonio: [], notebooksComDominio: null, tipoDominio: null }), papel)
    const rendaSemNotebook = renderRejeicaoFromPayload(payloadSemNotebook, 'https://x')
    assert(!rendaSemNotebook.html.includes('>Domínio<') && !rendaSemNotebook.text.includes('Domínio:'), `[${papel}] sem Notebook (domínio=null) não exibe nenhuma linha de domínio`)
  }

  // --- reserva interna também pode ser rejeitada pelo Patrimônio (ambiente, não atividade) ---
  {
    const payload = construirPayloadRejeicao(
      inputBase({ tipoEmprestimo: 'interno', ambiente: 'Laboratório 2', atividadeExterna: null, local: null, cidade: null }),
      'patrimonio'
    )
    const { html, text } = renderRejeicaoFromPayload(payload, 'https://x')
    assert(html.includes('Laboratório 2') && text.includes('Laboratório 2'), 'reserva interna rejeitada pelo Patrimônio mostra Ambiente (não Atividade/Local/Cidade)', { html })
  }

  // --- payload malformado → erro controlado -------------------------------------------
  assertLanca(() => parseRejeicaoPayload(null), 'payload null lança RejeicaoPayloadError')
  assertLanca(() => parseRejeicaoPayload(undefined), 'payload undefined lança RejeicaoPayloadError')
  {
    const base = construirPayloadRejeicao(inputBase(), 'gestor') as unknown as Record<string, unknown>
    assertLanca(() => parseRejeicaoPayload({ ...base, versao: 2 }), 'versao !== 1 lança erro')
    assertLanca(() => parseRejeicaoPayload({ ...base, papel: 'admin' }), 'papel inválido lança erro')
    assertLanca(() => parseRejeicaoPayload({ ...base, motivo: '' }), 'motivo vazio lança erro')
    assertLanca(() => parseRejeicaoPayload({ ...base, tipoDominio: 'OUTRO' }), 'tipoDominio malformado lança erro')
  }

  // --- link/APP_URL nunca entra no payload ------------------------------------------
  {
    const payload = construirPayloadRejeicao(inputBase(), 'gestor') as unknown as Record<string, unknown>
    assert(!('link' in payload), 'payload não contém link/APP_URL', Object.keys(payload))
  }

  // --- escaping ------------------------------------------------------------------------
  {
    const motivoPerigoso = '<script>alert(1)</script>'
    const payload = construirPayloadRejeicao(inputBase({ motivo: motivoPerigoso }), 'gestor')
    const { html, text } = renderRejeicaoFromPayload(payload, 'https://x')
    assert(!html.includes('<script>alert(1)</script>'), 'HTML renderizado não contém a tag <script> crua no motivo', html)
    assert(html.includes('&lt;script&gt;'), 'HTML renderizado contém a versão escapada do motivo perigoso', html)
    assert(text.includes(motivoPerigoso), 'texto puro preserva o motivo original sem necessidade de escape', text)
  }

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) de payload de rejeição falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes de payload de rejeição (REJEICAO_GESTOR/REJEICAO_PATRIMONIO) passaram. Nenhum e-mail real foi enviado, nenhum banco real foi acessado.')
}

main().catch((err) => {
  console.error('Falha inesperada ao executar os testes de payload de rejeição:', err instanceof Error ? err.message : err)
  process.exit(1)
})
