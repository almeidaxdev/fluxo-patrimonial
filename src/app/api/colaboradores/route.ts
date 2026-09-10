// src/app/api/colaboradores/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getValidatedMutationSession } from '@/lib/session-validation'
import { isAdmin } from '@/lib/permissions'
import { emailPermitidoSchema, nomeColaboradorSchema, senhaNovaSchema, permissaoEnum, buscaSchema } from '@/lib/validations'
import { parsePaginacao } from '@/lib/query-params'
import { parseJsonBody } from '@/lib/http'
import { assertDemoActionAllowed } from '@/lib/demo-mode'
import bcrypt from 'bcryptjs'

// Etapa security/session-revocation: GET "privilegiado" (seção B da
// auditoria) — revalida no banco porque expõe `permissao`/`ativo`/
// `podeSolicitarParaOutro` de TODOS os colaboradores para quem chama, o
// mesmo padrão já usado em relatórios (src/lib/relatorios-auth.ts). Só 1
// consulta adicional — rota administrativa, chamada com pouca frequência,
// nunca em navegação comum.
export async function GET(req: NextRequest) {
  const validacao = await getValidatedMutationSession()
  if (!validacao.valido) return validacao.resposta
  if (!isAdmin(validacao.user)) return NextResponse.json({ message: 'Sem permissão.' }, { status: 403 })

  const { searchParams } = new URL(req.url)
  const buscaBruta = searchParams.get('busca') || ''
  // Etapa security/input-hardening-b2: mesmo teto de LIMITES_INPUT.busca
  // usado em todo campo de busca/filtro textual — busca vazia continua
  // liberada (nenhum filtro aplicado), só um valor efetivamente maior que o
  // limite é rejeitado.
  const parsedBusca = buscaSchema.safeParse(buscaBruta)
  if (!parsedBusca.success) {
    return NextResponse.json({ message: parsedBusca.error.errors[0]?.message ?? 'Busca inválida.' }, { status: 400 })
  }
  const busca = parsedBusca.data
  // Etapa security/input-hardening-b3: default (10) preservado; teto de 100
  // contra um `limit` arbitrariamente grande.
  const { page, limit, skip } = parsePaginacao(searchParams, { limitPadrao: 10, limiteMaximo: 100 })

  const where = busca
    ? { OR: [{ nome: { contains: busca, mode: 'insensitive' as const } }, { email: { contains: busca, mode: 'insensitive' as const } }] }
    : {}

  const [users, total] = await Promise.all([
    prisma.user.findMany({ where, orderBy: { nome: 'asc' }, skip, take: limit, select: { id: true, nome: true, email: true, permissao: true, ativo: true, podeSerGestor: true, podeSolicitarParaOutro: true, gestorPadraoId: true, gestorPadrao: { select: { id: true, nome: true } }, createdAt: true } }),
    prisma.user.count({ where }),
  ])

  return NextResponse.json({ users, total, page, limit }, { status: 200 })
}

export async function POST(req: NextRequest) {
  const validacao = await getValidatedMutationSession()
  if (!validacao.valido) return validacao.resposta
  if (!isAdmin(validacao.user)) return NextResponse.json({ message: 'Sem permissão.' }, { status: 403 })

  // Fluxo Patrimonial — Demo: colaboradores são dado mestre somente-leitura
  // na demo — criação bloqueada por inteiro (ver src/lib/demo-mode.ts).
  const bloqueio = assertDemoActionAllowed('colaborador:mutar')
  if (bloqueio) return bloqueio

  try {
    const corpo = await parseJsonBody<{
      nome?: string
      email?: string
      senha?: string
      permissao?: string
      podeSerGestor?: boolean
      podeSolicitarParaOutro?: boolean
      gestorPadraoId?: string
    }>(req)
    if (!corpo.ok) return corpo.resposta
    const { nome: nomeBruto, email: emailBruto, senha, permissao, podeSerGestor, podeSolicitarParaOutro, gestorPadraoId } = corpo.data
    if (!nomeBruto || !emailBruto || !senha || !permissao) {
      return NextResponse.json({ message: 'Todos os campos são obrigatórios.' }, { status: 400 })
    }

    // Mesma validação/normalização de cadastro público (POST /api/auth/
    // cadastro) — nenhum caminho de criação de User aceita e-mail fora dos
    // domínios configurados em ALLOWED_EMAIL_DOMAINS, nem confia no que o
    // frontend já validou.
    const parsedNome = nomeColaboradorSchema.safeParse(nomeBruto)
    if (!parsedNome.success) {
      return NextResponse.json({ message: parsedNome.error.errors[0]?.message ?? 'Nome inválido.' }, { status: 400 })
    }
    const parsedEmail = emailPermitidoSchema.safeParse(emailBruto)
    if (!parsedEmail.success) {
      return NextResponse.json({ message: parsedEmail.error.errors[0]?.message ?? 'E-mail inválido.' }, { status: 400 })
    }
    // Etapa security/input-hardening-b1: mesma regra de senha nova usada em
    // cadastro público e alteração da própria senha — mínimo 8 caracteres,
    // máximo 72 bytes UTF-8, sem exigência de complexidade, nunca trim.
    const parsedSenha = senhaNovaSchema.safeParse(senha)
    if (!parsedSenha.success) {
      return NextResponse.json({ message: parsedSenha.error.errors[0]?.message ?? 'Senha inválida.' }, { status: 400 })
    }
    // Etapa security/input-hardening-b2: `permissao` chegava direto do body
    // (`body.permissao as Permissao`, sem checagem) até aqui — um valor
    // arbitrário (ex.: "SUPER_ADMIN_DO_MUNDO") seria gravado como está,
    // rejeitado só pela constraint do enum no banco (erro genérico/500).
    // Validado explicitamente contra o conjunto fechado real (colaborador/
    // patrimonio/administrador) antes de qualquer escrita.
    const parsedPermissao = permissaoEnum.safeParse(permissao)
    if (!parsedPermissao.success) {
      return NextResponse.json({ message: 'Valor de permissão inválido.' }, { status: 400 })
    }
    const nome = parsedNome.data
    const email = parsedEmail.data

    const existe = await prisma.user.findUnique({ where: { email } })
    if (existe) return NextResponse.json({ message: 'Já existe um colaborador cadastrado com este e-mail.' }, { status: 409 })

    const senhaHash = await bcrypt.hash(parsedSenha.data, 12)
    try {
      const user = await prisma.user.create({
        data: {
          nome,
          email,
          senha: senhaHash,
          permissao: parsedPermissao.data,
          podeSerGestor: !!podeSerGestor,
          // Capacidade adicional (Etapa security/request-for-another) — só
          // esta rota (admin-only) grava este campo; nunca vindo de um
          // formulário de autoedição do próprio colaborador.
          podeSolicitarParaOutro: !!podeSolicitarParaOutro,
          gestorPadraoId: gestorPadraoId || null,
        },
        select: { id: true, nome: true, email: true, permissao: true, ativo: true, podeSerGestor: true, podeSolicitarParaOutro: true, gestorPadraoId: true, createdAt: true },
      })

      return NextResponse.json({ user }, { status: 201 })
    } catch (e) {
      // Corrida entre o SELECT acima e este INSERT (duas criações
      // simultâneas com o mesmo e-mail): a checagem prévia não é garantia
      // suficiente sozinha — a unique constraint do banco é a autoridade
      // final, capturada aqui como P2002 em vez de vazar um 500 genérico.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return NextResponse.json({ message: 'Já existe um colaborador cadastrado com este e-mail.' }, { status: 409 })
      }
      throw e
    }
  } catch (e) {
    console.error(e)
    return NextResponse.json({ message: 'Erro interno.' }, { status: 500 })
  }
}
