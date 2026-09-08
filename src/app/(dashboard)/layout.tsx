// src/app/(dashboard)/layout.tsx
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { AuthProvider } from '@/components/auth/AuthProvider'
import { DashboardShell } from '@/components/layout/DashboardShell'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session) redirect('/login')

  // Etapa fix/collaborator-session-sync: só as claims do JWT — de propósito
  // sem consulta ao banco aqui (mantém o custo de toda navegação/SSR igual
  // ao de antes desta etapa). `ativo: true` é otimista (o valor real só é
  // confirmado no primeiro round-trip real, feito pelo AuthProvider no
  // client, milissegundos depois do mount) — nunca fica assim por muito
  // tempo se estiver errado. Ver AuthProvider para o mecanismo completo de
  // revalidação (montagem, foco da janela, aba visível).
  const initialUser = {
    id: session.id,
    nome: session.nome,
    email: session.email,
    permissao: session.permissao,
    podeSerGestor: session.podeSerGestor,
    podeSolicitarParaOutro: session.podeSolicitarParaOutro,
    ativo: true as const,
  }

  return (
    <AuthProvider initialUser={initialUser}>
      <DashboardShell>{children}</DashboardShell>
    </AuthProvider>
  )
}
