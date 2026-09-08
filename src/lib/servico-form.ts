// src/lib/servico-form.ts
// Validação client-side de quantidade de serviço/movimentação, compartilhada
// entre Nova Solicitação e Atendimento Imediato. Espelha a regra de
// itemServicoSchema (quantidade inteira >= 1) — mantida em sincronia manual.
export function parseQuantidadeServico(valor: string): number | null {
  const qtd = parseInt(valor)
  if (!valor || !Number.isInteger(qtd) || qtd < 1) return null
  return qtd
}
