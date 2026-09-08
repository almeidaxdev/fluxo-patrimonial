// src/hooks/use-session.ts
'use client'

// Etapa fix/collaborator-session-sync: antes, este hook fazia seu PRÓPRIO
// fetch('/api/auth/me') isolado a cada página que o usa — redundante com a
// revalidação já feita pelo AuthProvider (montagem/foco/aba visível), que
// envolve toda a árvore autenticada. Agora é só um repasse fino do contexto
// já existente, mesma assinatura pública ({ user, loading }) para não exigir
// nenhuma mudança nas páginas que já o consomem.
import { useAuth } from '@/components/auth/AuthProvider'

export function useSession() {
  const { user, loading } = useAuth()
  return { user, loading }
}
