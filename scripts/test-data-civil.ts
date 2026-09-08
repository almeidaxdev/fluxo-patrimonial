// scripts/test-data-civil.ts
//
// Etapa D.3.FOLLOW-UP (data civil/timezone) — teste dedicado e ISOLADO de
// formatDataCivil() (src/utils/index.ts). Não testa formatDate/
// formatDateTime (inalterados nesta rodada) e não exercita nenhum
// call-site da aplicação (templates de e-mail, páginas do dashboard,
// relatórios) — só a função pura em si.
//
// O objetivo central desta suíte é prevar que formatDataCivil() é
// IMUNE ao timezone do processo que a executa — a causa raiz do bug
// observado na homologação (formatDate() usando getters locais de Date,
// que em America/Sao_Paulo — UTC-3 — pode devolver o dia ANTERIOR ao
// realmente armazenado num campo `@db.Date`).
//
// Como provamos isso sem alterar process.env.TZ da suíte principal: os
// casos sensíveis a timezone rodam em SUBPROCESSOS isolados (via
// execFileSync, cada um com seu próprio TZ no `env`), nunca mutando o TZ
// deste processo. Quando chamado com `--worker <jsonCasos>`, este mesmo
// arquivo roda em modo "worker": aplica formatDataCivil() a cada caso no
// TZ do subprocesso e imprime os resultados em JSON no stdout — é assim
// que o processo principal consegue comparar UTC × America/Sao_Paulo ×
// Asia/Tokyo sem duplicar a implementação em outro lugar.
//
// Executar com: npm run test:data-civil

import { execFileSync } from 'child_process'
import { formatDataCivil } from '../src/utils'

type CasoBruto = { kind: 'string'; value: string } | { kind: 'date'; value: string }
type ResultadoCaso = { ok: true; valor: string } | { ok: false; erro: string }

// --- Modo worker -------------------------------------------------------

if (process.argv[2] === '--worker') {
  const casos: CasoBruto[] = JSON.parse(process.argv[3])
  const resultados: ResultadoCaso[] = casos.map((caso) => {
    try {
      const input = caso.kind === 'string' ? caso.value : new Date(caso.value)
      return { ok: true, valor: formatDataCivil(input) }
    } catch (err) {
      return { ok: false, erro: err instanceof Error ? err.message : String(err) }
    }
  })
  process.stdout.write(JSON.stringify(resultados))
  process.exit(0)
}

// --- Modo suíte principal -----------------------------------------------

let failures = 0

function assert(condition: boolean, label: string, detalhe?: unknown) {
  if (condition) {
    console.log(`OK   - ${label}`)
  } else {
    failures++
    console.error(`FALHA - ${label}${detalhe !== undefined ? ` (${JSON.stringify(detalhe)})` : ''}`)
  }
}

/**
 * Roda os `casos` em um SUBPROCESSO isolado, com `TZ=tz` só no env desse
 * subprocesso — o processo principal (e o resto da suíte) nunca tem seu
 * TZ alterado. Usa o próprio arquivo (`--worker`) como script, via
 * ts-node, para reaproveitar a implementação real de formatDataCivil()
 * (nunca uma cópia/reimplementação simplificada só para o teste).
 */
// Resolvido via require.resolve (não `npx ts-node` por um shell) —
// invocando `process.execPath` (o próprio node) + o entrypoint do ts-node
// diretamente, com a lista de argumentos como array (nunca uma string
// concatenada), evitamos por completo os problemas de quoting do
// cmd.exe/PowerShell no Windows com espaços no caminho do projeto (ex.:
// "C:\Users\Eduardo Alves\...") e com o JSON dos casos (que contém aspas
// e colchetes).
const TS_NODE_BIN = require.resolve('ts-node/dist/bin.js')

function rodarEmTimezone(tz: string, casos: CasoBruto[]): ResultadoCaso[] {
  const saida = execFileSync(
    process.execPath,
    [TS_NODE_BIN, '--project', 'scripts/tsconfig.json', '-r', 'tsconfig-paths/register', __filename, '--worker', JSON.stringify(casos)],
    { env: { ...process.env, TZ: tz }, encoding: 'utf-8' }
  )
  return JSON.parse(saida) as ResultadoCaso[]
}

function main() {
  // --- A-F) Casos básicos (item 6 do pedido) — no processo ATUAL, sem
  // controlar TZ explicitamente ainda (isso vem na seção de timezone
  // abaixo) — só provam a conversão correta em si.
  assert(formatDataCivil('2026-08-24') === '24/08/2026', 'A) string "YYYY-MM-DD" → 24/08/2026', formatDataCivil('2026-08-24'))
  assert(formatDataCivil('2026-08-24T00:00:00.000Z') === '24/08/2026', 'B) string ISO completo → 24/08/2026', formatDataCivil('2026-08-24T00:00:00.000Z'))
  assert(formatDataCivil(new Date('2026-08-24T00:00:00.000Z')) === '24/08/2026', 'C) Date (meia-noite UTC) → 24/08/2026', formatDataCivil(new Date('2026-08-24T00:00:00.000Z')))
  assert(formatDataCivil('2026-12-31') === '31/12/2026', 'D) virada de ano (31/12) → 31/12/2026', formatDataCivil('2026-12-31'))
  assert(formatDataCivil('2027-01-01') === '01/01/2027', 'E) virada de ano (01/01) → 01/01/2027', formatDataCivil('2027-01-01'))
  assert(formatDataCivil('2028-02-29') === '29/02/2028', 'F) 29/02 de ano bissexto → 29/02/2028', formatDataCivil('2028-02-29'))

  // --- Entrada inválida: lança, nunca devolve "NaN/NaN/NaN" nem data errada
  let lancouParaInvalida = false
  try {
    formatDataCivil('não-é-uma-data')
  } catch {
    lancouParaInvalida = true
  }
  assert(lancouParaInvalida, 'G) entrada inválida lança Error (não retorna silenciosamente uma data errada)')

  // --- H) Independência de timezone — o mesmo conjunto de casos deve
  // produzir EXATAMENTE o mesmo resultado em UTC, America/Sao_Paulo
  // (timezone real da unidade — offset negativo) e Asia/Tokyo (offset
  // positivo, prova que não é coincidência de sinal do offset).
  const casosTimezone: CasoBruto[] = [
    { kind: 'string', value: '2026-08-24' },
    { kind: 'string', value: '2026-08-24T00:00:00.000Z' },
    { kind: 'date', value: '2026-08-24T00:00:00.000Z' },
    { kind: 'string', value: '2026-12-31T00:00:00.000Z' },
    { kind: 'string', value: '2027-01-01T00:00:00.000Z' },
    // --- I) Regressão do bug real observado na homologação D.3 ---------
    { kind: 'string', value: '2026-08-24T00:00:00.000Z' }, // solicitação #21
    { kind: 'string', value: '2026-08-25T00:00:00.000Z' }, // solicitação #22
  ]
  const esperado = ['24/08/2026', '24/08/2026', '24/08/2026', '31/12/2026', '01/01/2027', '24/08/2026', '25/08/2026']

  const timezones = ['UTC', 'America/Sao_Paulo', 'Asia/Tokyo']
  const resultadosPorTimezone: Record<string, ResultadoCaso[]> = {}

  for (const tz of timezones) {
    resultadosPorTimezone[tz] = rodarEmTimezone(tz, casosTimezone)
  }

  for (const tz of timezones) {
    const resultados = resultadosPorTimezone[tz]
    resultados.forEach((resultado, i) => {
      assert(resultado.ok === true, `H) [${tz}] caso ${i} (${JSON.stringify(casosTimezone[i])}) não lançou`, resultado)
      if (resultado.ok) {
        assert(resultado.valor === esperado[i], `H) [${tz}] caso ${i} produz "${esperado[i]}"`, resultado.valor)
      }
    })
  }

  // Comparação cruzada: TODOS os timezones devem bater exatamente entre si,
  // caso a caso — não só contra o valor esperado hardcoded acima.
  for (let i = 0; i < casosTimezone.length; i++) {
    const valoresPorTz = timezones.map((tz) => {
      const r = resultadosPorTimezone[tz][i]
      return r.ok ? r.valor : `ERRO: ${r.erro}`
    })
    const todosIguais = valoresPorTz.every((v) => v === valoresPorTz[0])
    assert(todosIguais, `H) caso ${i} (${JSON.stringify(casosTimezone[i])}) produz o MESMO resultado em UTC/America/Sao_Paulo/Asia/Tokyo`, {
      UTC: valoresPorTz[0],
      'America/Sao_Paulo': valoresPorTz[1],
      'Asia/Tokyo': valoresPorTz[2],
    })
  }

  // --- I) Regressão explícita do caso real #21/#22, isolando o resultado
  // em America/Sao_Paulo especificamente — o timezone onde o bug de
  // formatDate() foi observado na homologação. Nunca pode voltar a ser
  // 23/08 ou 24/08 respectivamente.
  const emSaoPaulo = resultadosPorTimezone['America/Sao_Paulo']
  const resultadoEvt21 = emSaoPaulo[5] // índice do caso #21 em casosTimezone
  const resultadoEvt22 = emSaoPaulo[6] // índice do caso #22 em casosTimezone
  assert(resultadoEvt21.ok && resultadoEvt21.valor === '24/08/2026', 'I) #21 (2026-08-24T00:00:00.000Z) em America/Sao_Paulo → 24/08/2026 (NÃO 23/08)', resultadoEvt21)
  assert(resultadoEvt22.ok && resultadoEvt22.valor === '25/08/2026', 'I) #22 (2026-08-25T00:00:00.000Z) em America/Sao_Paulo → 25/08/2026 (NÃO 24/08)', resultadoEvt22)

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) de data civil falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes de data civil (formatDataCivil) passaram — resultado idêntico em UTC, America/Sao_Paulo e Asia/Tokyo.')
}

main()
