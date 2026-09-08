// src/lib/validations.ts
import { z } from 'zod'
import { dataCivilValida } from '@/lib/query-params'

export const periodoEnum = z.enum(['MANHA', 'TARDE', 'NOITE'])
export const tipoEmprestimoEnum = z.enum(['interno', 'externo'])
export const origemEnum = z.enum(['RESERVA', 'ATENDIMENTO_IMEDIATO'])
export const tipoDominioEnum = z.enum(['EDUCACIONAL', 'ADMINISTRATIVO'])

// Etapa security/input-hardening-b2 — Permissao/StatusSolicitacao são
// enums do Prisma (@prisma/client), mas este arquivo é importado por
// componentes CLIENT (ver comentário de `utf8ByteLength` mais abaixo) —
// nunca importar `@prisma/client` aqui (código server-only, quebraria o
// bundle do navegador). Redeclarados como `z.enum([...])`, mesmo padrão já
// usado acima para periodoEnum/tipoEmprestimoEnum/origemEnum/tipoDominioEnum
// — a lista de valores precisa continuar IGUAL ao enum Permissao/
// StatusSolicitacao em prisma/schema.prisma; nunca diverge silenciosamente
// porque um valor novo no banco simplesmente passaria a ser rejeitado aqui
// até este arquivo ser atualizado também.
export const permissaoEnum = z.enum(['colaborador', 'patrimonio', 'administrador'])
export const statusSolicitacaoEnum = z.enum([
  'AGUARDANDO_GESTOR',
  'REJEITADA_GESTOR',
  'AGUARDANDO_PATRIMONIO',
  'REJEITADA_PATRIMONIO',
  'CONFIRMADA',
  'AGUARDANDO_ENVIO_ASSINATURA',
  'AGUARDANDO_ASSINATURA',
  'ASSINATURA_CONFIRMADA',
  'EM_SEPARACAO',
  'PRONTA_RETIRADA',
  'EM_UTILIZACAO',
  'FINALIZADA',
  'CANCELADA',
  'NAO_RETIRADA',
])
// Escopo de GET /api/solicitacoes — conjunto fechado usado só como query
// param (nunca persistido); 'todas'/'gestor' continuam exigindo a checagem
// de permissão real no backend (isPatrimonioOuAdmin / gestorId da sessão),
// este enum só impede um valor arbitrário passar batido no lugar do default.
export const escopoSolicitacaoEnum = z.enum(['minhas', 'todas', 'gestor'])

// Etapa feat/admin-dashboard-operational — preset semântico de
// GET /api/solicitacoes para filtros que representam MAIS DE UM status ao
// mesmo tempo (ex.: "em andamento" — ver STATUS_EM_ANDAMENTO_SOLICITANTE em
// src/lib/status.ts, a única fonte real do conjunto). Conjunto fechado e
// pequeno de propósito: cada valor precisa ter uma definição de status
// clara e documentada — nunca um preset genérico que aceite uma combinação
// arbitrária vinda do cliente.
export const filtroSolicitacaoEnum = z.enum(['em_andamento'])

// Etapa security/input-hardening-b2 — limites máximos server-side para
// strings livres controladas pelo usuário, centralizados aqui para nunca
// repetir o mesmo número mágico em schemas diferentes. Cada valor reflete o
// uso REAL do campo (auditoria S6-A), não um teto genérico aplicado a tudo:
//   nome           — nome de pessoa (colaborador).
//   email          — RFC 5321 (endereço completo, já cobre o domínio
//                     institucional verificado à parte).
//   busca          — texto de busca/filtro (query params `busca`).
//   tituloCurto    — nome curto de cadastro administrativo (patrimônio,
//                     tipo/nome de serviço, ícone de categoria).
//   categoria      — nome de categoria de patrimônio.
//   localAmbiente  — texto de local/ambiente/cidade de uma solicitação.
//   descricaoCurta — descrição curta (categoria, finalidade, atividade
//                     externa da solicitação).
//   observacao     — observação geral (solicitação, retirada, devolução,
//                     item de serviço, patrimônio).
//   motivo         — motivo/justificativa (rejeição de gestor/Patrimônio).
//   papelaria      — texto livre de item de papelaria (pedidos como
//                     "2 cartolinas, 3 pincéis, folhas A3...").
export const LIMITES_INPUT = {
  nome: 120,
  email: 254,
  busca: 120,
  tituloCurto: 120,
  categoria: 100,
  localAmbiente: 150,
  descricaoCurta: 300,
  observacao: 1000,
  motivo: 1000,
  papelaria: 1500,
} as const

// Domínio(s) de e-mail permitido(s) para toda conta User (colaborador,
// gestor, Patrimônio, administrador) — configurável por instalação via
// ALLOWED_EMAIL_DOMAINS (uma ou mais entradas separadas por vírgula, ex.:
// "example.com,example.org"), nunca hardcoded no código. Único ponto de
// verdade: nunca reler `process.env.ALLOWED_EMAIL_DOMAINS` em outra rota —
// importar `emailPermitidoSchema` daqui sempre que um e-mail de User for
// aceito (criação OU edição).
//
// FAIL-CLOSED por decisão de segurança: se a variável não existir, estiver
// vazia, ou não sobrar nenhum domínio válido após normalização, a lista
// resultante é vazia e `emailPermitidoSchema` rejeita QUALQUER e-mail — nunca
// "libera geral" por omissão/erro de configuração. Quem quiser aceitar
// qualquer domínio precisa fazer essa escolha de forma explícita (não é o
// papel desta função decidir isso; hoje não há um valor especial "aceitar
// tudo" — omitir a variável é o inverso: bloqueia tudo).
//
// Esta função é uma leitura pura de `process.env` — sem cache — de propósito:
// os scripts de teste alteram `process.env.ALLOWED_EMAIL_DOMAINS` em tempo de
// execução (ver scripts/test-*.ts) e esperam que a próxima chamada já
// reflita o novo valor.
export function dominiosPermitidos(): string[] {
  const bruto = process.env.ALLOWED_EMAIL_DOMAINS ?? ''
  return bruto
    .split(',')
    .map((dominio) => dominio.trim().toLowerCase())
    .filter((dominio) => dominio.length > 0)
}

// Normaliza (trim + lowercase) e valida formato + domínio EXATO contra
// `dominiosPermitidos()` — nunca `.includes(dominio)` (aceitaria
// "usuario@example.com.evil.com") nem `.endsWith(dominio)` sozinho sem
// checar o restante do formato. Comparação por igualdade estrita do domínio
// inteiro após o (único) "@", já validado como e-mail bem formado pelo
// `.email()` anterior — cobre "usuario@sub.example.com" e
// "usuario@example.com.br" (subdomínio/domínio parecido, mas não igual).
// Etapa security/input-hardening-b2: `.max()` ANTES de `.email()` — RFC 5321
// já limita o endereço completo a 254 caracteres; sem isso, um e-mail
// absurdamente longo (mas com formato válido) passaria pela verificação de
// formato/domínio normalmente antes de qualquer checagem de tamanho.
//
// IMPORTANTE — uso exclusivamente SERVER-SIDE: `ALLOWED_EMAIL_DOMAINS` (sem
// prefixo NEXT_PUBLIC_) não chega ao bundle do navegador de propósito (nunca
// expor a lista de domínios corporativos ao cliente) — em código client-side
// `dominiosPermitidos()` sempre volta vazio e este schema sempre rejeita
// (fail-closed também aí, nunca "libera geral" no cliente por engano). Um
// componente client que precise de validação de e-mail antes do submit deve
// usar só `.email()` puro e deixar a checagem de domínio para a resposta da
// API (ver cadastro/page.tsx) — nunca duplicar esta regra no cliente.
export const emailPermitidoSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(LIMITES_INPUT.email, `E-mail deve ter no máximo ${LIMITES_INPUT.email} caracteres.`)
  .email('E-mail inválido.')
  .refine((email) => dominiosPermitidos().includes(email.split('@')[1]), {
    message: 'O domínio deste e-mail não está autorizado para cadastro.',
  })

export const buscaSchema = z
  .string()
  .trim()
  .max(LIMITES_INPUT.busca, `Busca deve ter no máximo ${LIMITES_INPUT.busca} caracteres.`)

export const nomeColaboradorSchema = z
  .string()
  .trim()
  .min(1, 'Nome é obrigatório.')
  .max(LIMITES_INPUT.nome, `Nome muito longo (máximo de ${LIMITES_INPUT.nome} caracteres).`)

// Etapa security/input-hardening-b1 — senha é conteúdo OPACO: ao contrário
// de nome/e-mail acima, NUNCA sofre `.trim()`/`.toLowerCase()`/`.normalize()`
// em lugar nenhum — um espaço inicial/final ou uma letra maiúscula é parte
// literal da senha do usuário, não um erro de digitação a corrigir. Decisão
// fechada: SEM exigência de complexidade (maiúscula/minúscula/número/
// símbolo) — só comprimento.
//
//   NOVA senha (cadastro, criação administrativa de colaborador, alteração
//   da própria senha): mínimo 8 CARACTERES, máximo 72 BYTES UTF-8 — o
//   limite real do bcryptjs, que trunca silenciosamente qualquer entrada
//   além disso (duas senhas diferentes que compartilham os primeiros 72
//   bytes hasheiam para o MESMO valor sem essa checagem). O mínimo é em
//   CARACTERES (nunca bytes) — uma senha pode ter >= 8 caracteres e ainda
//   assim ultrapassar 72 bytes (acentos/emoji/multibyte), e deve ser
//   rejeitada mesmo assim.
//
//   LOGIN (e a senha ATUAL na troca de senha, `PATCH /api/auth/senha`): SEM
//   mínimo de 8 — compatibilidade com contas legadas que nunca passaram por
//   esta regra — só não-vazia, com o MESMO teto de 72 bytes verificado
//   ANTES de `bcrypt.compare()` (nunca gastar o custo de CPU do bcrypt com
//   um input impossível). Login não usa um zod schema dedicado: a rejeição
//   por tamanho precisa devolver a MESMA resposta genérica de "credenciais
//   inválidas" que qualquer outra falha de autenticação — nunca uma
//   mensagem de validação distinta que revelaria "sua senha passou do
//   limite" de forma enumerável — então cada rota aplica
//   `senhaDentroDoLimiteBcrypt()` diretamente, não via `.safeParse()`.
export const LIMITE_BYTES_SENHA_BCRYPT = 72
export const MINIMO_CARACTERES_SENHA_NOVA = 8

// `TextEncoder` (Web API padrão) — nunca `Buffer`: este arquivo é importado
// por componentes client (ex.: colaboradores/page.tsx, cadastro/page.tsx),
// e `Buffer` não existe no bundle do navegador. `TextEncoder` é global tanto
// no runtime Node do Next.js quanto no browser, sem polyfill. `.length` de
// uma `string` JS conta UTF-16 code units, não bytes UTF-8 — nunca usar
// `senha.length` para checar o limite do bcrypt.
export function utf8ByteLength(valor: string): number {
  return new TextEncoder().encode(valor).length
}

export function senhaDentroDoLimiteBcrypt(valor: string): boolean {
  return utf8ByteLength(valor) <= LIMITE_BYTES_SENHA_BCRYPT
}

// Etapa security/input-hardening-b1 (auditoria de mínimo): `.length` de uma
// `string` JS conta unidades UTF-16, NÃO code points Unicode — um caractere
// fora do BMP (a maioria dos emojis, ex.: "😀") ocupa 2 unidades UTF-16
// (surrogate pair) mas é 1 único code point/caractere visual. Sem isso,
// "😀😀😀😀" (4 caracteres de verdade) teria `.length === 8` e passaria
// artificialmente no mínimo de 8 CARACTERES exigido — nunca usar
// `z.string().min(...)` (que usa `.length` por baixo) para esta contagem.
// `[...valor]` itera a string respeitando surrogate pairs (protocolo
// iterável de string do JS já entende UTF-16 corretamente) — conta code
// points reais, sem precisar de segmentação de grapheme clusters
// (`Intl.Segmenter`), desnecessária para este caso.
export function unicodeCharacterLength(valor: string): number {
  return [...valor].length
}

export const senhaNovaSchema = z
  .string()
  .refine((valor) => unicodeCharacterLength(valor) >= MINIMO_CARACTERES_SENHA_NOVA, {
    message: `Informe pelo menos ${MINIMO_CARACTERES_SENHA_NOVA} caracteres.`,
  })
  .refine(senhaDentroDoLimiteBcrypt, { message: 'A senha excede o tamanho máximo permitido.' })

// Etapa security/input-hardening-b4: `.strict()` nos schemas que recebem um
// objeto inteiro vindo do cliente (via `.safeParse(body)` ou dentro de um
// array) — um campo extra não previsto aqui já seria descartado
// silenciosamente pelo comportamento padrão do Zod antes de chegar a
// qualquer `data` do Prisma (nunca houve mass assignment de verdade), mas
// `.strict()` devolve um erro explícito em vez de aceitar/ignorar em
// silêncio um payload com campos a mais — sinal mais claro de que o cliente
// está enviando algo que o backend não espera.
export const itemPapelariaSchema = z
  .object({
    // Texto livre (Etapa security/input-hardening-b2): precisa suportar
    // pedidos reais como "2 cartolinas, 3 pincéis, folhas A3..." — teto
    // deliberadamente maior que os demais campos de texto curto (ver
    // LIMITES_INPUT.papelaria).
    descricao: z
      .string()
      .trim()
      .min(1, 'Descrição é obrigatória.')
      .max(LIMITES_INPUT.papelaria, `Descrição deve ter no máximo ${LIMITES_INPUT.papelaria} caracteres.`),
    // Etapa security/input-hardening-b3: `.max(1000)` — `.int()` já rejeita
    // NaN/Infinity (`Number.isInteger` é `false` para os dois), o teto aqui é
    // só um limite de bom senso para uma quantidade física real (nunca visto
    // um pedido de milhares de unidades de um item de papelaria).
    quantidade: z.number().int().positive('Quantidade deve ser maior que zero.').max(1000, 'Quantidade deve ser no máximo 1000.'),
  })
  .strict()

// NOVO (Fase 3 — Etapa 3)
export const itemServicoSchema = z
  .object({
    tipoServicoId: z.string().min(1, 'Selecione o tipo de serviço.'),
    quantidade: z
      .number()
      .int('Quantidade deve ser um número inteiro.')
      .min(1, 'Quantidade deve ser maior que zero.')
      .max(1000, 'Quantidade deve ser no máximo 1000.'),
    ambiente: z
      .string()
      .trim()
      .min(1, 'Informe o ambiente/local do serviço.')
      .max(LIMITES_INPUT.localAmbiente, `Ambiente deve ter no máximo ${LIMITES_INPUT.localAmbiente} caracteres.`),
    observacao: z
      .string()
      .trim()
      .max(LIMITES_INPUT.observacao, `Observação deve ter no máximo ${LIMITES_INPUT.observacao} caracteres.`)
      .optional(),
  })
  .strict()

export const criarSolicitacaoSchema = z
  .object({
    tipoEmprestimo: tipoEmprestimoEnum,
    // Opcional (Etapa security/request-for-another): quando omitido, a rota
    // (POST /api/solicitacoes) usa o próprio usuário autenticado como
    // solicitante — nunca um valor "adivinhado" do lado do schema. Quando
    // presente e diferente da sessão, a rota exige Gestor/Patrimônio/Admin
    // (ver podeSolicitarParaOutro em src/lib/permissions.ts).
    solicitanteId: z.string().min(1, 'Selecione o solicitante.').optional(),

    ambiente: z
      .string()
      .trim()
      .max(LIMITES_INPUT.localAmbiente, `Ambiente deve ter no máximo ${LIMITES_INPUT.localAmbiente} caracteres.`)
      .optional(),
    finalidade: z
      .string()
      .trim()
      .max(LIMITES_INPUT.descricaoCurta, `Finalidade deve ter no máximo ${LIMITES_INPUT.descricaoCurta} caracteres.`)
      .optional(),

    atividadeExterna: z
      .string()
      .trim()
      .max(LIMITES_INPUT.descricaoCurta, `Atividade deve ter no máximo ${LIMITES_INPUT.descricaoCurta} caracteres.`)
      .optional(),
    local: z
      .string()
      .trim()
      .max(LIMITES_INPUT.localAmbiente, `Local deve ter no máximo ${LIMITES_INPUT.localAmbiente} caracteres.`)
      .optional(),
    cidade: z
      .string()
      .trim()
      .max(LIMITES_INPUT.localAmbiente, `Cidade deve ter no máximo ${LIMITES_INPUT.localAmbiente} caracteres.`)
      .optional(),
    gestorId: z.string().optional(),

    observacoes: z
      .string()
      .trim()
      .max(LIMITES_INPUT.observacao, `Observações devem ter no máximo ${LIMITES_INPUT.observacao} caracteres.`)
      .optional(),

    // Etapa security/input-hardening-b3: formato estrito `YYYY-MM-DD` (o
    // único formato que o `<input type="date">` do frontend realmente
    // envia) + validação de CALENDÁRIO CIVIL (`dataCivilValida`) — sem
    // isso, "2026-02-30" (dia inexistente) passava no `.min(1)` e
    // `new Date('2026-02-30')` NÃO é `Invalid Date` (o JS rola
    // silenciosamente para 2026-03-02), persistindo uma data errada em vez
    // de ser rejeitada aqui. Não altera NENHUMA regra de antecedência/
    // prazo/período já existente — só garante que o valor é uma data civil
    // real antes de chegar a essas regras.
    data: z.string().min(1, 'Selecione a data.').refine(dataCivilValida, { message: 'Data inválida.' }),
    // Período (Manhã/Tarde/Noite) é obrigatório para os dois fluxos —
    // reserva antecipada (um ou mais períodos) e Atendimento Imediato
    // (exatamente um período, indicando quando o atendimento ocorreu; ver
    // refine abaixo). Não define o prazo de 48h/72h no caso do atendimento
    // imediato — serve apenas como registro operacional (ver src/lib/status
    // e a rota de criação, que zera explicitamente os campos de prazo
    // quando origem=ATENDIMENTO_IMEDIATO, independentemente do período).
    // Etapa security/input-hardening-b3: `.max(3)` — nunca existem mais que
    // MANHÃ/TARDE/NOITE no conjunto fechado (periodoEnum já impede um valor
    // fora dele); o teto aqui é só defesa extra contra um array
    // artificialmente inflado (ex.: mesmo período repetido dezenas de
    // vezes) chegando ao `hasSome`/`create` do Prisma.
    periodos: z.array(periodoEnum).max(3, 'Selecione no máximo 3 períodos.').default([]),

    notebooksComDominio: z.boolean().optional(),
    tipoDominio: tipoDominioEnum.optional(),

    // Etapa security/input-hardening-b3: `.max(50)` nos 3 arrays de itens —
    // mesmo teto nos três, coerente com o uso real (uma solicitação nunca
    // precisou de mais que uma dezena de bens/itens na prática) e alto o
    // suficiente para nunca bloquear um pedido legítimo. Protege contra um
    // payload manipulado tentando criar centenas/milhares de
    // `itensPatrimonio`/`itensPapelaria`/`itensServico` numa única
    // transação (ver POST /api/solicitacoes, que faz um `create` por item).
    patrimonioIds: z.array(z.string()).max(50, 'Selecione no máximo 50 bens patrimoniais.').default([]),
    itensPapelaria: z.array(itemPapelariaSchema).max(50, 'Adicione no máximo 50 itens de papelaria.').default([]),
    servicos: z.array(itemServicoSchema).max(50, 'Adicione no máximo 50 serviços/movimentações.').default([]),

    // NOVO (Fase 3 — Etapa 4): origem da solicitação. Default RESERVA
    // (fluxo normal já existente). Somente Patrimônio/Administrador pode
    // enviar ATENDIMENTO_IMEDIATO — validado no backend, nunca só no schema.
    origem: origemEnum.default('RESERVA'),
  })
  // Etapa security/input-hardening-b4 (revertido — ver
  // scripts/test-solicitacoes-para-outro.ts, cenário G): `.strict()` aqui
  // quebra um contrato de segurança já testado — um colaborador comum
  // enviando `podeSolicitarParaOutro: true` (campo de User, não desta
  // solicitação) no body precisa continuar caindo no gate de autorização
  // (403, via `podeSolicitarParaOutro(validacao.user)` na rota, decidido
  // SÓ pela sessão), não falhar antes disso na validação estrutural (400).
  // O campo já é inofensivo sem `.strict()` — nunca é lido do body em
  // lugar nenhum da rota — então não há mass assignment real a fechar
  // aqui; preferir manter o comportamento testado a converter esse 403 em
  // 400.
  .refine((d) => d.patrimonioIds.length > 0 || d.itensPapelaria.length > 0 || d.servicos.length > 0, {
    message: 'Adicione pelo menos um bem patrimonial, um item de papelaria ou um serviço/movimentação para continuar.',
    path: ['patrimonioIds'],
  })
  .refine((d) => d.periodos.length > 0, {
    message: 'Selecione ao menos um período.',
    path: ['periodos'],
  })
  // Etapa security/input-hardening-b3: período repetido (ex.: ['MANHA',
  // 'MANHA']) não tem nenhum significado de negócio novo — mesma checagem
  // de duplicidade que já existe para `patrimonioIds` (bem físico não pode
  // ser selecionado duas vezes), aplicada aqui pelo mesmo motivo: um
  // conjunto que deveria ser único.
  .refine((d) => new Set(d.periodos).size === d.periodos.length, {
    message: 'Não é permitido selecionar o mesmo período mais de uma vez.',
    path: ['periodos'],
  })
  .refine((d) => d.origem !== 'ATENDIMENTO_IMEDIATO' || d.periodos.length === 1, {
    message: 'Selecione apenas um período para o atendimento imediato.',
    path: ['periodos'],
  })
  .refine((d) => d.tipoEmprestimo !== 'externo' || !!d.gestorId, {
    message: 'Gestor é obrigatório em empréstimos externos.',
    path: ['gestorId'],
  })
  .refine((d) => d.tipoEmprestimo !== 'externo' || !!(d.local && d.cidade && d.atividadeExterna), {
    message: 'Atividade, local e cidade são obrigatórios em empréstimos externos.',
    path: ['local'],
  })
  // Etapa fix/internal-environment-validation: "Ambiente ou sala" já era
  // obrigatório na UI de Nova Solicitação (ver validarEtapa() em
  // nova-solicitacao/page.tsx — mesma mensagem usada aqui), mas o schema
  // deixava passar vazio/só-espaço/ausente — nada impedia um payload
  // manipulado direto na API. Exclusivo de tipoEmprestimo='interno' — nunca
  // se aplica a empréstimos externos.
  //
  // origem='ATENDIMENTO_IMEDIATO' é DELIBERADAMENTE excluído aqui mesmo
  // sendo sempre coagido para tipoEmprestimo='interno' no backend (ver
  // POST /api/solicitacoes) — aquele formulário (Atendimento Imediato) não
  // tem nenhum campo de ambiente da solicitação como um todo (só
  // "ambiente" por item de serviço, um campo diferente, já validado por
  // itemServicoSchema); exigir isso ali quebraria 100% dos registros desse
  // fluxo.
  .refine((d) => d.origem === 'ATENDIMENTO_IMEDIATO' || d.tipoEmprestimo !== 'interno' || !!d.ambiente?.trim(), {
    message: 'Informe o ambiente ou sala.',
    path: ['ambiente'],
  })

export const rejeitarSchema = z
  .object({
    motivo: z
      .string()
      .trim()
      .min(3, 'Informe uma justificativa.')
      .max(LIMITES_INPUT.motivo, `Justificativa deve ter no máximo ${LIMITES_INPUT.motivo} caracteres.`),
  })
  .strict()

// Etapa security/input-hardening-b4: `link` é colado manualmente pelo
// Patrimônio/Admin (assinatura documental externa) e depois renderizado como
// `href` de um link real na tela da solicitação (ver
// src/app/(dashboard)/solicitacoes/[id]/page.tsx) — `.url()` sozinho aceita
// QUALQUER esquema reconhecido pelo parser de URL do WHATWG, incluindo
// `javascript:`. Sem esta checagem, uma conta já autorizada a enviar
// assinatura (Patrimônio/Admin) poderia gravar um link `javascript:...` que
// executaria no navegador do SOLICITANTE ao clicar em "Assinar agora" — um
// usuário diferente de quem definiu o link. Restringe ao mínimo necessário
// para um link de assinatura real (http/https), sem exigir HTTPS
// especificamente (ambientes de homologação podem usar http).
export const enviarAssinaturaSchema = z
  .object({
    link: z
      .string()
      .trim()
      .url('Informe um link válido.')
      .refine((url) => /^https?:\/\//i.test(url), { message: 'O link deve começar com http:// ou https://.' }),
  })
  .strict()

export const retiradaSchema = z
  .object({
    observacoes: z
      .string()
      .trim()
      .max(LIMITES_INPUT.observacao, `Observações devem ter no máximo ${LIMITES_INPUT.observacao} caracteres.`)
      .optional(),
  })
  .strict()

// NOVO (Etapa 9A-C): condição estruturada de devolução — substitui o antigo
// texto livre para devoluções novas (dado histórico preservado à parte, ver
// Solicitacao.devolucaoCondicaoTextoLegado no schema). Observação é opcional
// apenas quando SEM_AVARIAS; nos demais casos, obrigatória (queremos saber
// qual foi o problema).
export const condicaoDevolucaoEnum = z.enum(['SEM_AVARIAS', 'COM_AVARIA', 'DANIFICADO', 'NECESSITA_VERIFICACAO'])

export const devolucaoSchema = z
  .object({
    condicao: condicaoDevolucaoEnum,
    observacoes: z
      .string()
      .trim()
      .max(LIMITES_INPUT.observacao, `Observações devem ter no máximo ${LIMITES_INPUT.observacao} caracteres.`)
      .optional(),
  })
  .strict()
  .refine((d) => d.condicao === 'SEM_AVARIAS' || !!d.observacoes, {
    message: 'Descreva o problema encontrado na devolução.',
    path: ['observacoes'],
  })

export const categoriaSchema = z
  .object({
    nome: z
      .string()
      .trim()
      .min(1, 'Nome é obrigatório.')
      .max(LIMITES_INPUT.categoria, `Nome deve ter no máximo ${LIMITES_INPUT.categoria} caracteres.`),
    descricao: z
      .string()
      .trim()
      .max(LIMITES_INPUT.descricaoCurta, `Descrição deve ter no máximo ${LIMITES_INPUT.descricaoCurta} caracteres.`)
      .optional(),
    icone: z
      .string()
      .trim()
      .max(LIMITES_INPUT.tituloCurto, `Ícone deve ter no máximo ${LIMITES_INPUT.tituloCurto} caracteres.`)
      .optional(),
    ordem: z.number().int().optional(),
    ativo: z.boolean().optional(),
  })
  .strict()

export const patrimonioSchema = z
  .object({
    numero: z
      .string()
      .trim()
      .min(1, 'Número de patrimônio é obrigatório.')
      .max(LIMITES_INPUT.tituloCurto, `Número de patrimônio deve ter no máximo ${LIMITES_INPUT.tituloCurto} caracteres.`),
    marca: z
      .string()
      .trim()
      .min(1, 'Marca é obrigatória.')
      .max(LIMITES_INPUT.tituloCurto, `Marca deve ter no máximo ${LIMITES_INPUT.tituloCurto} caracteres.`),
    modelo: z
      .string()
      .trim()
      .min(1, 'Modelo é obrigatório.')
      .max(LIMITES_INPUT.tituloCurto, `Modelo deve ter no máximo ${LIMITES_INPUT.tituloCurto} caracteres.`),
    categoriaId: z.string().min(1, 'Categoria é obrigatória.'),
    observacoes: z
      .string()
      .trim()
      .max(LIMITES_INPUT.observacao, `Observações devem ter no máximo ${LIMITES_INPUT.observacao} caracteres.`)
      .optional(),
    ativo: z.boolean().optional(),
  })
  .strict()
