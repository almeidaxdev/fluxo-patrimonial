// src/components/auth/AnimatedAuthBackground.tsx
//
// Fundo animado do painel visual da tela de login/cadastro — Rodada 4 de
// refinamento (login-redesign): gradiente vivo + blobs/glows à deriva +
// 3 camadas de onda + partículas com deslocamento real (~20–60px). Durações
// e amplitudes recalibradas nesta rodada (8–20s, conforme faixas pedidas)
// para movimento REALMENTE perceptível em 3–5s de observação.
//
// IMPORTANTE (achado da Rodada 4, ver relatório de entrega): o código já
// estava correto desde a Rodada 3 (confirmado via CSS compilado servido
// pelo dev server) — a tela parecia estática porque `prefers-reduced-
// motion: reduce` estava ativo no ambiente de teste (Windows com "Mostrar
// animações" desligado — confirmado via SystemParametersInfo/
// SPI_GETCLIENTAREAANIMATION), fazendo `animation: none !important` valer
// para TODAS as camadas (ver globals.css). Isso é o comportamento CORRETO
// de acessibilidade, não um bug — mas explica por que rodadas anteriores
// pareciam "sem efeito" mesmo com durações mais rápidas.
//
// Deliberadamente só CSS/SVG — sem vídeo, sem GIF, sem canvas, sem
// biblioteca de animação. Só `transform3d`/`opacity`/`background-position`
// são animados (baratos para o compositor); `will-change-transform` só
// nas poucas camadas que animam continuamente (blobs/glows/ondas), nunca
// nas partículas (evita empilhar dezenas de camadas de composição).
//
// `variant`: 'panel' (painel azul de desktop, grande) ou 'band' (faixa
// compacta do topo no mobile/tablet — Etapa 22) — mesma composição,
// elementos proporcionalmente menores e em menor quantidade na variante
// compacta, para não pesar visualmente numa faixa baixa.
//
// Puramente decorativo (`aria-hidden`). As classes `animate-*` (ver
// globals.css) já desativam o movimento inteiro sob
// `prefers-reduced-motion: reduce`, mantendo gradiente/blobs/ondas/glows
// visualmente intactos — só o movimento para.
export function AnimatedAuthBackground({ variant = 'panel' }: { variant?: 'panel' | 'band' }) {
  const compacta = variant === 'band'

  return (
    <div aria-hidden="true" className="absolute inset-0 overflow-hidden pointer-events-none">
      {/* A) Gradiente vivo — a mesma superfície azul, só que respirando
          lentamente (background-position), nunca uma cor chapada. */}
      <div className="absolute inset-0 bg-gradient-to-br from-brand-dark via-brand to-brand-light bg-[length:250%_250%] animate-gradient-drift will-change-transform" />

      {/* D) Glows suaves — manchas luminosas grandes, bem discretas,
          movimento quase imperceptível. */}
      <div
        className={`absolute rounded-full bg-white/10 blur-3xl animate-glow-drift-1 will-change-transform ${compacta ? 'w-56 h-56 -top-16 left-1/3' : 'w-[34rem] h-[34rem] top-1/4 left-1/3'}`}
      />
      {!compacta && (
        <div className="absolute w-[22rem] h-[22rem] bottom-0 right-1/4 rounded-full bg-brand-light/20 blur-3xl animate-glow-drift-2 will-change-transform" />
      )}

      {/* Blobs à deriva (já existiam na v1, mantidos — só reforçados pelo
          gradiente/glow acima). */}
      <div
        className={`absolute rounded-full bg-white/10 blur-3xl animate-blob-drift-1 will-change-transform ${compacta ? 'w-40 h-40 -top-16 -left-10' : 'w-[28rem] h-[28rem] -top-32 -left-24'}`}
      />
      <div
        className={`absolute rounded-full bg-highlight/15 blur-3xl animate-blob-drift-2 will-change-transform ${compacta ? 'w-32 h-32 top-4 -right-10' : 'w-[24rem] h-[24rem] top-1/3 -right-32'}`}
      />
      {!compacta && (
        <div className="absolute -bottom-40 left-1/4 w-[26rem] h-[26rem] rounded-full bg-brand-light/30 blur-3xl animate-blob-drift-3 will-change-transform" />
      )}

      {/* B) Partículas — poucas, lentas, opacidade baixa, tamanhos
          variados (nunca "neve"). Menos elementos na variante compacta. */}
      <div className="absolute inset-0">
        {(compacta ? PARTICULAS.slice(0, 4) : PARTICULAS).map((p, i) => (
          <span
            key={i}
            className="absolute rounded-full bg-white animate-particle-float"
            style={
              {
                left: p.left,
                top: p.top,
                width: p.size,
                height: p.size,
                animationDelay: p.delay,
                animationDuration: p.duration,
                // Custom properties lidas pelo keyframe (ver globals.css)
                // — `opacity`/`transform` estáticos via style seriam
                // ignorados enquanto a animação roda (uma animação CSS
                // assume o controle TOTAL da propriedade durante todo o
                // ciclo); por isso a variação por partícula (deslocamento
                // X/Y de ~20–60px/15–50px, direções diferentes) só é
                // possível referenciando --tx/--ty dentro do keyframe.
                '--po': p.opacity,
                '--tx': p.tx,
                '--ty': p.ty,
              } as React.CSSProperties
            }
          />
        ))}
      </div>

      {/* C) 3 camadas de onda — velocidades/amplitudes/opacidades
          diferentes; a camada mais fina (topo) carrega o único detalhe
          laranja da composição (E), como um traço, nunca uma massa de cor. */}
      <svg
        className="absolute bottom-0 left-0 w-[200%] h-32 animate-wave-drift-slow will-change-transform"
        viewBox="0 0 2400 200"
        preserveAspectRatio="none"
        fill="none"
      >
        <path
          d="M0,120 C200,180 400,60 600,120 C800,180 1000,60 1200,120 C1400,180 1600,60 1800,120 C2000,180 2200,60 2400,120 L2400,200 L0,200 Z"
          fill="rgba(255,255,255,0.05)"
        />
      </svg>
      {!compacta && (
        <>
          <svg
            className="absolute bottom-0 left-0 w-[200%] h-24 animate-wave-drift will-change-transform"
            viewBox="0 0 2400 160"
            preserveAspectRatio="none"
            fill="none"
          >
            <path
              d="M0,90 C150,140 350,40 600,90 C850,140 1050,40 1200,90 C1350,140 1550,40 1800,90 C1950,140 2150,40 2400,90 L2400,160 L0,160 Z"
              fill="rgba(255,255,255,0.07)"
            />
          </svg>
          <svg
            className="absolute bottom-2 left-0 w-[200%] h-16 animate-wave-drift-fast will-change-transform"
            viewBox="0 0 2400 100"
            preserveAspectRatio="none"
            fill="none"
          >
            {/* E) detalhe laranja — traço fino, opacidade baixa; nunca preenchimento. */}
            <path
              d="M0,60 C150,90 350,20 600,60 C850,90 1050,20 1200,60 C1350,90 1550,20 1800,60 C1950,90 2150,20 2400,60"
              stroke="rgba(240,123,0,0.18)"
              strokeWidth="2"
              fill="none"
            />
          </svg>
        </>
      )}
    </div>
  )
}

// tx/ty: deslocamento no pico do ciclo (~20–60px em X, ~15–50px em Y,
// sinais variados para direções diferentes — nunca o mesmo movimento
// repetido). duration: 8–18s, conforme pedido nesta rodada.
const PARTICULAS = [
  { left: '10%', top: '20%', size: 5, opacity: 0.4, tx: '38px', ty: '-28px', delay: '0s', duration: '11s' },
  { left: '25%', top: '65%', size: 3, opacity: 0.3, tx: '-24px', ty: '32px', delay: '1.5s', duration: '16s' },
  { left: '40%', top: '35%', size: 4, opacity: 0.45, tx: '52px', ty: '18px', delay: '3s', duration: '9s' },
  { left: '55%', top: '75%', size: 2, opacity: 0.32, tx: '-45px', ty: '-22px', delay: '0.7s', duration: '17s' },
  { left: '70%', top: '25%', size: 4, opacity: 0.4, tx: '30px', ty: '40px', delay: '2.3s', duration: '13s' },
  { left: '85%', top: '55%', size: 3, opacity: 0.3, tx: '-32px', ty: '-45px', delay: '4s', duration: '15s' },
]
