// src/lib/email/html.ts

/**
 * Escapa valores vindos de usuário antes de interpolar em HTML de e-mail
 * (finalidade, observações, local, serviços, nomes etc.), evitando HTML
 * injection. Todo texto dinâmico em templates deve passar por aqui.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
