'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Mail, Lock, Eye, EyeOff, ArrowRight, Loader2, Sparkles } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { registrarAtividade } from '@/lib/idle-session'
import { Wordmark } from '@/components/ui/Wordmark'
import { useDemoMode } from '@/hooks/use-demo-mode'

const loginSchema = z.object({
  email: z.string().email('E-mail inválido'),
  senha: z.string().min(1, 'Senha obrigatória'),
})

type LoginForm = z.infer<typeof loginSchema>

export default function LoginPage() {
  const router = useRouter()
  const { toast } = useToast()
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [demoLoading, setDemoLoading] = useState(false)
  const demoModeAtivo = useDemoMode()

  const { register, handleSubmit, formState: { errors } } = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
  })

  // Guarda contra o aviso aparecer duas vezes — React Strict Mode (ativo por
  // padrão no Next.js em dev) invoca todo useEffect duas vezes de propósito
  // (monta → limpa → monta de novo) para expor efeitos não-idempotentes;
  // sem essa guarda, o toast abaixo disparava duplicado num homologação real
  // em `next dev`. Um ref (não state) porque não deve causar re-render nem
  // ser resetado entre essas duas invocações da mesma instância do
  // componente.
  const avisoRevogacaoJaExibidoRef = useRef(false)
  // Etapa feat/idle-session-timeout: mesma guarda, para o aviso de
  // "?inatividade=1" (ver efeito abaixo) — motivo DIFERENTE de "?revogada=1",
  // nunca reaproveitando o mesmo parâmetro/mensagem para os dois casos.
  const avisoInatividadeJaExibidoRef = useRef(false)

  // Etapa fix/collaborator-session-sync: AuthProvider redireciona para cá
  // com "?revogada=1" quando uma sessão é encerrada por revalidação (não
  // por expiração natural do JWT) — permissão/capacidade removida, conta
  // desativada, senha/e-mail alterados etc. Lido via window.location (não
  // useSearchParams()) para não exigir um <Suspense> nesta página só por
  // causa deste aviso pontual. Mensagem deliberadamente genérica — nunca
  // revela qual foi o motivo real (mesmo princípio de
  // respostaSessaoInvalida(), src/lib/session-validation.ts).
  //
  // Etapa feat/idle-session-timeout: mesmo padrão para "?inatividade=1",
  // disparado pelo logout automático por 1h sem atividade
  // (AuthProvider.encerrarPorInatividade()) — motivo distinto, mensagem
  // própria, nunca misturado com "?revogada=1" no mesmo parâmetro.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)

    if (!avisoRevogacaoJaExibidoRef.current && params.get('revogada') === '1') {
      avisoRevogacaoJaExibidoRef.current = true
      toast({
        title: 'Sessão encerrada',
        description: 'Sua sessão expirou ou suas permissões foram atualizadas. Entre novamente para continuar.',
      })
      // Remove o parâmetro da URL depois de exibir o aviso — além de reforçar
      // a guarda acima (uma 2ª invocação do efeito não encontra mais
      // "revogada=1" para ler), evita que um F5 manual na mesma URL reexiba
      // o toast a cada refresh.
      window.history.replaceState(null, '', window.location.pathname)
    }

    if (!avisoInatividadeJaExibidoRef.current && params.get('inatividade') === '1') {
      avisoInatividadeJaExibidoRef.current = true
      toast({
        title: 'Sessão encerrada por inatividade',
        description: 'Por segurança, entre novamente para continuar.',
      })
      window.history.replaceState(null, '', window.location.pathname)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function onSubmit(data: LoginForm) {
    setLoading(true)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      const result = await res.json()

      if (!res.ok) {
        toast({ title: 'Erro ao entrar', description: result.message, variant: 'destructive' })
        return
      }

      // Etapa feat/idle-session-timeout, item 8: login bem-sucedido inicia
      // o relógio da NOVA sessão — nunca herda um timestamp antigo que
      // porventura tenha sobrevivido no navegador (ex.: aba fechada sem
      // logout explícito, JWT expirado naturalmente sem passar por
      // /api/auth/logout).
      registrarAtividade(window.localStorage)
      toast({ title: 'Bem-vindo!', description: `Olá, ${result.user.nome}!` })
      router.push('/lobby')
      router.refresh()
    } catch {
      toast({ title: 'Erro', description: 'Falha ao conectar com o servidor.', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  // "Acessar demonstração" (Fluxo Patrimonial — Demo): autentica direto na
  // conta demonstrativa via POST /api/demo/entrar, sem pedir e-mail/senha.
  // Só visível quando demoModeAtivo (useDemoMode() consulta
  // GET /api/demo/status) — a proteção real de qualquer ação sensível
  // continua sendo server-side, independentemente deste botão existir.
  async function onAcessarDemo() {
    setDemoLoading(true)
    try {
      const res = await fetch('/api/demo/entrar', { method: 'POST' })
      const result = await res.json()

      if (!res.ok) {
        toast({ title: 'Erro ao entrar', description: result.message, variant: 'destructive' })
        return
      }

      registrarAtividade(window.localStorage)
      toast({ title: 'Bem-vindo à demonstração!', description: `Olá, ${result.user.nome}!` })
      router.push('/lobby')
      router.refresh()
    } catch {
      toast({ title: 'Erro', description: 'Falha ao conectar com o servidor.', variant: 'destructive' })
    } finally {
      setDemoLoading(false)
    }
  }

  return (
    <div className="bg-white rounded-3xl shadow-[0_20px_50px_-12px_rgba(15,107,99,0.18)] border border-gray-100 px-6 py-7 sm:px-9 sm:py-10">
      {/* Cabeçalho: wordmark — único no mobile, ver src/app/(auth)/layout.tsx —
          + título + subtítulo discreto. */}
      <div className="text-center mb-6 sm:mb-8">
        <Wordmark className="text-2xl justify-center mb-4 sm:mb-5" />
        <h1 className="text-xl font-bold text-gray-900 tracking-tight">Acesse sua conta</h1>
        <p className="text-gray-400 text-sm mt-1.5">Entre com seu e-mail e senha para continuar.</p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {/* Email */}
        <div>
          <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1.5">E-mail</label>
          <div className="relative">
            <Mail size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            <input
              {...register('email')}
              id="email"
              type="email"
              placeholder="seu.email@empresa.com"
              className="w-full pl-11 pr-4 py-3 rounded-xl bg-gray-50 border border-gray-200 text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand focus:bg-white transition"
              autoComplete="email"
            />
          </div>
          {errors.email && <p className="text-red-600 text-xs mt-1">{errors.email.message}</p>}
        </div>

        {/* Senha */}
        <div>
          <label htmlFor="senha" className="block text-sm font-medium text-gray-700 mb-1.5">Senha</label>
          <div className="relative">
            <Lock size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            <input
              {...register('senha')}
              id="senha"
              type={showPassword ? 'text' : 'password'}
              placeholder="Digite sua senha"
              className="w-full pl-11 pr-11 py-3 rounded-xl bg-gray-50 border border-gray-200 text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand focus:bg-white transition"
              autoComplete="current-password"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
              className="absolute right-3.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition"
            >
              {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
          {errors.senha && <p className="text-red-600 text-xs mt-1">{errors.senha.message}</p>}
        </div>

        {/* Botão */}
        <button
          type="submit"
          disabled={loading}
          className="w-full flex items-center justify-center gap-2 bg-brand hover:bg-brand-dark text-white font-semibold py-3 rounded-xl transition-all shadow-md hover:shadow-lg hover:-translate-y-0.5 disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:translate-y-0 mt-2"
        >
          {loading ? <Loader2 size={18} className="animate-spin" /> : <ArrowRight size={18} />}
          {loading ? 'Entrando...' : 'Entrar'}
        </button>
      </form>

      {demoModeAtivo && (
        <>
          <div className="flex items-center gap-3 my-6">
            <span className="h-px flex-1 bg-gray-200" />
            <span className="text-xs text-gray-400 font-medium">ou</span>
            <span className="h-px flex-1 bg-gray-200" />
          </div>
          <button
            type="button"
            onClick={onAcessarDemo}
            disabled={demoLoading}
            className="w-full flex items-center justify-center gap-2 border border-highlight/40 text-highlight-dark hover:bg-highlight/5 font-semibold py-3 rounded-xl transition-all disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {demoLoading ? <Loader2 size={18} className="animate-spin" /> : <Sparkles size={18} />}
            {demoLoading ? 'Entrando na demonstração...' : 'Acessar demonstração'}
          </button>
        </>
      )}

      {demoModeAtivo ? (
        // Ambiente de demonstração: autocadastro é bloqueado server-side
        // (POST /api/auth/cadastro, ver src/lib/demo-mode.ts) — mostrar o
        // link aqui só confundiria o visitante com um caminho que sempre
        // termina em 403. Texto discreto no lugar, nunca os dois ao mesmo
        // tempo.
        <p className="text-center text-gray-400 text-xs mt-6 sm:mt-7">
          Ambiente demonstrativo com dados fictícios.
        </p>
      ) : (
        <p className="text-center text-gray-500 text-sm mt-6 sm:mt-7">
          Novo por aqui?{' '}
          <Link href="/cadastro" className="text-highlight hover:text-highlight-dark font-semibold underline decoration-highlight/40 underline-offset-4 transition">
            Cadastre-se
          </Link>
        </p>
      )}
    </div>
  )
}
