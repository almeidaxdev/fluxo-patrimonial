// src/app/(dashboard)/alterar-senha/page.tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { KeyRound, Eye, EyeOff, Loader2, CheckCircle2 } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
// Etapa security/input-hardening-b1: `senhaNovaSchema` é a MESMA regra do
// backend (mínimo 8 caracteres, máximo 72 bytes UTF-8, sem exigência de
// complexidade — decisão fechada) — nunca reimplementar aqui. `senhaAtual`
// segue a regra de LOGIN (sem mínimo de 8, compatibilidade com senha atual
// legada) — só checagem de não-vazio, feita pelo próprio `min(1)` abaixo.
import { senhaNovaSchema } from '@/lib/validations'

const schema = z
  .object({
    senhaAtual: z.string().min(1, 'Informe a senha atual'),
    novaSenha: senhaNovaSchema,
    confirmarSenha: z.string().min(1, 'Confirme a nova senha'),
  })
  .refine((d) => d.novaSenha === d.confirmarSenha, {
    message: 'As senhas não coincidem',
    path: ['confirmarSenha'],
  })

type FormData = z.infer<typeof schema>

interface AlterarSenhaResponse {
  message?: string
}

export default function AlterarSenhaPage() {
  const { toast } = useToast()
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)
  const [showSenhaAtual, setShowSenhaAtual] = useState(false)
  const [showNovaSenha, setShowNovaSenha] = useState(false)

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormData>({ resolver: zodResolver(schema) })

  async function onSubmit(data: FormData) {
    setLoading(true)
    setSuccess(false)
    try {
      const res = await fetch('/api/auth/senha', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          senhaAtual: data.senhaAtual,
          novaSenha: data.novaSenha,
        }),
      })

      const result = (await res.json()) as AlterarSenhaResponse

      if (!res.ok) {
        toast({
          title: 'Erro ao alterar senha',
          description: result.message,
          variant: 'destructive',
        })
        return
      }

      // Etapa security/session-revocation: o backend já incrementou a
      // versão de sessão e limpou o cookie — a sessão atual não é mais
      // válida para nenhuma ação protegida. Nunca deixar o usuário
      // navegando com essa sensação de "ainda logado" — redireciona para
      // o login logo após ele ver a confirmação.
      toast({ title: 'Senha alterada com sucesso!', description: 'Faça login novamente.' })
      setSuccess(true)
      reset()
      setTimeout(() => router.push('/login'), 1500)
    } catch {
      toast({
        title: 'Erro',
        description: 'Falha ao conectar com o servidor.',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-md space-y-6">
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 bg-brand/10 dark:bg-brand/20 rounded-xl flex items-center justify-center">
            <KeyRound size={18} className="text-brand dark:text-blue-400" />
          </div>
          <div>
            <h2 className="font-bold text-gray-900 dark:text-white">Alterar senha</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              Use uma senha com pelo menos 8 caracteres
            </p>
          </div>
        </div>

        {success && (
          <div className="mb-5 flex items-center gap-3 p-3 bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 rounded-xl text-sm text-green-700 dark:text-green-300 animate-fade-in">
            <CheckCircle2 size={16} className="shrink-0" />
            Senha alterada com sucesso! Redirecionando para o login...
          </div>
        )}

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {/* Senha atual */}
          <div>
            <label htmlFor="senhaAtual" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
              Senha atual
            </label>
            <div className="relative">
              <input
                {...register('senhaAtual')}
                id="senhaAtual"
                type={showSenhaAtual ? 'text' : 'password'}
                placeholder="••••••••"
                autoComplete="current-password"
                className="w-full px-4 py-2.5 pr-11 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition"
              />
              <button
                type="button"
                onClick={() => setShowSenhaAtual(!showSenhaAtual)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition"
              >
                {showSenhaAtual ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {errors.senhaAtual && (
              <p className="text-red-500 text-xs mt-1">{errors.senhaAtual.message}</p>
            )}
          </div>

          {/* Nova senha */}
          <div>
            <label htmlFor="novaSenha" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
              Nova senha
            </label>
            <div className="relative">
              <input
                {...register('novaSenha')}
                id="novaSenha"
                type={showNovaSenha ? 'text' : 'password'}
                placeholder="Mínimo 8 caracteres"
                minLength={8}
                autoComplete="new-password"
                className="w-full px-4 py-2.5 pr-11 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition"
              />
              <button
                type="button"
                onClick={() => setShowNovaSenha(!showNovaSenha)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition"
              >
                {showNovaSenha ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {errors.novaSenha && (
              <p className="text-red-500 text-xs mt-1">{errors.novaSenha.message}</p>
            )}
          </div>

          {/* Confirmar */}
          <div>
            <label htmlFor="confirmarSenha" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
              Confirmar nova senha
            </label>
            <input
              {...register('confirmarSenha')}
              id="confirmarSenha"
              type={showNovaSenha ? 'text' : 'password'}
              placeholder="Repita a nova senha"
              autoComplete="new-password"
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition"
            />
            {errors.confirmarSenha && (
              <p className="text-red-500 text-xs mt-1">{errors.confirmarSenha.message}</p>
            )}
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 bg-brand hover:bg-brand-dark text-white font-semibold py-2.5 rounded-xl transition-all shadow-sm disabled:opacity-60 disabled:cursor-not-allowed mt-2"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <KeyRound size={16} />}
            {loading ? 'Salvando...' : 'Alterar senha'}
          </button>
        </form>
      </div>

      {/* Dica — Etapa security/input-hardening-b1: nunca afirmar uma regra
          de complexidade que o backend não exige (decisão fechada: sem
          maiúscula/número/símbolo obrigatórios) — só a recomendação, como
          sugestão, nunca como requisito. */}
      <div className="bg-brand/5 dark:bg-brand/10 border border-brand/15 rounded-2xl p-4">
        <p className="text-xs text-gray-600 dark:text-gray-400 leading-relaxed">
          <strong className="text-gray-700 dark:text-gray-300">Dica de segurança:</strong> Use uma
          senha com pelo menos 8 caracteres. Misturar letras, números e símbolos como{' '}
          <code className="font-mono bg-white dark:bg-gray-800 px-1 rounded">@ # $ !</code>{' '}
          é uma boa prática, mas não é obrigatório.
        </p>
      </div>
    </div>
  )
}
