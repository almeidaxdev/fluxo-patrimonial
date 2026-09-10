// src/app/api/colaboradores/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { randomInt } from 'crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getValidatedMutationSession } from '@/lib/session-validation'
import { isAdmin } from '@/lib/permissions'
import { emailPermitidoSchema, nomeColaboradorSchema, permissaoEnum } from '@/lib/validations'
import { parseJsonBody } from '@/lib/http'
import { assertDemoActionAllowed } from '@/lib/demo-mode'
import bcrypt from 'bcryptjs'

// Etapa fix/secure-password-reset: reset administrativo deixou de gravar uma
// senha fixa (mesma para todo mundo, hardcoded, exibida em texto puro na UI
// antes mesmo do reset acontecer — achado CRÍTICO de auditoria de
// segurança). Cada reset agora gera uma senha temporária ALEATÓRIA e
// DIFERENTE por chamada, usando `crypto.randomInt` (fonte criptograficamente
// seguras do Node — nunca Math.random()). O texto plano só existe em memória
// durante esta requisição: é usado uma única vez para o hash bcrypt e
// devolvido ao admin somente no corpo desta resposta — nunca persistido,
// nunca logado, nunca gravado em Historico/Notificacao/EmailEvento/JWT.
//
// NÃO implementa troca obrigatória no próximo login: o schema atual (model
// User) não tem nenhum campo equivalente a "mustChangePassword" e esta etapa
// foi instruída a não alterar o banco sem aprovação. Ver proposta técnica
// separada entregue junto com esta mudança.
// Prefixo fixo (não é segredo — é só um identificador visual de "senha
// gerada pelo sistema") seguido de 8 caracteres aleatórios. O alfabeto do
// sufixo evita caracteres ambíguos (sem I/O/0/1).
const PREFIXO_SENHA_TEMPORARIA = 'Flx@9'
const ALFABETO_SENHA_TEMPORARIA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const TAMANHO_SUFIXO_SENHA_TEMPORARIA = 8

function gerarSenhaTemporaria(): string {
  let sufixo = ''
  for (let i = 0; i < TAMANHO_SUFIXO_SENHA_TEMPORARIA; i++) {
    sufixo += ALFABETO_SENHA_TEMPORARIA[randomInt(ALFABETO_SENHA_TEMPORARIA.length)]
  }
  return `${PREFIXO_SENHA_TEMPORARIA}${sufixo}`
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const validacao = await getValidatedMutationSession()
  if (!validacao.valido) return validacao.resposta
  if (!isAdmin(validacao.user)) return NextResponse.json({ message: 'Sem permissão.' }, { status: 403 })

  // Fluxo Patrimonial — Demo: colaboradores são dado mestre somente-leitura
  // na demo — QUALQUER edição (nome, e-mail, senha, status, perfil,
  // capacidades) é bloqueada por inteiro, sem distinção de campo. Cobre
  // automaticamente a conta demonstrativa pública (DEMO_ACCOUNT_EMAIL): ela
  // não é mais um caso especial, é só mais um colaborador. Checado ANTES de
  // qualquer leitura/validação.
  const bloqueioMutacao = assertDemoActionAllowed('colaborador:mutar')
  if (bloqueioMutacao) return bloqueioMutacao

  const { id } = await params

  try {
    const corpo = await parseJsonBody<{
      nome?: string
      email?: string
      permissao?: string
      resetSenha?: boolean
      ativo?: boolean
      podeSerGestor?: boolean
      podeSolicitarParaOutro?: boolean
      gestorPadraoId?: string
    }>(req)
    if (!corpo.ok) return corpo.resposta
    const { nome: nomeBruto, email: emailBruto, permissao, resetSenha, ativo, podeSerGestor, podeSolicitarParaOutro, gestorPadraoId } = corpo.data

    // Etapa security/session-revocation: pré-leitura do usuário ALVO (não o
    // admin autenticado) — necessária para comparar valor atual vs. novo e
    // decidir se algum gatilho de revogação (permissao/ativo/podeSerGestor/
    // podeSolicitarParaOutro/e-mail) realmente mudou, especialmente
    // reativação (ativo false→true também revoga, para um token emitido
    // antes da desativação não voltar a funcionar). Consulta adicional
    // deliberada: exigida pela própria regra de negócio, não redundante com
    // a validação de sessão acima (que é sobre o admin, não sobre o alvo).
    const alvoAntes = await prisma.user.findUnique({
      where: { id },
      select: { email: true, permissao: true, ativo: true, podeSerGestor: true, podeSolicitarParaOutro: true },
    })
    if (!alvoAntes) return NextResponse.json({ message: 'Usuário não encontrado.' }, { status: 404 })

    // Etapa fix/collaborator-session-sync: Admin não pode se auto-desativar
    // por esta tela — bloqueado no BACKEND (não só no botão desabilitado do
    // frontend), mesmo padrão já usado em DELETE (auto-exclusão) logo
    // abaixo. Checado ANTES de qualquer validação/escrita — um Admin
    // tentando isso nunca chega a validar nome/e-mail primeiro.
    if (ativo === false && id === validacao.user.id) {
      return NextResponse.json({ message: 'Você não pode desativar sua própria conta.' }, { status: 400 })
    }

    // Nome/e-mail editáveis pelo Admin (antes, só criados uma vez no
    // cadastro/criação). Validados aqui com os MESMOS schemas usados em toda
    // criação de User (nunca duplicar a regra de domínio permitido) — nunca
    // confiar no que o frontend já validou.
    let nome: string | undefined
    if (nomeBruto !== undefined) {
      const parsedNome = nomeColaboradorSchema.safeParse(nomeBruto)
      if (!parsedNome.success) {
        return NextResponse.json({ message: parsedNome.error.errors[0]?.message ?? 'Nome inválido.' }, { status: 400 })
      }
      nome = parsedNome.data
    }

    let email: string | undefined
    if (emailBruto !== undefined) {
      if (typeof emailBruto !== 'string') {
        return NextResponse.json({ message: 'E-mail inválido.' }, { status: 400 })
      }
      // Migração gradual de contas legadas (pré-existentes a esta regra, ou
      // criadas quando ALLOWED_EMAIL_DOMAINS tinha outro valor): o frontend
      // SEMPRE envia `email` no body, mesmo quando o Admin só quis mudar
      // `ativo`/`permissao`/capacidade — exigir aqui o domínio permitido
      // incondicionalmente bloquearia qualquer edição administrativa nessas
      // contas antigas até alguém trocar o e-mail delas, o que nunca foi a
      // intenção. Regra real:
      //   (A) valor normalizado DIFERENTE do já persistido → é uma mudança
      //       REAL de e-mail → domínio permitido é OBRIGATÓRIO (mesmo para
      //       "atualizar" uma conta legada — a migração é feita definindo um
      //       e-mail de domínio permitido de verdade, nunca mantendo um
      //       valor antigo mascarado).
      //   (B) valor normalizado IGUAL ao já persistido (mesmo que fora do
      //       domínio atual) → não é uma mudança de verdade → aceito como
      //       está, sem passar pela validação de domínio, para não travar
      //       Admin editando outros campos de uma conta legada.
      // Toda CRIAÇÃO de conta (POST /api/colaboradores, POST /api/auth/
      // cadastro) continua exigindo o domínio permitido sempre — não há
      // "legado" possível numa conta que ainda não existe.
      const emailNormalizadoBruto = emailBruto.trim().toLowerCase()
      if (emailNormalizadoBruto === alvoAntes.email) {
        email = emailNormalizadoBruto
      } else {
        const parsedEmail = emailPermitidoSchema.safeParse(emailBruto)
        if (!parsedEmail.success) {
          return NextResponse.json({ message: parsedEmail.error.errors[0]?.message ?? 'E-mail inválido.' }, { status: 400 })
        }
        email = parsedEmail.data
        // Unicidade — só chega aqui quando é de fato uma mudança de e-mail.
        // Checagem prévia por UX (mensagem amigável rápida); a unique
        // constraint do banco continua sendo a autoridade final contra a
        // corrida entre este SELECT e o UPDATE abaixo (capturada como
        // P2002 mais adiante).
        const outroComEsseEmail = await prisma.user.findUnique({ where: { email }, select: { id: true } })
        if (outroComEsseEmail && outroComEsseEmail.id !== id) {
          return NextResponse.json({ message: 'Já existe um colaborador cadastrado com este e-mail.' }, { status: 409 })
        }
      }
    }

    // Etapa security/input-hardening-b2: `permissao` chegava direto do body
    // sem checagem (`data.permissao = permissao`) — um valor arbitrário
    // seria gravado como está, rejeitado só pela constraint do enum no
    // banco (erro genérico/500). Validado aqui, ANTES de compor `data`,
    // exatamente como nome/e-mail acima — só quando o campo é de fato
    // enviado (`permissao` truthy), preservando PATCHes que não tocam nele.
    let permissaoValidada: string | undefined
    if (permissao) {
      const parsedPermissao = permissaoEnum.safeParse(permissao)
      if (!parsedPermissao.success) {
        return NextResponse.json({ message: 'Valor de permissão inválido.' }, { status: 400 })
      }
      permissaoValidada = parsedPermissao.data
    }

    const data: Record<string, unknown> = {}
    if (nome !== undefined) data.nome = nome
    if (email !== undefined) data.email = email
    if (permissaoValidada) data.permissao = permissaoValidada
    if (ativo !== undefined) data.ativo = ativo
    if (podeSerGestor !== undefined) data.podeSerGestor = podeSerGestor
    // Capacidade adicional (Etapa security/request-for-another): esta rota
    // já é admin-only (checagem acima) — só um Administrador chega até
    // aqui, e nenhuma outra rota aceita este campo no body (nunca
    // autoedição).
    if (podeSolicitarParaOutro !== undefined) data.podeSolicitarParaOutro = !!podeSolicitarParaOutro
    if (gestorPadraoId !== undefined) data.gestorPadraoId = gestorPadraoId || null

    let senhaTemporaria: string | undefined
    if (resetSenha) {
      senhaTemporaria = gerarSenhaTemporaria()
      data.senha = await bcrypt.hash(senhaTemporaria, 12)
    }

    // Etapa security/session-revocation (+ fix/collaborator-session-sync):
    // incrementa a versão de sessão do ALVO sempre que reset de senha
    // administrativo acontece, ou quando permissao/ativo/podeSerGestor/
    // podeSolicitarParaOutro/e-mail REALMENTE mudam de valor (nome nunca
    // dispara isso — é só dado de apresentação, sem implicação de
    // autenticação/autorização). Um ÚNICO `if` com OR: não importa quantos
    // desses campos mudem na MESMA chamada, o incremento é sempre +1, nunca
    // um por campo. A sessão do admin que está fazendo a alteração não é
    // tocada — só o `data` do usuário ALVO recebe o increment (mesmo
    // quando o admin edita a própria conta: é a conta ALVO,
    // `id === validacao.user.id` nesse caso, que compartilha a MESMA sessão
    // do admin — o efeito prático é a própria sessão do admin ficar
    // obsoleta, exigindo novo login).
    // `nome` deliberadamente ausente desta lista — nunca é gatilho.
    const mudouEmail = email !== undefined && email !== alvoAntes.email
    const mudouPermissao = !!permissaoValidada && permissaoValidada !== alvoAntes.permissao
    const mudouAtivo = ativo !== undefined && ativo !== alvoAntes.ativo
    const mudouPodeSerGestor = podeSerGestor !== undefined && podeSerGestor !== alvoAntes.podeSerGestor
    const mudouPodeSolicitarParaOutro =
      podeSolicitarParaOutro !== undefined && !!podeSolicitarParaOutro !== alvoAntes.podeSolicitarParaOutro

    if (resetSenha || mudouEmail || mudouPermissao || mudouAtivo || mudouPodeSerGestor || mudouPodeSolicitarParaOutro) {
      data.versaoSessao = { increment: 1 }
    }

    let user
    try {
      user = await prisma.user.update({
        where: { id },
        data,
        select: { id: true, nome: true, email: true, permissao: true, ativo: true, podeSerGestor: true, podeSolicitarParaOutro: true, gestorPadraoId: true, createdAt: true },
      })
    } catch (e) {
      // Corrida entre a checagem de unicidade acima e este UPDATE (outra
      // requisição cadastrou/renomeou para o MESMO e-mail nesse meio-tempo)
      // — a unique constraint do banco é a autoridade final, nunca só o
      // SELECT prévio.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return NextResponse.json({ message: 'Já existe um colaborador cadastrado com este e-mail.' }, { status: 409 })
      }
      throw e
    }

    // `revogouSessao` informa o frontend se ALGUM gatilho disparou nesta
    // chamada — usado para (a) diferenciar o toast quando só o nome mudou
    // (sem menção a revogação) de quando algo sensível mudou, e (b) forçar
    // logout imediato quando o próprio admin edita a própria conta e essa
    // flag vem true (ver ColaboradorModal, src/app/(dashboard)/colaboradores/page.tsx).
    return NextResponse.json(
      { user, revogouSessao: !!data.versaoSessao, ...(senhaTemporaria ? { senhaTemporaria } : {}) },
      { status: 200 }
    )
  } catch (e) {
    console.error(e)
    return NextResponse.json({ message: 'Erro interno no servidor.' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const validacao = await getValidatedMutationSession()
  if (!validacao.valido) return validacao.resposta
  if (!isAdmin(validacao.user)) return NextResponse.json({ message: 'Sem permissão.' }, { status: 403 })

  const bloqueio = assertDemoActionAllowed('colaborador:mutar')
  if (bloqueio) return bloqueio

  const { id } = await params

  if (id === validacao.user.id) {
    return NextResponse.json({ message: 'Você não pode deletar sua própria conta.' }, { status: 400 })
  }

  try {
    await prisma.user.delete({ where: { id } })
    return NextResponse.json({ message: 'Usuário removido.' }, { status: 200 })
  } catch {
    return NextResponse.json(
      { message: 'Não é possível remover este usuário pois há solicitações vinculadas a ele. Desative-o em vez de excluir.' },
      { status: 409 }
    )
  }
}
