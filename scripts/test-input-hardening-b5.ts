// scripts/test-input-hardening-b5.ts
//
// Etapa security/input-hardening-b5 — saída/erros.
//
//   Parte 1 (A-E): `escapeHtml` (src/lib/email/html.ts) em isolamento — os 5
//     caracteres HTML-sensíveis (& < > " ') e uma sanidade de texto comum
//     (acentos/pontuação) permanecendo intacto.
//   Parte 2 (F-H): templates de e-mail REAIS (não uma reimplementação) —
//     confirma que campos controlados pelo usuário (nome do solicitante,
//     motivo de rejeição, observações) chegam ESCAPADOS no HTML final,
//     mesmo contendo uma tentativa de HTML injection (`<script>`, `"`,
//     `onerror=`) — nunca no texto puro (`renderEmailLayoutText`), que não
//     interpreta HTML e por isso nunca precisa escapar.
//   Parte 3 (I): nenhum `dangerouslySetInnerHTML` em todo `src/` (grep
//     estrutural, não amostral) — sanidade de que a ausência documentada
//     continua verdadeira.
//
// Não abre conexão real com banco/e-mail — só chama funções puras de
// template (recebem dados e devolvem string; nenhuma delas toca Prisma/
// rede).
//
// Executar com: npm run test:input-hardening-b5

import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

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

function listarArquivosFonte(dir: string): string[] {
  const arquivos: string[] = []
  for (const entrada of readdirSync(dir)) {
    const caminho = join(dir, entrada)
    const info = statSync(caminho)
    if (info.isDirectory()) {
      arquivos.push(...listarArquivosFonte(caminho))
    } else if (/\.(ts|tsx)$/.test(entrada)) {
      arquivos.push(caminho)
    }
  }
  return arquivos
}

async function main() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { escapeHtml } = require('../src/lib/email/html')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { renderRejeicaoEmail } = require('../src/lib/email/templates/rejeicao')

  // ===========================================================================
  // Parte 1 — escapeHtml em isolamento (A-E)
  // ===========================================================================

  assert(escapeHtml('&') === '&amp;', 'A) "&" é escapado para "&amp;"', escapeHtml('&'))
  assert(escapeHtml('<') === '&lt;', 'B) "<" é escapado para "&lt;"', escapeHtml('<'))
  assert(escapeHtml('>') === '&gt;', 'C) ">" é escapado para "&gt;"', escapeHtml('>'))
  assert(escapeHtml('"') === '&quot;', 'D) \'"\' é escapado para "&quot;"', escapeHtml('"'))
  assert(escapeHtml("'") === '&#39;', "E) \"'\" é escapado para \"&#39;\"", escapeHtml("'"))
  assert(
    escapeHtml('Solicitação nº 42 — João D\'Ávila') === 'Solicitação nº 42 — João D&#39;Ávila',
    'Sanidade) texto comum (acentos/travessão) só escapa o caractere sensível, resto intacto',
    escapeHtml("Solicitação nº 42 — João D'Ávila")
  )
  assert(
    escapeHtml('<script>alert(1)</script>') === '&lt;script&gt;alert(1)&lt;/script&gt;',
    'Sanidade) payload de script é neutralizado por completo',
    escapeHtml('<script>alert(1)</script>')
  )

  // ===========================================================================
  // Parte 2 — templates de e-mail REAIS escapam campos do usuário (F-H)
  // ===========================================================================

  const payloadMalicioso = '<img src=x onerror=alert(1)>"><svg/onload=alert(2)>'

  const inputBase = {
    papel: 'gestor' as const,
    numero: 999,
    nomeSolicitante: payloadMalicioso,
    tipoEmprestimo: 'externo' as const,
    data: new Date('2026-09-01T00:00:00.000Z'),
    periodos: ['MANHA'] as const,
    ambiente: null,
    finalidade: payloadMalicioso,
    atividadeExterna: null,
    local: null,
    cidade: null,
    observacoes: payloadMalicioso,
    itensPatrimonio: [],
    itensPapelaria: [],
    itensServico: [],
    notebooksComDominio: null,
    tipoDominio: null,
    motivo: payloadMalicioso,
    link: 'https://exemplo.com.br/solicitacoes/1',
    bannerDestinatarioOriginal: null,
  }

  const resultado = renderRejeicaoEmail(inputBase)

  // --- F) HTML final não contém o payload cru (nome do solicitante) --------
  assert(!resultado.html.includes(payloadMalicioso), 'F) HTML do e-mail não contém o payload cru (não escapado)', resultado.html)

  // --- G) HTML final contém a versão escapada em todos os campos afetados --
  const escapado = payloadMalicioso.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  const ocorrencias = resultado.html.split(escapado).length - 1
  // nomeSolicitante, finalidade, observacoes, motivo — 4 campos usam o MESMO
  // payload malicioso neste fixture.
  assert(ocorrencias === 4, 'G) versão escapada aparece nos 4 campos afetados (nome/finalidade/observações/motivo)', {
    ocorrencias,
    trecho: resultado.html.slice(0, 400),
  })

  // --- H) texto puro preserva o conteúdo original (sem HTML, nada a escapar)
  assert(resultado.text.includes(payloadMalicioso), 'H) versão texto puro preserva o conteúdo original (não é HTML)', resultado.text)

  // ===========================================================================
  // Parte 3 — nenhum dangerouslySetInnerHTML em src/ (I)
  // ===========================================================================

  const srcDir = join(__dirname, '..', 'src')
  const arquivosComDangerously = listarArquivosFonte(srcDir).filter((caminho) => readFileSync(caminho, 'utf8').includes('dangerouslySetInnerHTML'))
  assert(arquivosComDangerously.length === 0, 'I) nenhum arquivo em src/ usa dangerouslySetInnerHTML', arquivosComDangerously)

  console.log('')
  if (failures > 0) {
    console.error(`${failures} verificação(ões) falharam.`)
    process.exit(1)
  } else {
    console.log('Todas as verificações passaram.')
  }
}

main().catch((e) => {
  console.error('Erro inesperado ao rodar os testes:', e)
  process.exit(1)
})
