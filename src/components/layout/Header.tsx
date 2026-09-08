// src/components/layout/Header.tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Menu, Sun, Moon, User, KeyRound, LogOut, ChevronDown } from 'lucide-react'
import { useTheme } from 'next-themes'
import { SessaoAtual } from '@/types'
import { useToast } from '@/hooks/use-toast'
import { PERMISSAO_LABELS } from '@/types'
import { limparAtividade } from '@/lib/idle-session'

interface HeaderProps {
  user: SessaoAtual
  onMenuClick: () => void
  title: string
}

export function Header({ user, onMenuClick, title }: HeaderProps) {
  const router = useRouter()
  const { toast } = useToast()
  const { theme, setTheme } = useTheme()
  const [dropdownOpen, setDropdownOpen] = useState(false)

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    // Etapa feat/idle-session-timeout, item 8: todo logout EXPLÍCITO também
    // encerra o relógio de inatividade — nunca deixar um timestamp antigo
    // sobrevivendo para a próxima sessão neste navegador.
    limparAtividade(window.localStorage)
    toast({ title: 'Até logo!', description: 'Você saiu do sistema.' })
    router.push('/login')
    router.refresh()
  }

  return (
    <header className="h-[4.25rem] bg-white/90 dark:bg-gray-900/90 backdrop-blur-sm border-b border-gray-100 dark:border-gray-800 shadow-[0_1px_2px_rgba(15,107,99,0.04)] px-4 lg:px-6 flex items-center justify-between sticky top-0 z-30">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <button
          onClick={onMenuClick}
          className="lg:hidden p-2 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 transition shrink-0"
        >
          <Menu size={20} />
        </button>
        {/* min-w-0 no h1 é o que permite truncate funcionar dentro de um
            flex item — sem ele, o item não encolhe abaixo do conteúdo e o
            título nunca trunca, só empurra as ações à direita. `title`
            (atributo nativo) preserva o texto completo como tooltip/leitura
            de tela mesmo quando a linha visível está cortada com "…". */}
        <h1 className="text-lg font-semibold text-gray-900 dark:text-white truncate min-w-0" title={title}>{title}</h1>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {/* Theme toggle */}
        <button
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 transition"
        >
          {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
        </button>

        {/* User menu */}
        <div className="relative">
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            className="flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800 transition"
          >
            <div className="w-8 h-8 rounded-full bg-brand/10 dark:bg-brand/20 flex items-center justify-center">
              <span className="text-brand dark:text-blue-400 font-bold text-sm">{user.nome[0]?.toUpperCase()}</span>
            </div>
            <div className="hidden sm:block text-left">
              <p className="text-sm font-medium text-gray-900 dark:text-white leading-tight">{user.nome.split(' ')[0]}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">{PERMISSAO_LABELS[user.permissao]}</p>
            </div>
            <ChevronDown size={16} className="text-gray-400 hidden sm:block" />
          </button>

          {dropdownOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setDropdownOpen(false)} />
              <div className="absolute right-0 mt-2 w-52 bg-white dark:bg-gray-900 rounded-xl shadow-xl border border-gray-200 dark:border-gray-700 z-50 overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800">
                  <p className="font-semibold text-sm text-gray-900 dark:text-white truncate">{user.nome}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{user.email}</p>
                </div>
                <div className="py-1">
                  <Link
                    href="/minha-conta"
                    onClick={() => setDropdownOpen(false)}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition"
                  >
                    <User size={16} className="text-gray-400" /> Minha conta
                  </Link>
                  <Link
                    href="/alterar-senha"
                    onClick={() => setDropdownOpen(false)}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition"
                  >
                    <KeyRound size={16} className="text-gray-400" /> Alterar senha
                  </Link>
                  <div className="border-t border-gray-100 dark:border-gray-800 my-1" />
                  <button
                    onClick={handleLogout}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 transition"
                  >
                    <LogOut size={16} /> Sair
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  )
}
