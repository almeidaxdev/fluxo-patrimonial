// src/app/api/auth/senha/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getSession } from '@/lib/auth'
import { respostaSessaoInvalida } from '@/lib/session-validation'
import { senhaNovaSchema, senhaDentroDoLimiteBcrypt } from '@/lib/validations'
import { parseJsonBody } from '@/lib/http'
import { assertDemoActionAllowed } from '@/lib/demo-mode'
import bcrypt from 'bcryptjs'

interface AlterarSenhaBody {
  senhaAtual?: string
  novaSenha?: string
}

export async function PATCH(req: NextRequest) {
  // Fluxo Patrimonial — Demo: trocar a própria senha derrubaria o acesso
  // público à demo (o visitante seguinte não conseguiria mais entrar com a
  // credencial compartilhada) — bloqueado incondicionalmente, antes mesmo
  // de checar a sessão.
  const bloqueio = assertDemoActionAllowed('auth:alterar-senha-propria')
  if (bloqueio) return bloqueio

  const session = await getSession()
  // Etapa security/session-revocation: mesma regra de
  // getValidatedMutationSession() (token sem a claim `versaoSessao` — emitido
  // antes desta etapa — nunca tratado como versão 0).
  if (!session || typeof session.versaoSessao !== 'number') {
    return respostaSessaoInvalida()
  }

  try {
    const corpo = await parseJsonBody<AlterarSenhaBody>(req)
    if (!corpo.ok) return corpo.resposta
    const { senhaAtual, novaSenha } = corpo.data

    if (!senhaAtual || !novaSenha) {
      return NextResponse.json(
        { message: 'Senha atual e nova senha são obrigatórias.' },
        { status: 400 }
      )
    }

    // Etapa security/input-hardening-b1: NOVA senha — mínimo 8 caracteres,
    // máximo 72 bytes UTF-8, sem exigência de complexidade (decisão
    // fechada), nunca trim. Mensagens específicas são seguras aqui: o
    // usuário já está autenticado e está DEFININDO uma senha, não
    // autenticando — diferente do caso de `senhaAtual` abaixo.
    const parsedNovaSenha = senhaNovaSchema.safeParse(novaSenha)
    if (!parsedNovaSenha.success) {
      return NextResponse.json(
        { message: parsedNovaSenha.error.errors[0]?.message ?? 'Senha inválida.' },
        { status: 400 }
      )
    }

    // Esta rota já precisa buscar o usuário completo (hash da senha atual,
    // para o bcrypt.compare abaixo) — reaproveitamos a MESMA leitura para
    // validar ativo/versaoSessao, em vez de chamar
    // getValidatedMutationSession() e pagar uma segunda consulta redundante
    // (ver docstring de respostaSessaoInvalida()).
    const user = await prisma.user.findUnique({ where: { id: session.id } })
    if (!user || !user.ativo || user.versaoSessao !== session.versaoSessao) {
      return respostaSessaoInvalida()
    }

    // `senhaAtual` segue a regra de LOGIN — sem mínimo de 8 (compatibilidade
    // com uma senha atual legada mais curta), só o teto de 72 bytes,
    // verificado ANTES de bcrypt.compare() para nunca gastar o hash com um
    // input impossível. Dobrado na MESMA mensagem "Senha atual incorreta."
    // já usada para qualquer senha errada — nunca uma mensagem distinta que
    // revelaria que o tamanho (não o conteúdo) foi o motivo da rejeição.
    if (!senhaDentroDoLimiteBcrypt(senhaAtual)) {
      return NextResponse.json(
        { message: 'Senha atual incorreta.' },
        { status: 400 }
      )
    }

    const senhaCorreta = await bcrypt.compare(senhaAtual, user.senha)
    if (!senhaCorreta) {
      return NextResponse.json(
        { message: 'Senha atual incorreta.' },
        { status: 400 }
      )
    }

    const novaHash = await bcrypt.hash(parsedNovaSenha.data, 12)
    await prisma.user.update({
      where: { id: session.id },
      // Etapa security/session-revocation: alterar a própria senha
      // incrementa a versão de sessão — a sessão que realizou a troca
      // também fica com uma claim desatualizada a partir daqui, então
      // limpamos o cookie abaixo e pedimos novo login (nunca deixamos o
      // usuário numa sessão já revogada por baixo dos panos).
      data: { senha: novaHash, versaoSessao: { increment: 1 } },
    })

    const resposta = NextResponse.json(
      { message: 'Senha alterada com sucesso. Faça login novamente.' },
      { status: 200 }
    )
    resposta.cookies.delete('session')
    return resposta
  } catch (e) {
    console.error(e)
    return NextResponse.json({ message: 'Erro interno no servidor.' }, { status: 500 })
  }
}
