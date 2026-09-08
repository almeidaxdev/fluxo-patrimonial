// scripts/test-email-reserva-confirmada.ts
//
// Teste manual (mesmo padrão de scripts/test-email-config.ts) do template
// de RESERVA_CONFIRMADA (Etapa D.3.2) — src/lib/email/templates/reserva-confirmada.ts.
//
// Testa SOMENTE o template como função pura (subject/html/text a partir de
// um input) — nenhuma rota, dispatcher ou EmailEvento está envolvido nesta
// rodada. Não abre conexão com o banco nem envia e-mail real.
//
// Executar com: npm run test:email-reserva-confirmada

import { renderReservaConfirmadaEmail } from '../src/lib/email/templates/reserva-confirmada'
import type { ReservaConfirmadaTemplateInput } from '../src/lib/email/templates/reserva-confirmada'
import { formatDataCivil } from '@/utils'

let failures = 0

function assert(condition: boolean, label: string, detalhe?: unknown) {
  if (condition) {
    console.log(`OK   - ${label}`)
  } else {
    failures++
    console.error(`FALHA - ${label}${detalhe !== undefined ? ` (${JSON.stringify(detalhe)})` : ''}`)
  }
}

const LINK = 'http://localhost:3000/solicitacoes/sol-1'
const DATA_FIXTURE = new Date('2026-08-20T00:00:00.000Z')
// Etapa D.3.FOLLOW-UP (data civil/timezone): o template agora formata
// input.data (data civil da reserva, @db.Date) via formatDataCivil(), não
// mais formatDate() — formatDataCivil() é imune ao timezone do processo
// por construção (ver src/utils/index.ts), então calculá-la aqui (em vez
// de fixar como string) só garante consistência de formato, não é mais
// necessário para proteger contra fuso da máquina que executa o teste.
const DATA_FORMATADA = formatDataCivil(DATA_FIXTURE)

function baseInput(overrides: Partial<ReservaConfirmadaTemplateInput> = {}): ReservaConfirmadaTemplateInput {
  return {
    papel: 'solicitante',
    tipoEmprestimo: 'interno',
    numero: 55,
    nomeSolicitante: 'Fulano de Tal',
    data: DATA_FIXTURE,
    periodos: ['MANHA', 'TARDE'],
    ambiente: 'Sala 101',
    finalidade: 'Aula prática',
    atividadeExterna: null,
    local: null,
    cidade: null,
    observacoes: 'Levar cabo HDMI',
    itensPatrimonio: [{ numero: 'PAT-1', marca: 'HP', modelo: 'ProBook 440', categoria: 'Notebook' }],
    itensPapelaria: [{ descricao: 'Caneta', quantidade: 10 }],
    itensServico: [{ tipoServicoNome: 'Suporte técnico', quantidade: 2, ambiente: 'Auditório' }],
    notebooksComDominio: null,
    tipoDominio: null,
    assinaturaConfirmadaEm: null,
    link: LINK,
    bannerDestinatarioOriginal: null,
    ...overrides,
  }
}

const inputExterno: Partial<ReservaConfirmadaTemplateInput> = {
  tipoEmprestimo: 'externo',
  ambiente: null,
  finalidade: null,
  atividadeExterna: 'Feira de tecnologia',
  local: 'Expo Center',
  cidade: 'São Paulo',
  observacoes: null,
  assinaturaConfirmadaEm: new Date('2026-08-21T14:30:00.000Z'),
}

async function main() {
  // --- A) Interno / Solicitante ---------------------------------------------
  {
    const { subject, html, text } = renderReservaConfirmadaEmail(baseInput({ papel: 'solicitante' }))
    assert(subject === '[Fluxo Patrimonial] Sua reserva foi confirmada — #55', 'A) assunto correto', subject)
    assert(
      html.includes('Sua reserva foi confirmada pelo Patrimônio.') && text.includes('Sua reserva foi confirmada pelo Patrimônio.'),
      'A) contém "foi confirmada pelo Patrimônio"'
    )
  }

  // --- B) Interno / Patrimônio -----------------------------------------------
  {
    const { subject, html } = renderReservaConfirmadaEmail(baseInput({ papel: 'patrimonio' }))
    assert(subject.includes('Fulano de Tal'), 'B) assunto inclui o nome do solicitante', subject)
    assert(
      html.includes('A reserva de Fulano de Tal foi confirmada.'),
      'B) frase de abertura correta para Patrimônio/interno'
    )
    assert(
      html.includes('Notebook') && html.includes('Caneta') && html.includes('Suporte técnico'),
      'B) conteúdo operacional presente (itens, papelaria, serviços)'
    )
  }

  // --- C) Externo / Solicitante ----------------------------------------------
  {
    const { html, text } = renderReservaConfirmadaEmail(baseInput({ papel: 'solicitante', ...inputExterno }))
    assert(
      html.includes('após a conclusão da etapa de assinatura') && text.includes('após a conclusão da etapa de assinatura'),
      'C) menciona a conclusão da etapa de assinatura'
    )
  }

  // --- D) Externo / Patrimônio -----------------------------------------------
  {
    const { html, text } = renderReservaConfirmadaEmail(baseInput({ papel: 'patrimonio', ...inputExterno }))
    assert(
      html.includes('A reserva externa de Fulano de Tal foi confirmada após a conclusão da etapa de assinatura.'),
      'D) frase de abertura correta para Patrimônio/externo'
    )
    assert(html.includes('Expo Center') && html.includes('São Paulo') && html.includes('Feira de tecnologia'), 'D) dados externos presentes (local, cidade, atividade)')
    assert(
      html.includes('Assinatura confirmada em') && text.includes('Assinatura confirmada em'),
      'D) assinatura confirmada é mencionada'
    )
  }

  // --- E) Assunto do Patrimônio contém "Reserva confirmada", número e nome ---
  {
    const { subject } = renderReservaConfirmadaEmail(baseInput({ papel: 'patrimonio' }))
    assert(
      subject.includes('Reserva confirmada') && subject.includes('#55') && subject.includes('Fulano de Tal'),
      'E) assunto do Patrimônio contém "Reserva confirmada", número e nome do solicitante',
      subject
    )
  }

  // --- F) Nenhuma variante usa "está confirmada" ------------------------------
  {
    const variantes = [
      baseInput({ papel: 'solicitante' }),
      baseInput({ papel: 'patrimonio' }),
      baseInput({ papel: 'solicitante', ...inputExterno }),
      baseInput({ papel: 'patrimonio', ...inputExterno }),
    ]
    let algumaContem = false
    for (const variante of variantes) {
      const { subject, html, text } = renderReservaConfirmadaEmail(variante)
      if (subject.includes('está confirmada') || html.includes('está confirmada') || text.includes('está confirmada')) {
        algumaContem = true
      }
    }
    assert(!algumaContem, 'F) nenhuma variante (assunto/html/texto) usa "está confirmada"')
  }

  // --- G) Itens patrimoniais aparecem corretamente ----------------------------
  {
    const { html, text } = renderReservaConfirmadaEmail(baseInput())
    assert(html.includes('Notebook') && html.includes('HP ProBook 440') && html.includes('Patrimônio: PAT-1'), 'G) item patrimonial aparece com categoria, marca/modelo e número (HTML)')
    assert(text.includes('HP ProBook 440') && text.includes('PAT-1'), 'G) item patrimonial aparece no texto puro')
  }

  // --- H) Papelaria aparece corretamente ---------------------------------------
  {
    const { html, text } = renderReservaConfirmadaEmail(baseInput())
    assert(html.includes('Caneta (10x)'), 'H) papelaria aparece com descrição e quantidade (HTML)')
    assert(text.includes('Caneta (10x)'), 'H) papelaria aparece no texto puro')
    assert(!html.includes('Patrimônio: Caneta'), 'H) papelaria não é tratada como item patrimonial')
  }

  // --- I) Serviços aparecem corretamente ---------------------------------------
  {
    const { html, text } = renderReservaConfirmadaEmail(baseInput())
    assert(html.includes('Suporte técnico (2x)') && html.includes('Ambiente: Auditório'), 'I) serviço aparece com tipo, quantidade e ambiente (HTML)')
    assert(text.includes('Suporte técnico') && text.includes('Auditório'), 'I) serviço aparece no texto puro')
  }

  // --- J) Observações aparecem quando existem -----------------------------------
  {
    const { html, text } = renderReservaConfirmadaEmail(baseInput({ observacoes: 'Levar cabo HDMI' }))
    assert(html.includes('Levar cabo HDMI'), 'J) observações aparecem no HTML quando presentes')
    assert(text.includes('Levar cabo HDMI'), 'J) observações aparecem no texto quando presentes')
  }

  // --- K) Campos opcionais ausentes não geram undefined/null/lixo ---------------
  {
    const input = baseInput({
      ambiente: null,
      finalidade: null,
      atividadeExterna: null,
      local: null,
      cidade: null,
      observacoes: null,
      itensPatrimonio: [],
      itensPapelaria: [],
      itensServico: [],
      assinaturaConfirmadaEm: null,
    })
    const { html, text } = renderReservaConfirmadaEmail(input)
    assert(!html.includes('undefined') && !html.includes('null'), 'K) HTML não contém "undefined"/"null" com campos ausentes', html)
    assert(!text.includes('undefined') && !text.includes('null'), 'K) texto não contém "undefined"/"null" com campos ausentes', text)
    assert(!html.includes('Observações'), 'K) bloco de observações omitido quando ausente')
    assert(!html.includes('Ambiente') && !html.includes('Local') && !html.includes('Cidade'), 'K) linhas de resumo condicionais omitidas quando ausentes')
  }

  // --- L) Caracteres especiais/HTML em dados do usuário são escapados -----------
  {
    const nomePerigoso = `O'Brien & <script>alert(1)</script>`
    const { html, text } = renderReservaConfirmadaEmail(
      baseInput({ nomeSolicitante: nomePerigoso, observacoes: '<b>teste</b> & "aspas"' })
    )
    assert(!html.includes('<script>'), 'L) HTML não contém a tag <script> crua (nome escapado)', html)
    assert(html.includes('&lt;script&gt;'), 'L) HTML contém a versão escapada do nome perigoso')
    assert(!html.includes('<b>teste</b>'), 'L) observações com HTML não são injetadas cruas')
    assert(html.includes('&lt;b&gt;teste&lt;/b&gt;'), 'L) observações aparecem escapadas no HTML')
    // Texto puro nunca é interpretado como HTML por um cliente de e-mail —
    // não precisa (nem deve) ser escapado; só confere que o dado passou.
    assert(text.includes(nomePerigoso), 'L) texto puro preserva o dado original sem necessidade de escape')
  }

  // --- M) HTML e texto puro possuem informações essenciais -----------------------
  {
    const { html, text } = renderReservaConfirmadaEmail(baseInput())
    for (const [nome, corpo] of [['HTML', html], ['texto', text]] as const) {
      assert(corpo.includes('55'), `M) ${nome} contém o número da solicitação`, corpo.slice(0, 50))
      assert(corpo.includes('Fulano de Tal'), `M) ${nome} contém o nome do solicitante`)
      assert(corpo.includes(DATA_FORMATADA), `M) ${nome} contém a data formatada`)
      assert(corpo.includes(LINK), `M) ${nome} contém o link da solicitação`)
    }
  }

  // --- N) Botão/link aponta para a URL fornecida ----------------------------------
  {
    const { html, text } = renderReservaConfirmadaEmail(baseInput())
    assert(html.includes(`href="${LINK}"`), 'N) botão HTML aponta para o link fornecido')
    assert(text.includes(`Ver solicitação: ${LINK}`), 'N) link textual aparece no texto puro')
  }

  // --- O) Banner de teste continua funcionando pelo layout existente --------------
  {
    const { html, text } = renderReservaConfirmadaEmail(baseInput({ bannerDestinatarioOriginal: 'original@example.com' }))
    assert(html.includes('AMBIENTE DE TESTE') && html.includes('original@example.com'), 'O) banner de teste aparece no HTML')
    assert(text.includes('AMBIENTE DE TESTE') && text.includes('original@example.com'), 'O) banner de teste aparece no texto puro')
  }
  {
    const { html } = renderReservaConfirmadaEmail(baseInput({ bannerDestinatarioOriginal: null }))
    assert(!html.includes('AMBIENTE DE TESTE'), 'O) banner de teste ausente quando bannerDestinatarioOriginal é null')
  }

  console.log('')
  if (failures > 0) {
    console.error(`${failures} teste(s) do template de reserva-confirmada falharam.`)
    process.exit(1)
  }
  console.log('Todos os testes do template de reserva-confirmada passaram. Nenhum e-mail real foi enviado.')
}

main().catch((err) => {
  console.error('Falha inesperada ao executar os testes do template de reserva-confirmada:', err instanceof Error ? err.message : err)
  process.exit(1)
})
