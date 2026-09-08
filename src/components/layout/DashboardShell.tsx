// src/components/layout/DashboardShell.tsx
'use client'

import { useState } from 'react'
import { usePathname } from 'next/navigation'
import { useAuth } from '@/components/auth/AuthProvider'
import { Sidebar } from './Sidebar'
import { Header } from './Header'

const pageTitles: Record<string, string> = {
  '/lobby': 'Dashboard',
  '/nova-solicitacao': 'Nova Solicitação',
  '/minhas-solicitacoes': 'Minhas Solicitações',
  '/todas-solicitacoes': 'Todas as Solicitações',
  '/aprovacoes': 'Aprovações de Atividades Externas',
  '/pendencias': 'Pendências',
  '/atendimento-imediato': 'Atendimento Imediato',
  '/relatorios': 'Relatórios',
  '/patrimonios': 'Bens Patrimoniais',
  '/categorias': 'Categorias de Patrimônio',
  '/colaboradores': 'Colaboradores',
  '/minha-conta': 'Minha Conta',
  '/alterar-senha': 'Alterar Senha',
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const pathname = usePathname()
  const { user } = useAuth()
  // Etapa feat/patrimonio-operational-ux: /lobby é o mesmo destino para
  // todos os perfis, mas o CONTEÚDO já é role-aware (ver lobby/page.tsx) —
  // o título segue a mesma regra, em vez de "Dashboard" genérico para quem
  // vê o painel operacional do Patrimônio.
  const title =
    pathname === '/lobby' && user?.permissao === 'patrimonio'
      ? 'Painel do Patrimônio'
      : pageTitles[pathname] ||
        (pathname.startsWith('/solicitacoes/') ? 'Detalhe da Solicitação' : 'Fluxo Patrimonial')

  // `user` só fica `null` durante a janela (poucos ms) entre uma
  // revalidação detectar sessão revogada e o redirect para /login
  // completar (AuthProvider.revogarSessao()) — nunca em uso normal.
  if (!user) return null

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar user={user} open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <Header user={user} onMenuClick={() => setSidebarOpen(true)} title={title} />
        <main className="flex-1 overflow-y-auto p-4 lg:p-6">
          <div className="animate-fade-in">
            {children}
          </div>
        </main>
      </div>
    </div>
  )
}
