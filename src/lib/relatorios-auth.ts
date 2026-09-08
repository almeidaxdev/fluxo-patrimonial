// src/lib/relatorios-auth.ts
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { isPatrimonioOuAdmin } from '@/lib/permissions'
import { prisma } from '@/lib/prisma'
import { SessionUser } from '@/types'

// `versaoSessao` propositalmente fora daqui (ver src/lib/session-validation.ts
// para o campo equivalente): esta rota já reconsulta `ativo` + `permissao`
// frescos do banco em toda chamada, sem depender de nenhuma claim do JWT —
// mais forte que a checagem por versão, não precisa dela.
type UsuarioVigenteRelatorios = Omit<SessionUser, 'versaoSessao'>

type AutorizacaoRelatorios =
  | { autorizado: true; user: UsuarioVigenteRelatorios }
  | { autorizado: false; resposta: NextResponse }

const NAO_AUTORIZADO = () => NextResponse.json({ message: 'Não autorizado.' }, { status: 401 })
const SEM_PERMISSAO = () => NextResponse.json({ message: 'Sem permissão.' }, { status: 403 })

/**
 * Guarda server-side compartilhada por TODOS os endpoints de relatórios
 * (resumo, operacional, PDF e futuros exports). Diferente da checagem
 * padrão de rota (que confia só nas claims do cookie, válido por até 24h —
 * Etapa security/session-revocation), aqui o usuário é reconsultado no banco
 * a cada requisição — se ele foi desativado ou perdeu a permissão de
 * patrimônio/administrador, o token antigo deixa de dar acesso
 * imediatamente, sem esperar o cookie expirar.
 */
export async function autorizarRelatorios(): Promise<AutorizacaoRelatorios> {
  const session = await getSession()
  if (!session) return { autorizado: false, resposta: NAO_AUTORIZADO() }

  const usuarioAtual = await prisma.user.findUnique({
    where: { id: session.id },
    select: { id: true, nome: true, email: true, permissao: true, podeSerGestor: true, ativo: true },
  })

  if (!usuarioAtual || !usuarioAtual.ativo) {
    return { autorizado: false, resposta: NAO_AUTORIZADO() }
  }

  const usuarioVigente: UsuarioVigenteRelatorios = {
    id: usuarioAtual.id,
    nome: usuarioAtual.nome,
    email: usuarioAtual.email,
    permissao: usuarioAtual.permissao,
    podeSerGestor: usuarioAtual.podeSerGestor,
  }

  if (!isPatrimonioOuAdmin(usuarioVigente)) {
    return { autorizado: false, resposta: SEM_PERMISSAO() }
  }

  return { autorizado: true, user: usuarioVigente }
}
