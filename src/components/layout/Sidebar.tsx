// src/components/layout/Sidebar.tsx
'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard, FilePlus2, ClipboardList, CalendarRange,
  HardDrive, Users, X, ChevronRight, CheckSquare, ListTodo, Tags, Zap, BarChart3
} from 'lucide-react'
import { SessaoAtual } from '@/types'
import { cn } from '@/utils'
import { APP_VERSION, APP_COPYRIGHT_YEAR } from '@/lib/version'
import { Wordmark } from '@/components/ui/Wordmark'

interface SidebarProps {
  user: SessaoAtual
  open: boolean
  onClose: () => void
}

interface NavItem {
  href: string
  icon: React.ReactNode
  label: string
  roles: Array<'colaborador' | 'patrimonio' | 'administrador'>
  gestorOnly?: boolean
}

const navItems: NavItem[] = [
  { href: '/lobby', icon: <LayoutDashboard size={20} />, label: 'Dashboard', roles: ['colaborador', 'patrimonio', 'administrador'] },
  // Etapa feat/patrimonio-operational-ux: "Nova Solicitação" e "Minhas
  // Solicitações" são funcionalidades PESSOAIS de colaborador (criar/ver a
  // própria reserva) — sem sentido operacional para o perfil PATRIMONIO, que
  // atua sobre as solicitações de TODOS (Pendências, Todas as Solicitações,
  // Atendimento Imediato), nunca sobre uma reserva própria. Removido daqui
  // (`roles` sem 'patrimonio') E bloqueado por URL direta no middleware
  // (src/middleware.ts, PATRIMONIO_PAGINAS_PESSOAIS_RESTRITAS) — esconder só
  // o link nunca é suficiente. ADMINISTRADOR continua vendo os dois.
  { href: '/nova-solicitacao', icon: <FilePlus2 size={20} />, label: 'Nova Solicitação', roles: ['colaborador', 'administrador'] },
  { href: '/minhas-solicitacoes', icon: <ClipboardList size={20} />, label: 'Minhas Solicitações', roles: ['colaborador', 'administrador'] },
  { href: '/aprovacoes', icon: <CheckSquare size={20} />, label: 'Aprovações', roles: ['colaborador', 'patrimonio', 'administrador'], gestorOnly: true },
  { href: '/todas-solicitacoes', icon: <CalendarRange size={20} />, label: 'Todas as Solicitações', roles: ['patrimonio', 'administrador'] },
  { href: '/pendencias', icon: <ListTodo size={20} />, label: 'Pendências', roles: ['patrimonio', 'administrador'] },
  { href: '/atendimento-imediato', icon: <Zap size={20} />, label: 'Atendimento Imediato', roles: ['patrimonio', 'administrador'] },
  { href: '/relatorios', icon: <BarChart3 size={20} />, label: 'Relatórios', roles: ['patrimonio', 'administrador'] },
  { href: '/patrimonios', icon: <HardDrive size={20} />, label: 'Bens Patrimoniais', roles: ['patrimonio', 'administrador'] },
  { href: '/categorias', icon: <Tags size={20} />, label: 'Categorias', roles: ['administrador'] },
  { href: '/colaboradores', icon: <Users size={20} />, label: 'Colaboradores', roles: ['administrador'] },
]

export function Sidebar({ user, open, onClose }: SidebarProps) {
  const pathname = usePathname()
  const filtered = navItems.filter((i) => {
    if (!i.roles.includes(user.permissao)) return false
    if (i.gestorOnly && !user.podeSerGestor && user.permissao !== 'administrador') return false
    return true
  })

  return (
    <>
      {/* Overlay mobile */}
      {open && (
        <div className="fixed inset-0 bg-black/50 z-40 lg:hidden" onClick={onClose} />
      )}

      <aside className={cn(
        'fixed top-0 left-0 h-full w-64 bg-gradient-to-b from-brand to-brand-dark dark:from-brand-dark dark:to-gray-950 z-50 flex flex-col transition-transform duration-300',
        'lg:translate-x-0 lg:static lg:z-auto',
        open ? 'translate-x-0' : '-translate-x-full'
      )}>
        {/* Wordmark — identidade textual (sem logo/ícone na v1), variante
            "inverted" para contraste sobre o fundo escuro da sidebar. */}
        <div className="flex items-center justify-between px-5 py-5 border-b border-white/10">
          <Wordmark variant="inverted" className="text-base" />
          <button onClick={onClose} className="lg:hidden text-blue-300 hover:text-white transition">
            <X size={20} />
          </button>
        </div>

        {/* User info */}
        <div className="px-4 py-4 border-b border-white/10">
          <div className="flex items-center gap-3 px-2.5 py-2.5 rounded-xl bg-white/5">
            <div className="w-9 h-9 rounded-full bg-highlight/25 ring-2 ring-white/10 flex items-center justify-center shrink-0">
              <span className="text-highlight font-bold text-sm">{user.nome[0]?.toUpperCase()}</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-white text-sm font-medium truncate">{user.nome}</p>
              <p className="text-blue-300 text-xs capitalize">{user.permissao}</p>
            </div>
          </div>
        </div>

        {/* Nav — item ativo (Etapa redesign-global, item 8): fundo azul
            mais claro + indicador laranja lateral fino, em vez de um
            preenchimento laranja sólido — mesma linguagem de "detalhe
            laranja discreto" já usada no login, nunca uma massa de cor. */}
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto scrollbar-thin">
          {filtered.map((item) => {
            const active = pathname === item.href
            // Etapa feat/patrimonio-operational-ux: mesmo destino (/lobby),
            // identidade própria — para quem usa o sistema só operacionalmente
            // (permissao === 'patrimonio'), o rótulo reflete o que a página
            // de fato mostra para esse perfil (ver lobby/page.tsx). Nunca uma
            // rota nova: evita qualquer risco de loop de redirect.
            const label = item.href === '/lobby' && user.permissao === 'patrimonio' ? 'Painel do Patrimônio' : item.label
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onClose}
                className={cn(
                  'relative flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 group',
                  active
                    ? 'bg-white/10 text-white'
                    : 'text-blue-200 hover:bg-white/5 hover:text-white'
                )}
              >
                {active && <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-1 rounded-r-full bg-highlight" />}
                <span className={cn('shrink-0 transition-transform duration-200 group-hover:translate-x-0.5', active && 'text-highlight')}>{item.icon}</span>
                <span className="flex-1 transition-transform duration-200 group-hover:translate-x-0.5">{label}</span>
                {active && <ChevronRight size={16} className="opacity-70" />}
              </Link>
            )
          })}
        </nav>

        {/* Footer — versão única (src/lib/version.ts), nunca hardcoded
            espalhada. */}
        <div className="px-4 py-4 border-t border-white/10">
          <p className="text-blue-400 text-xs text-center">v{APP_VERSION} — Fluxo Patrimonial © {APP_COPYRIGHT_YEAR}</p>
        </div>
      </aside>
    </>
  )
}
