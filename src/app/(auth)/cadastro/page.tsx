'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Eye, EyeOff, UserPlus, Loader2, User, Mail, Lock } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { Wordmark } from '@/components/ui/Wordmark'
// Etapa security/input-hardening-b1: `senhaNovaSchema` é a MESMA regra do
// backend (mínimo 8 caracteres, máximo 72 bytes UTF-8, sem exigência de
// complexidade — decisão fechada, nunca maiúscula/número/símbolo
// obrigatórios) — nunca reimplementar a regra aqui, sempre importar.
import { senhaNovaSchema } from '@/lib/validations'

const cadastroSchema = z.object({
  nome: z.string().min(3, 'Nome deve ter pelo menos 3 caracteres').max(120, 'Nome deve ter no máximo 120 caracteres'),
  email: z.string().email('E-mail inválido').max(254, 'E-mail deve ter no máximo 254 caracteres'),
  senha: senhaNovaSchema,
  confirmarSenha: z.string(),
}).refine(d => d.senha === d.confirmarSenha, {
  message: 'As senhas não coincidem',
  path: ['confirmarSenha'],
})

type CadastroForm = z.infer<typeof cadastroSchema>

export default function CadastroPage() {
  const router = useRouter()
  const { toast } = useToast()
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [loading, setLoading] = useState(false)

  const { register, handleSubmit, formState: { errors } } = useForm<CadastroForm>({
    resolver: zodResolver(cadastroSchema),
  })

  async function onSubmit(data: CadastroForm) {
    setLoading(true)
    try {
      const res = await fetch('/api/auth/cadastro', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nome: data.nome, email: data.email, senha: data.senha }),
      })
      const result = await res.json()

      if (!res.ok) {
        toast({ title: 'Erro ao cadastrar', description: result.message, variant: 'destructive' })
        return
      }

      toast({ title: 'Conta criada!', description: 'Faça login para continuar.' })
      router.push('/login')
    } catch {
      toast({ title: 'Erro', description: 'Falha ao conectar com o servidor.', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="bg-white rounded-3xl shadow-[0_20px_50px_-12px_rgba(15,107,99,0.18)] border border-gray-100 px-7 py-9 sm:px-9 sm:py-10">
      {/* Wordmark — mesmo tratamento visual do login. */}
      <div className="text-center mb-8">
        <Wordmark className="text-2xl justify-center mb-5" />
        <h1 className="text-xl font-bold text-gray-900 tracking-tight">Criar conta</h1>
        <p className="text-gray-400 text-sm mt-1.5">Preencha seus dados para começar.</p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div>
          <label htmlFor="nome" className="block text-sm font-medium text-gray-700 mb-1.5">Nome completo</label>
          <div className="relative">
            <User size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            <input
              {...register('nome')}
              id="nome"
              type="text"
              placeholder="Seu nome completo"
              maxLength={120}
              className="w-full pl-11 pr-4 py-3 rounded-xl bg-gray-50 border border-gray-200 text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand focus:bg-white transition"
              autoComplete="name"
            />
          </div>
          {errors.nome && <p className="text-red-600 text-xs mt-1">{errors.nome.message}</p>}
        </div>

        <div>
          <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1.5">E-mail</label>
          <div className="relative">
            <Mail size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            <input
              {...register('email')}
              id="email"
              type="email"
              placeholder="seu.email@empresa.com"
              maxLength={254}
              className="w-full pl-11 pr-4 py-3 rounded-xl bg-gray-50 border border-gray-200 text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand focus:bg-white transition"
              autoComplete="email"
            />
          </div>
          {errors.email && <p className="text-red-600 text-xs mt-1">{errors.email.message}</p>}
        </div>

        <div>
          <label htmlFor="senha" className="block text-sm font-medium text-gray-700 mb-1.5">Senha</label>
          <div className="relative">
            <Lock size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            <input
              {...register('senha')}
              id="senha"
              type={showPassword ? 'text' : 'password'}
              placeholder="Mínimo 8 caracteres"
              minLength={8}
              className="w-full pl-11 pr-11 py-3 rounded-xl bg-gray-50 border border-gray-200 text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand focus:bg-white transition"
              autoComplete="new-password"
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

        <div>
          <label htmlFor="confirmarSenha" className="block text-sm font-medium text-gray-700 mb-1.5">Confirmar senha</label>
          <div className="relative">
            <Lock size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            <input
              {...register('confirmarSenha')}
              id="confirmarSenha"
              type={showConfirmPassword ? 'text' : 'password'}
              placeholder="Repita a senha"
              className="w-full pl-11 pr-11 py-3 rounded-xl bg-gray-50 border border-gray-200 text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand focus:bg-white transition"
              autoComplete="new-password"
            />
            <button
              type="button"
              onClick={() => setShowConfirmPassword(!showConfirmPassword)}
              aria-label={showConfirmPassword ? 'Ocultar senha' : 'Mostrar senha'}
              className="absolute right-3.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition"
            >
              {showConfirmPassword ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
          {errors.confirmarSenha && <p className="text-red-600 text-xs mt-1">{errors.confirmarSenha.message}</p>}
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full flex items-center justify-center gap-2 bg-brand hover:bg-brand-dark text-white font-semibold py-3 rounded-xl transition-all shadow-md hover:shadow-lg hover:-translate-y-0.5 mt-2 disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:translate-y-0"
        >
          {loading ? <Loader2 size={18} className="animate-spin" /> : <UserPlus size={18} />}
          {loading ? 'Criando conta...' : 'Criar conta'}
        </button>
      </form>

      <p className="text-center text-gray-500 text-sm mt-7">
        Já tem conta?{' '}
        <Link href="/login" className="text-highlight hover:text-highlight-dark font-semibold underline decoration-highlight/40 underline-offset-4 transition">
          Entrar
        </Link>
      </p>
    </div>
  )
}
