// scripts/test-email-data-civil.ts
//
// Etapa D.3.FOLLOW-UP (data civil/timezone) — Etapa 2: prova que os três
// templates de e-mail (RESERVA_CONFIRMADA, PRONTA_RETIRADA, NAO_RETIRADA)
// agora renderizam a DATA DA RESERVA (Solicitacao.data, @db.Date) via
// formatDataCivil() — nunca voltando a exibir o dia ANTERIOR ao
// armazenado, reprodução direta do bug observado na homologação da D.3
// (#21: 2026-08-24T00:00:00.000Z, #22: 2026-08-25T00:00:00.000Z).
//
// Não testa formatDate()/formatDateTime() em si (ver test-data-civil.ts
// para o helper isolado) — este arquivo testa os TEMPLATES de e-mail de
// ponta a ponta (input → subject/html/text), incluindo o caminho completo
// do payload histórico de RESERVA_CONFIRMADA (parse → render), sem alterar
// versao/parser/builder/estrutura JSON do payload V1.
//
// Timezone (item 5 do pedido): a suíte principal roda com o TZ ATUAL do
// processo (nesta máquina, America/Sao_Paulo — onde o bug original foi
// observado); adicionalmente, um subconjunto representativo (um caso por
// template) é reexecutado em um SUBPROCESSO isolado com TZ=UTC, para provar
// que o resultado não muda entre os dois ambientes — sem duplicar toda a
// matriz de timezones já coberta por test:data-civil.
//
// Executar com: npm run test:email-data-civil

import { execFileSync } from 'child_process'
import { renderReservaConfirmadaEmail } from '../src/lib/email/templates/reserva-confirmada'
import { renderProntaRetiradaEmail } from '../src/lib/email/templates/pronta-retirada'
import { renderNaoRetiradaEmail } from '../src/lib/email/templates/nao-retirada'
import { construirPayloadReservaConfirmada, parseReservaConfirmadaPayload, renderReservaConfirmadaFromPayload } from '../src/lib/email/payloads/reserva-confirmada'

// --- Modo worker: renderiza os 3 templates para um `dataIso` recebido via
// argv e imprime o HTML de cada um em JSON — usado só pela checagem de
// timezone abaixo, para reaproveitar a implementação real (nunca uma cópia
// simplificada) rodando num processo com TZ diferente.
if (process.argv[2] === '--worker') {
  const dataIso: string = process.argv[3]
  const data = new Date(dataIso)
  const resultado = {
    reservaConfirmada: renderReservaConfirmadaEmail({
      papel: 'solicitante',
      tipoEmprestimo: 'interno',
      numero: 1,
      nomeSolicitante: 'Fulano',
      data,
      periodos: ['MANHA'],
      ambiente: null,
      finalidade: null,
      atividadeExterna: null,
      local: null,
      cidade: null,
      observacoes: null,
      itensPatrimonio: [],
      itensPapelaria: [],
      itensServico: [],
      notebooksComDominio: null,
      tipoDominio: null,
      assinaturaConfirmadaEm: null,
      link: 'https://app.example.com/x',
      bannerDestinatarioOriginal: null,
    }).html,
    prontaRetirada: renderProntaRetiradaEmail({
      nomeSolicitante: 'Fulano',
      numero: 1,
      data,
      periodos: ['MANHA'],
      itensPatrimonio: [],
      itensPapelaria: [],
      link: 'https://app.example.com/x',
      bannerDestinatarioOriginal: null,
    }).html,
    naoRetirada: renderNaoRetiradaEmail({
      nomeSolicitante: 'Fulano',
      numero: 1,
      data,
      periodos: ['MANHA'],
      naoRetiradaEm: new Date('2026-08-20T15:00:00.000Z'),
      link: 'https://app.example.com/x',
      bannerDestinatarioOriginal: null,
    }).html,
  }
  process.stdout.write(JSON.stringify(resultado))
  process.exit(0)
}

let failures = 0

function assert(condition: boolean, label: string, detalhe?: unknown) {
  if (condition) {
    console.log(`OK   - ${label}`)
  } else {
    failures++
    console.error(`FALHA - ${label}${detalhe !== undefined ? ` (${JSON.stringify(detalhe)})` : ''}`)
  }
}

function main() {
  // =========================================================================
  // RESERVA_CONFIRMADA — direto no template (input.data já como Date)
  // =========================================================================
  {
    const { html, text } = renderReservaConfirmadaEmail({
      papel: 'solicitante',
      tipoEmprestimo: 'interno',
      numero: 21,
      nomeSolicitante: 'Fulano',
      data: new Date('2026-08-24T00:00:00.000Z'),
      periodos: ['MANHA'],
      ambiente: 'Sala 22',
      finalidade: null,
      atividadeExterna: null,
      local: null,
      cidade: null,
      observacoes: null,
      itensPatrimonio: [],
      itensPapelaria: [],
      itensServico: [],
      notebooksComDominio: null,
      tipoDominio: null,
      assinaturaConfirmadaEm: null,
      link: 'https://app.example.com/x',
      bannerDestinatarioOriginal: null,
    })
    assert(html.includes('24/08/2026'), 'RESERVA_CONFIRMADA (#21, template direto) HTML contém 24/08/2026', html)
    assert(!html.includes('23/08/2026'), 'RESERVA_CONFIRMADA (#21, template direto) HTML NÃO contém 23/08/2026 (regressão do bug)', html)
    assert(text.includes('24/08/2026'), 'RESERVA_CONFIRMADA (#21, template direto) texto puro contém 24/08/2026', text)
  }
  {
    const { html } = renderReservaConfirmadaEmail({
      papel: 'patrimonio',
      tipoEmprestimo: 'externo',
      numero: 22,
      nomeSolicitante: 'Ciclana',
      data: new Date('2026-08-25T00:00:00.000Z'),
      periodos: ['TARDE'],
      ambiente: null,
      finalidade: null,
      atividadeExterna: 'Feira',
      local: 'Centro',
      cidade: 'SP',
      observacoes: null,
      itensPatrimonio: [],
      itensPapelaria: [],
      itensServico: [],
      notebooksComDominio: null,
      tipoDominio: null,
      assinaturaConfirmadaEm: new Date('2026-08-21T19:48:43.660Z'), // instante real — deve continuar em horário local, não é o alvo deste teste
      link: 'https://app.example.com/x',
      bannerDestinatarioOriginal: null,
    })
    assert(html.includes('25/08/2026'), 'RESERVA_CONFIRMADA (#22, template direto) HTML contém 25/08/2026', html)
    assert(!html.includes('24/08/2026'), 'RESERVA_CONFIRMADA (#22, template direto) HTML NÃO contém 24/08/2026 (regressão do bug)', html)
  }

  // =========================================================================
  // RESERVA_CONFIRMADA — caminho completo do payload histórico (item 3):
  // builder → JSON (round-trip) → parser → render. payload V1 (versao,
  // dataIso, estrutura) NÃO é alterado nesta etapa — só a RENDERIZAÇÃO a
  // partir dele passa a usar formatDataCivil().
  // =========================================================================
  {
    const payload = construirPayloadReservaConfirmada(
      {
        numero: 21,
        nomeSolicitante: 'Fulano',
        tipoEmprestimo: 'interno',
        data: new Date('2026-08-24T00:00:00.000Z'),
        periodos: ['MANHA'],
        ambiente: 'Sala 22',
        finalidade: null,
        atividadeExterna: null,
        local: null,
        cidade: null,
        observacoes: null,
        itensPatrimonio: [],
        itensPapelaria: [],
        itensServico: [],
        notebooksComDominio: null,
        tipoDominio: null,
        assinaturaConfirmadaEm: null,
      },
      'solicitante'
    )
    assert(payload.versao === 1, 'Payload continua versao=1 (inalterado)', payload.versao)
    assert(payload.dataIso === '2026-08-24T00:00:00.000Z', 'Payload continua guardando dataIso como ISO completo (formato V1 inalterado)', payload.dataIso)

    // round-trip via JSON, como o dispatcher/rota fariam ao ler de volta do Postgres (Json)
    const bruto: unknown = JSON.parse(JSON.stringify(payload))
    const payloadParseado = parseReservaConfirmadaPayload(bruto)
    const { html, text } = renderReservaConfirmadaFromPayload(payloadParseado, 'https://app.example.com/x')

    assert(html.includes('24/08/2026'), 'RESERVA_CONFIRMADA (#21, via payload histórico completo) HTML contém 24/08/2026', html)
    assert(!html.includes('23/08/2026'), 'RESERVA_CONFIRMADA (#21, via payload histórico completo) HTML NÃO contém 23/08/2026', html)
    assert(text.includes('24/08/2026'), 'RESERVA_CONFIRMADA (#21, via payload histórico completo) texto puro contém 24/08/2026', text)
  }

  // =========================================================================
  // PRONTA_RETIRADA
  // =========================================================================
  {
    const { html, text } = renderProntaRetiradaEmail({
      nomeSolicitante: 'Fulano',
      numero: 21,
      data: new Date('2026-08-24T00:00:00.000Z'),
      periodos: ['MANHA'],
      itensPatrimonio: [],
      itensPapelaria: [],
      link: 'https://app.example.com/x',
      bannerDestinatarioOriginal: null,
    })
    assert(html.includes('24/08/2026'), 'PRONTA_RETIRADA HTML contém 24/08/2026', html)
    assert(!html.includes('23/08/2026'), 'PRONTA_RETIRADA HTML NÃO contém 23/08/2026 (regressão do bug)', html)
    assert(text.includes('24/08/2026'), 'PRONTA_RETIRADA texto puro contém 24/08/2026', text)
  }

  // =========================================================================
  // NAO_RETIRADA — data da reserva (civil) e naoRetiradaEm (instante real,
  // continua em horário local — não é regressão testar que ele muda de
  // representação, só provamos que a DATA CIVIL está correta).
  // =========================================================================
  {
    const { html, text } = renderNaoRetiradaEmail({
      nomeSolicitante: 'Fulano',
      numero: 22,
      data: new Date('2026-08-25T00:00:00.000Z'),
      periodos: ['TARDE'],
      naoRetiradaEm: new Date('2026-08-26T15:00:00.000Z'),
      link: 'https://app.example.com/x',
      bannerDestinatarioOriginal: null,
    })
    assert(html.includes('25/08/2026'), 'NAO_RETIRADA HTML contém 25/08/2026 (data prevista)', html)
    assert(!html.includes('24/08/2026'), 'NAO_RETIRADA HTML NÃO contém 24/08/2026 (regressão do bug)', html)
    assert(text.includes('25/08/2026'), 'NAO_RETIRADA texto puro contém 25/08/2026', text)
  }

  // =========================================================================
  // Timezone (item 5) — mesmo `dataIso`, mesmo template, comparando o
  // processo ATUAL (America/Sao_Paulo nesta máquina) contra um subprocesso
  // isolado com TZ=UTC. O HTML deve conter a MESMA data civil nos dois.
  // =========================================================================
  const TS_NODE_BIN = require.resolve('ts-node/dist/bin.js')
  function renderizarEmTimezone(tz: string, dataIso: string): { reservaConfirmada: string; prontaRetirada: string; naoRetirada: string } {
    const saida = execFileSync(process.execPath, [TS_NODE_BIN, '--project', 'scripts/tsconfig.json', '-r', 'tsconfig-paths/register', __filename, '--worker', dataIso], {
      env: { ...process.env, TZ: tz },
      encoding: 'utf-8',
    })
    return JSON.parse(saida)
  }

  for (const dataIso of ['2026-08-24T00:00:00.000Z', '2026-08-25T00:00:00.000Z']) {
    const emUTC = renderizarEmTimezone('UTC', dataIso)
    const emSaoPaulo = renderizarEmTimezone('America/Sao_Paulo', dataIso)
    const diaCivilEsperado = dataIso.slice(8, 10) + '/' + dataIso.slice(5, 7) + '/' + dataIso.slice(0, 4)

    for (const tipo of ['reservaConfirmada', 'prontaRetirada', 'naoRetirada'] as const) {
      assert(
        emUTC[tipo].includes(diaCivilEsperado) && emSaoPaulo[tipo].includes(diaCivilEsperado),
        `[timezone] ${tipo} (${dataIso}) contém "${diaCivilEsperado}" tanto em UTC quanto em America/Sao_Paulo`,
        { UTCContemEsperado: emUTC[tipo].includes(diaCivilEsperado), SaoPauloContemEsperado: emSaoPaulo[tipo].includes(diaCivilEsperado) }
      )
    }
  }

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) de data civil nos templates de e-mail falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes de data civil nos templates de e-mail passaram (RESERVA_CONFIRMADA, PRONTA_RETIRADA, NAO_RETIRADA — UTC e America/Sao_Paulo idênticos).')
}

main()
