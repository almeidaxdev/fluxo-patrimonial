// src/lib/session-validation.ts
//
// Etapa security/session-revocation — revalidação server-side de sessão
// para rotas de MUTAÇÃO (POST/PATCH/PUT/DELETE de negócio). Diferente de
// `getSession()` (src/lib/auth.ts — só verifica assinatura/expiração do
// JWT, nunca toca o banco, usado em toda leitura/navegação comum),
// `getValidatedMutationSession()` reconsulta o usuário no banco A CADA
// CHAMADA e confirma que:
//
//   1. o usuário ainda existe;
//   2. `ativo === true`;
//   3. `versaoSessao` do banco === `versaoSessao` da claim do JWT.
//
// Qualquer divergência (usuário removido/desativado, ou `versaoSessao`
// incrementada por uma mudança de segurança — senha, permissao,
// podeSerGestor, podeSolicitarParaOutro, ativo — desde que este token foi
// emitido) invalida a sessão IMEDIATAMENTE para ações de mutação, mesmo que
// o JWT ainda não tenha expirado (até 24h). Isso é deliberadamente NÃO
// aplicado a todo GET/navegação (ver docs/ARQUITETURA.md, seção "Revogação
// de sessão", para a lista completa de rotas revalidadas e o racional de
// performance).
//
// UMA ÚNICA consulta ao banco por chamada — o mesmo `select` já devolve os
// campos de AUTORIZAÇÃO atuais (`permissao`, `podeSerGestor`,
// `podeSolicitarParaOutro`), então a rota nunca precisa de uma segunda
// query separada só para decidir permissão: use sempre o `user` devolvido
// aqui (nunca a `session`/JWT bruta) em `isPatrimonioOuAdmin()`/`isAdmin()`/
// `podeAtuarComoGestor()`/`podeSolicitarParaOutro()` daqui pra frente.

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getSession } from '@/lib/auth'
import type { SessionUser } from '@/types'

/**
 * Usuário revalidado — mesmo formato de `SessionUser`, sem `versaoSessao`
 * (não é mais relevante depois da validação), acrescido de `gestorPadraoId`
 * (Etapa fix/default-manager-self-request — dado do PRÓPRIO usuário
 * autenticado, nunca colocado na claim do JWT porque não é usado para
 * autorização, só como valor inicial de formulário; por isso só existe aqui,
 * vindo de uma consulta fresca ao banco, nunca do token decodificado).
 */
export type ValidatedUser = Omit<SessionUser, 'versaoSessao'> & { gestorPadraoId: string | null }

export type ResultadoValidacaoSessao = { valido: true; user: ValidatedUser } | { valido: false; resposta: NextResponse }

const MENSAGEM_SESSAO_INVALIDA = 'Sessão inválida ou expirada. Faça login novamente.'

/**
 * Resposta 401 padronizada para sessão inválida/revogada — nunca revela o
 * motivo real (usuário desativado, versão divergente, permissão alterada,
 * senha resetada) para não expor informação interna nem permitir
 * enumeração. Limpa o cookie `session` centralmente aqui — nenhuma rota
 * precisa repetir essa lógica.
 *
 * Exportada (não só usada internamente por `getValidatedMutationSession()`)
 * para rotas que JÁ fazem seu próprio `prisma.user.findUnique(...)` por
 * outro motivo (ex.: `PATCH /api/auth/senha`, que precisa do hash da senha
 * atual) — essas rotas validam `ativo`/`versaoSessao` inline, sobre o
 * MESMO resultado que já buscaram, em vez de chamar
 * `getValidatedMutationSession()` e pagar uma segunda consulta redundante.
 */
export function respostaSessaoInvalida(): NextResponse {
  const resposta = NextResponse.json({ message: MENSAGEM_SESSAO_INVALIDA }, { status: 401 })
  resposta.cookies.delete('session')
  return resposta
}

export async function getValidatedMutationSession(): Promise<ResultadoValidacaoSessao> {
  const session = await getSession()
  if (!session) return { valido: false, resposta: respostaSessaoInvalida() }

  // Token emitido ANTES desta etapa (sem a claim `versaoSessao`) — NUNCA
  // tratado como versão 0 por conveniência (ver comentário completo em
  // SessionUser.versaoSessao, src/types/index.ts — decisão deliberada,
  // sem fallback `?? 0`). Rejeitado aqui, antes mesmo de consultar o banco.
  if (typeof session.versaoSessao !== 'number') {
    return { valido: false, resposta: respostaSessaoInvalida() }
  }

  // ÚNICA consulta — já traz tudo que qualquer rota de mutação precisa
  // (existência/ativo/versão para validar a sessão, e permissao/
  // podeSerGestor/podeSolicitarParaOutro para autorizar a ação em seguida).
  const user = await prisma.user.findUnique({
    where: { id: session.id },
    select: {
      id: true,
      nome: true,
      email: true,
      permissao: true,
      ativo: true,
      podeSerGestor: true,
      podeSolicitarParaOutro: true,
      versaoSessao: true,
      gestorPadraoId: true,
    },
  })

  if (!user || !user.ativo) return { valido: false, resposta: respostaSessaoInvalida() }
  if (user.versaoSessao !== session.versaoSessao) return { valido: false, resposta: respostaSessaoInvalida() }

  return {
    valido: true,
    user: {
      id: user.id,
      nome: user.nome,
      email: user.email,
      permissao: user.permissao,
      podeSerGestor: user.podeSerGestor,
      podeSolicitarParaOutro: user.podeSolicitarParaOutro,
      gestorPadraoId: user.gestorPadraoId,
    },
  }
}
