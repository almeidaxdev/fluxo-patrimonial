// src/app/api/auth/cadastro/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import bcrypt from 'bcryptjs'
import { checkSensitiveRateLimit, extrairIpCliente, RATE_LIMIT_RETRY_AFTER_SECONDS, RATE_LIMIT_RESPONSE_BODY } from '@/lib/rate-limit'
import { emailPermitidoSchema, nomeColaboradorSchema, senhaNovaSchema } from '@/lib/validations'
import { parseJsonBody } from '@/lib/http'
import { assertDemoActionAllowed } from '@/lib/demo-mode'

export async function POST(req: NextRequest) {
  // Fluxo Patrimonial — Demo: autocadastro criaria contas fora do dataset
  // controlado pelo reset — bloqueado incondicionalmente, antes de qualquer
  // outra validação/rate limit.
  const bloqueio = assertDemoActionAllowed('auth:autocadastro')
  if (bloqueio) return bloqueio

  try {
    const corpo = await parseJsonBody<{ nome?: string; email?: string; senha?: string }>(req)
    if (!corpo.ok) return corpo.resposta
    const { nome: nomeBruto, email: emailBruto, senha } = corpo.data

    if (!nomeBruto || !emailBruto || !senha) {
      return NextResponse.json({ message: 'Todos os campos são obrigatórios.' }, { status: 400 })
    }

    // Rate limit por IP (Etapa security/rate-limit) — namespace 'cadastro'.
    // Chave por IP (não por e-mail): mesmo com a restrição de domínio
    // permitido em vigor (ALLOWED_EMAIL_DOMAINS, logo abaixo), um limite por
    // conta não conteria alguém testando muitos e-mails a partir do mesmo
    // lugar; o IP é o identificador que realmente captura esse padrão. Roda
    // ANTES de QUALQUER validação/consulta — inclusive antes da validação de
    // domínio: uma tentativa já bloqueada por volume não deve gastar nem o
    // custo (baixo, mas não zero) de validar o payload, e nunca revela por
    // que foi bloqueada através de uma mensagem de validação diferente da de
    // rate limit.
    const { limited } = await checkSensitiveRateLimit({ request: req, namespace: 'cadastro', identifier: extrairIpCliente(req) })
    if (limited) {
      return NextResponse.json(RATE_LIMIT_RESPONSE_BODY, {
        status: 429,
        headers: { 'Retry-After': String(RATE_LIMIT_RETRY_AFTER_SECONDS) },
      })
    }

    // Mesma regra aplicada a QUALQUER caminho que cria uma conta User — só
    // e-mail de domínio permitido (ALLOWED_EMAIL_DOMAINS), normalizado (trim
    // + lowercase). Nunca confiar só na validação client-side desta tela;
    // backend é a fonte final.
    const parsedNome = nomeColaboradorSchema.safeParse(nomeBruto)
    if (!parsedNome.success) {
      return NextResponse.json({ message: parsedNome.error.errors[0]?.message ?? 'Nome inválido.' }, { status: 400 })
    }
    const parsedEmail = emailPermitidoSchema.safeParse(emailBruto)
    if (!parsedEmail.success) {
      return NextResponse.json({ message: parsedEmail.error.errors[0]?.message ?? 'E-mail inválido.' }, { status: 400 })
    }
    // Etapa security/input-hardening-b1: mínimo 8 caracteres / máximo 72
    // bytes UTF-8 — sem exigência de complexidade (decisão fechada). Nunca
    // `.trim()`/normalização em senha (só nome/e-mail acima recebem isso).
    const parsedSenha = senhaNovaSchema.safeParse(senha)
    if (!parsedSenha.success) {
      return NextResponse.json({ message: parsedSenha.error.errors[0]?.message ?? 'Senha inválida.' }, { status: 400 })
    }
    const nome = parsedNome.data
    const email = parsedEmail.data

    const existe = await prisma.user.findUnique({ where: { email } })
    if (existe) {
      return NextResponse.json({ message: 'Este e-mail já está cadastrado.' }, { status: 409 })
    }

    const senhaHash = await bcrypt.hash(parsedSenha.data, 12)

    try {
      await prisma.user.create({
        data: { nome, email, senha: senhaHash, permissao: 'colaborador' },
      })
    } catch (e) {
      // Corrida entre o SELECT acima e este INSERT (dois cadastros
      // simultâneos com o mesmo e-mail) — a unique constraint do banco é a
      // autoridade final, nunca só a checagem prévia.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return NextResponse.json({ message: 'Este e-mail já está cadastrado.' }, { status: 409 })
      }
      throw e
    }

    return NextResponse.json({ message: 'Conta criada com sucesso.' }, { status: 201 })
  } catch (e) {
    console.error(e)
    return NextResponse.json({ message: 'Erro interno no servidor.' }, { status: 500 })
  }
}
