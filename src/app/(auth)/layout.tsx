// src/app/(auth)/layout.tsx
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { AnimatedAuthBackground } from '@/components/auth/AnimatedAuthBackground'

export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await getSession()
  if (session) {
    redirect('/lobby')
  }

  return (
    <div className="min-h-screen w-full flex flex-col lg:flex-row overflow-x-hidden bg-[#fafbfd] dark:bg-gray-950">
      {/* Painel visual desktop (só a partir de lg: telas menores usam a
          faixa compacta abaixo). Sem wordmark aqui de propósito — já
          aparece uma vez dentro do card; a região fica limpa, só integrada
          ao fundo animado. */}
      <div className="hidden lg:flex lg:w-[56%] xl:w-[58%] relative flex-col justify-center overflow-hidden bg-brand p-10 xl:p-14">
        <AnimatedAuthBackground variant="panel" />

        {/* Hierarquia central (item 5/10) — título curto + frase curta, sem nome de sistema. */}
        <div className="relative z-10 max-w-md space-y-3">
          <h2 className="text-2xl xl:text-3xl font-bold text-white leading-tight">Gestão Patrimonial</h2>
          <p className="text-blue-100/90 text-base leading-relaxed">
            Empréstimos, reservas e controle de bens de forma simples e eficiente.
          </p>
        </div>
      </div>

      {/* Faixa compacta (mobile/tablet, < lg): só o fundo animado, como uma
          faixa/header de identidade — SEM wordmark aqui. O wordmark aparece
          uma única vez, dentro do card logo abaixo; repeti-lo nesta faixa
          leria como duplicado e inflava a faixa além do que a decoração por
          si só precisa. */}
      <div className="lg:hidden relative h-24 sm:h-28 overflow-hidden bg-brand rounded-b-[2rem] shadow-lg shrink-0">
        <AnimatedAuthBackground variant="band" />
      </div>

      {/* Painel do formulário — off-white sutil (item 19), leve glow azul
          atrás do card, profundidade discreta sem virar outro painel colorido.
          Mobile: alinhado ao topo (Etapa mobile-login-polish) — a faixa
          compacta acima já ancora a composição. Desktop preservado
          (lg:justify-center, lg:py-8) — comportamento/visual inalterados a
          partir de lg. */}
      <div className="flex-1 flex flex-col items-center justify-start lg:justify-center px-4 sm:px-8 pt-3 pb-8 sm:pb-10 lg:pt-8 lg:pb-8 min-w-0 relative">
        <div
          aria-hidden="true"
          className="hidden lg:block absolute w-[28rem] h-[28rem] rounded-full bg-brand/[0.04] blur-3xl pointer-events-none"
        />
        {/* Card sobreposto à faixa azul no mobile (margem negativa) — some em lg, onde o painel visual já cumpre esse papel. */}
        <div className="w-full max-w-sm -mt-8 lg:mt-0 relative z-10 animate-fade-in">{children}</div>
      </div>
    </div>
  )
}
