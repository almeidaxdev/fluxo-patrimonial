// src/app/api/auth/me/route.ts
import { NextResponse } from 'next/server'
import { getValidatedMutationSession } from '@/lib/session-validation'

// Etapa fix/collaborator-session-sync: antes desta etapa, esta rota só
// verificava assinatura/expiração do JWT (getSession()) — um usuário
// desativado ou com permissão/capacidade removida continuava vendo os dados
// ANTIGOS aqui até o token expirar (até 24h), mesmo já sendo bloqueado nas
// mutações pela S5. Agora reusa getValidatedMutationSession() (a MESMA
// revalidação — 1 única consulta ao banco — já usada pelas rotas de
// mutação): usuário inexistente, `ativo === false` ou `versaoSessao`
// divergente da claim do token retornam 401 com a mesma mensagem genérica e
// o mesmo cookie limpo — nunca revelando o motivo real. Isso é o que
// permite ao frontend (AuthProvider, src/components/auth/AuthProvider.tsx)
// detectar uma sessão revogada ao revalidar (inicialização, foco da janela,
// aba voltando a ficar visível) e forçar novo login, em vez de continuar
// exibindo permissões desatualizadas. Ver docs/ARQUITETURA.md, seção
// "Revogação de sessão".
export async function GET() {
  const validacao = await getValidatedMutationSession()
  if (!validacao.valido) return validacao.resposta

  // `ativo` não vem de ValidatedUser (omitido por ser, por construção,
  // sempre `true` quando a validação passa — ver session-validation.ts) mas
  // é explicitamente devolvido aqui porque o frontend usa este endpoint como
  // fonte de verdade dos dados ATUAIS da conta, não só como um "ping" de
  // validade de sessão.
  return NextResponse.json({ user: { ...validacao.user, ativo: true } }, { status: 200 })
}
