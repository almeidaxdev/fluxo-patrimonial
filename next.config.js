// Security headers (Etapa security/headers): aplicados a TODAS as rotas
// (páginas e API). Nenhum deles depende de recurso externo além do já usado
// pelo projeto (Google Fonts via CSS @import em globals.css) — nenhum
// Permissions-Policy libera algo, pois o app não usa câmera, microfone,
// geolocalização, pagamento, USB, fullscreen nem Clipboard API em lugar
// nenhum do código (confirmado por auditoria). Sem CSP nesta etapa — ver
// docs/MANUTENCAO.md para o motivo (script inline do next-themes) e o plano
// para uma etapa futura.
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Nenhum fluxo do sistema embute a aplicação em <iframe> de terceiros
  // (confirmado por auditoria — sem uso de <iframe> em nenhuma tela).
  // `frame-ancestors` (CSP) é o substituto moderno deste header, mas fica
  // para a etapa futura de CSP (ver docs/MANUTENCAO.md) — nesta fase
  // nenhuma diretiva Content-Security-Policy é enviada, conforme escopo.
  { key: 'X-Frame-Options', value: 'DENY' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=(), clipboard-read=(), clipboard-write=()',
  },
]

// HSTS só em produção — em `next dev` (HTTP local) o header não teria efeito
// prático (só é honrado pelo navegador em contexto seguro), mas evitamos
// enviá-lo mesmo assim para não haver qualquer risco de comportamento
// inesperado em ambiente local. Sem `preload`, conforme instruído.
if (process.env.NODE_ENV === 'production') {
  securityHeaders.push({
    key: 'Strict-Transport-Security',
    value: 'max-age=31536000; includeSubDomains',
  })
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['@prisma/client'],
  webpack(config, { isServer }) {
    if (isServer) {
      config.resolve.alias['react-pdf-react'] = require.resolve('react')
    }
    return config
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: securityHeaders,
      },
    ]
  },
}

module.exports = nextConfig
