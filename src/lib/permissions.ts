// src/lib/permissions.ts
import { SessionUser } from '@/types'

// Aceita tanto `SessionUser` (claims do JWT, potencialmente desatualizadas)
// quanto o usuário revalidado por `getValidatedMutationSession()`
// (src/lib/session-validation.ts, sempre lido do banco na hora) — nunca
// exige `versaoSessao`/`id`/`nome`/`email`, únicos campos que os dois
// formatos não compartilham exatamente. Etapa security/session-revocation:
// rotas que revalidam devem SEMPRE passar o usuário revalidado aqui, nunca
// a `session` bruta, para que uma mudança de `permissao`/`podeSerGestor`/
// `podeSolicitarParaOutro` já persistida no banco valha imediatamente.
export type PermissaoAvaliavel = Pick<SessionUser, 'permissao' | 'podeSerGestor' | 'podeSolicitarParaOutro'>

export function isPatrimonioOuAdmin(user: PermissaoAvaliavel): boolean {
  return user.permissao === 'patrimonio' || user.permissao === 'administrador'
}

export function isAdmin(user: PermissaoAvaliavel): boolean {
  return user.permissao === 'administrador'
}

/** Gestor = permissão adicional (podeSerGestor), independente do campo `permissao`. */
export function podeAtuarComoGestor(user: PermissaoAvaliavel): boolean {
  return !!user.podeSerGestor
}

/**
 * "Solicitar para outro colaborador" (POST /api/solicitacoes com
 * solicitanteId !== session.id) — permitido para:
 *   - Patrimônio/Administrador (responsabilidade operacional já existente);
 *   - Gestor (podeSerGestor);
 *   - qualquer colaborador com a CAPACIDADE explícita
 *     `user.podeSolicitarParaOutro === true`, concedida individualmente por
 *     um Administrador (PATCH /api/colaboradores/[id]) — NÃO é um perfil
 *     novo, NÃO reaproveita podeSerGestor, e NÃO libera nenhuma outra
 *     permissão (aprovação de gestor, Patrimônio, Administração,
 *     Atendimento Imediato). Regra de negócio aprovada — ver
 *     docs/REGRAS_DE_NEGOCIO.md.
 */
export function podeSolicitarParaOutro(user: PermissaoAvaliavel): boolean {
  if (isPatrimonioOuAdmin(user)) return true
  if (podeAtuarComoGestor(user)) return true
  if (user.podeSolicitarParaOutro === true) return true
  return false
}
