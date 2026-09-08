// scripts/test-email-config.ts
//
// Teste manual (sem framework, mesmo padrão de execução de prisma/seed.ts)
// da regra de segurança mais crítica da Etapa D.1: EMAIL_TEST_MODE precisa
// falhar fechado, e nenhuma configuração inválida pode resultar em envio
// para o destinatário real. Não envia nenhum e-mail — só exercita
// getEmailConfig()/resolvePhysicalRecipient() com variáveis de ambiente
// simuladas em processo.
//
// Executar com: npm run test:email-config

import { getEmailConfig, resetEmailConfigCache, EmailConfigError, parseAppUrl } from '../src/lib/email/config'
import { resolvePhysicalRecipient } from '../src/lib/email/recipient'
import { buildAppUrl, resetAppUrlCache } from '../src/lib/email/app-url'

const BASE_ENV: Record<string, string> = {
  EMAIL_PROVIDER: 'resend',
  EMAIL_API_KEY: 'dummy-key-para-teste',
  EMAIL_FROM_ADDRESS: 'noreply@example.com',
  EMAIL_FROM_NAME: 'Teste',
  EMAIL_REPLY_TO: '',
  APP_URL: 'http://localhost:3000',
}

const MANAGED_KEYS = [...Object.keys(BASE_ENV), 'EMAIL_TEST_MODE', 'EMAIL_TEST_RECIPIENT']

function setEnv(overrides: Record<string, string>) {
  for (const key of MANAGED_KEYS) delete process.env[key]
  Object.assign(process.env, BASE_ENV, overrides)
  resetEmailConfigCache()
}

let failures = 0

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`OK   - ${label}`)
  } else {
    failures++
    console.error(`FALHA - ${label}`)
  }
}

function expectConfigError(fn: () => void, label: string) {
  try {
    fn()
    failures++
    console.error(`FALHA - ${label} (esperava EmailConfigError, nenhum erro foi lançado)`)
  } catch (err) {
    if (err instanceof EmailConfigError) {
      console.log(`OK   - ${label}`)
    } else {
      failures++
      console.error(`FALHA - ${label} (erro inesperado: ${err instanceof Error ? err.message : err})`)
    }
  }
}

const DESTINATARIO_REAL = 'destinatario-real@empresa.com'

// A) EMAIL_TEST_MODE=true + EMAIL_TEST_RECIPIENT válido → redireciona para teste
setEnv({ EMAIL_TEST_MODE: 'true', EMAIL_TEST_RECIPIENT: 'teste-autorizado@example.com' })
{
  const r = resolvePhysicalRecipient(DESTINATARIO_REAL)
  assert(
    r.isTest === true && r.physical === 'teste-autorizado@example.com' && r.original === DESTINATARIO_REAL,
    'A) test mode + destinatário de teste válido redireciona preservando o original'
  )
}

// B) EMAIL_TEST_MODE=true + EMAIL_TEST_RECIPIENT ausente → erro
setEnv({ EMAIL_TEST_MODE: 'true' })
expectConfigError(() => resolvePhysicalRecipient(DESTINATARIO_REAL), 'B) EMAIL_TEST_RECIPIENT ausente bloqueia envio')

// C) EMAIL_TEST_MODE=true + EMAIL_TEST_RECIPIENT inválido → erro
setEnv({ EMAIL_TEST_MODE: 'true', EMAIL_TEST_RECIPIENT: 'nao-e-um-email' })
expectConfigError(() => resolvePhysicalRecipient(DESTINATARIO_REAL), 'C) EMAIL_TEST_RECIPIENT inválido bloqueia envio')

// D) EMAIL_TEST_MODE=false → destinatário físico = original
setEnv({ EMAIL_TEST_MODE: 'false' })
{
  const r = resolvePhysicalRecipient(DESTINATARIO_REAL)
  assert(
    r.isTest === false && r.physical === DESTINATARIO_REAL,
    'D) EMAIL_TEST_MODE=false usa o destinatário original como físico'
  )
}

// E) EMAIL_TEST_MODE ausente → erro
setEnv({})
expectConfigError(() => getEmailConfig(), 'E) EMAIL_TEST_MODE ausente é erro de configuração')

// F) EMAIL_TEST_MODE="tru" → erro
setEnv({ EMAIL_TEST_MODE: 'tru' })
expectConfigError(() => getEmailConfig(), 'F) EMAIL_TEST_MODE="tru" é erro de configuração')

// G) EMAIL_TEST_MODE="1" → erro
setEnv({ EMAIL_TEST_MODE: '1' })
expectConfigError(() => getEmailConfig(), 'G) EMAIL_TEST_MODE="1" é erro de configuração')

// H) EMAIL_TEST_MODE="yes" → erro
setEnv({ EMAIL_TEST_MODE: 'yes' })
expectConfigError(() => getEmailConfig(), 'H) EMAIL_TEST_MODE="yes" é erro de configuração')

// I) nenhuma configuração inválida acima retornou um destinatário físico —
// os testes B, C, E, F, G, H já comprovam isso (todos lançam antes de
// resolver qualquer destinatário).

// --- EMAIL_TEST_MODE: comparação literal do valor RAW (sem trim/lowercase) -

assert(
  (() => {
    setEnv({ EMAIL_TEST_MODE: 'true', EMAIL_TEST_RECIPIENT: 'teste-autorizado@example.com' })
    return getEmailConfig().testMode === true
  })(),
  'EMAIL_TEST_MODE válido: "true"'
)
assert(
  (() => {
    setEnv({ EMAIL_TEST_MODE: 'false' })
    return getEmailConfig().testMode === false
  })(),
  'EMAIL_TEST_MODE válido: "false"'
)

const invalidTestModeValues = [
  'TRUE',
  'FALSE',
  'True',
  'False',
  ' true',
  'true ',
  ' false ',
  '1',
  '0',
  'yes',
  'no',
  'tru',
  '',
]
for (const value of invalidTestModeValues) {
  setEnv({ EMAIL_TEST_MODE: value })
  expectConfigError(() => getEmailConfig(), `EMAIL_TEST_MODE inválido é rejeitado: ${JSON.stringify(value)}`)
}
setEnv({})
expectConfigError(() => getEmailConfig(), 'EMAIL_TEST_MODE inválido é rejeitado: ausente')

// --- APP_URL: válidos ---------------------------------------------------

assert(parseAppUrl('http://localhost:3000') === 'http://localhost:3000', 'APP_URL válido: http://localhost:3000')
assert(parseAppUrl('https://exemplo.com') === 'https://exemplo.com', 'APP_URL válido: https://exemplo.com')
assert(parseAppUrl('https://exemplo.com/app') === 'https://exemplo.com/app', 'APP_URL válido: https://exemplo.com/app')

// --- APP_URL: inválidos ---------------------------------------------------

const invalidAppUrls: Array<string | undefined> = [
  'javascript:alert(1)',
  'mailto:teste@example.com',
  'ftp://exemplo.com',
  'file:///tmp/teste',
  'localhost',
  'example.com',
  '',
  undefined,
]
for (const value of invalidAppUrls) {
  expectConfigError(
    () => parseAppUrl(value),
    `APP_URL inválido é rejeitado: ${value === undefined ? 'ausente' : JSON.stringify(value)}`
  )
}

// --- APP_URL: rejeita query string e fragment ------------------------------

const appUrlsWithQueryOrHash = [
  'https://example.com?tenant=1',
  'https://example.com/app?tenant=1',
  'https://example.com/#teste',
  'https://example.com/app#teste',
  'http://localhost:3000?x=1',
  'http://localhost:3000/#abc',
]
for (const value of appUrlsWithQueryOrHash) {
  expectConfigError(() => parseAppUrl(value), `APP_URL com query/fragment é rejeitado: ${JSON.stringify(value)}`)
}

// --- buildAppUrl: sem "//" duplicado, com ou sem barra final em APP_URL ---

setEnv({ APP_URL: 'http://localhost:3000' })
resetAppUrlCache()
assert(
  buildAppUrl('/solicitacoes/123') === 'http://localhost:3000/solicitacoes/123',
  'buildAppUrl: APP_URL sem barra final + path com barra'
)

setEnv({ APP_URL: 'https://exemplo.com/' })
resetAppUrlCache()
assert(
  buildAppUrl('/solicitacoes/123') === 'https://exemplo.com/solicitacoes/123',
  'buildAppUrl: APP_URL com barra final não gera // duplicado'
)

setEnv({ APP_URL: 'https://example.com/app' })
resetAppUrlCache()
assert(
  buildAppUrl('/solicitacoes/123') === 'https://example.com/app/solicitacoes/123',
  'buildAppUrl: preserva subpath /app sem barra final'
)

setEnv({ APP_URL: 'https://example.com/app/' })
resetAppUrlCache()
assert(
  buildAppUrl('/solicitacoes/123') === 'https://example.com/app/solicitacoes/123',
  'buildAppUrl: preserva subpath /app com barra final'
)

console.log('')
if (failures > 0) {
  console.error(`${failures} teste(s) de segurança de e-mail falharam.`)
  process.exit(1)
}
console.log('Todos os testes de segurança de e-mail passaram. Nenhum e-mail foi enviado.')
