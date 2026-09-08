// src/app/api/auth/login/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { setSession } from '@/lib/auth'
import bcrypt from 'bcryptjs'
import { checkSensitiveRateLimit, RATE_LIMIT_RETRY_AFTER_SECONDS, RATE_LIMIT_RESPONSE_BODY } from '@/lib/rate-limit'
import { senhaDentroDoLimiteBcrypt } from '@/lib/validations'
import { parseJsonBody } from '@/lib/http'

export async function POST(req: NextRequest) {
  try {
    const corpo = await parseJsonBody<{ email?: string; senha?: string }>(req)
    if (!corpo.ok) return corpo.resposta
    const { email: emailBruto, senha } = corpo.data

    if (!emailBruto || !senha || typeof emailBruto !== 'string') {
      return NextResponse.json({ message: 'E-mail e senha são obrigatórios.' }, { status: 400 })
    }

    // Normalizado (trim + lowercase) ANTES do rate limit e da consulta ao
    // banco — mesmo valor usado nos dois lugares. User.email é sempre
    // persistido já normalizado (criação e edição de colaborador, ver
    // src/lib/validations.ts, emailPermitidoSchema), então login com
    // variação de maiúsculas/espaços só encontra o usuário se normalizarmos
    // aqui também.
    // A ORDEM não muda: rate limit continua rodando ANTES de Prisma/bcrypt
    // (ver comentário abaixo) — só o valor usado como chave passou a ser o
    // normalizado, nunca o bruto do body.
    const email = emailBruto.trim().toLowerCase()

    // Rate limit por CONTA (Etapa security/rate-limit) — namespace 'login',
    // chave = hash do e-mail normalizado. Roda ANTES de qualquer consulta
    // ao banco e ANTES do bcrypt.compare: uma tentativa bloqueada não gasta
    // nenhum round-trip ao Postgres nem o custo de CPU do bcrypt (custo 12).
    const { limited } = await checkSensitiveRateLimit({ request: req, namespace: 'login', identifier: email })
    if (limited) {
      return NextResponse.json(RATE_LIMIT_RESPONSE_BODY, {
        status: 429,
        headers: { 'Retry-After': String(RATE_LIMIT_RETRY_AFTER_SECONDS) },
      })
    }

    const user = await prisma.user.findUnique({ where: { email } })

    // Etapa security/input-hardening-b1: uma senha acima de 72 bytes UTF-8
    // nunca pode ser a senha real de ninguém (bcrypt trunca ali, e nenhuma
    // senha desta etapa em diante é gravada acima disso) — rejeitar ANTES
    // de bcrypt.compare() evita gastar o custo de CPU do hash com um input
    // impossível. Dobrado na MESMA resposta genérica de "credenciais
    // inválidas" (nunca uma mensagem distinta tipo "senha excede o limite
    // do bcrypt") — de propósito: isso manteria a semântica de autenticação
    // não-enumerável, sem revelar ao cliente que o tamanho (e não a conta
    // ou a senha em si) foi o motivo da rejeição.
    if (!user || !user.ativo || !senhaDentroDoLimiteBcrypt(senha)) {
      return NextResponse.json({ message: 'E-mail ou senha inválidos.' }, { status: 401 })
    }

    const senhaCorreta = await bcrypt.compare(senha, user.senha)
    if (!senhaCorreta) {
      return NextResponse.json({ message: 'E-mail ou senha inválidos.' }, { status: 401 })
    }

    const sessionUser = {
      id: user.id,
      nome: user.nome,
      email: user.email,
      permissao: user.permissao,
      podeSerGestor: user.podeSerGestor,
      podeSolicitarParaOutro: user.podeSolicitarParaOutro,
      // Etapa security/session-revocation: versão vigente NO MOMENTO do
      // login — nunca recebida do client, sempre lida do banco agora mesmo.
      versaoSessao: user.versaoSessao,
    }
    await setSession(sessionUser)

    return NextResponse.json({ user: sessionUser }, { status: 200 })
  } catch (e) {
    console.error(e)
    return NextResponse.json({ message: 'Erro interno no servidor.' }, { status: 500 })
  }
}
