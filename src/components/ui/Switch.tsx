// src/components/ui/Switch.tsx
'use client'

// Etapa fix/collaborator-session-sync — toggle acessível reutilizável para
// campos booleanos (status da conta, permissões adicionais). Antes desta
// etapa o projeto só usava checkboxes simples (accent-highlight); este
// componente é o primeiro switch do design system — mesma cor de destaque
// (highlight) para "ligado", nunca uma cor nova.
interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  id?: string
  'aria-label'?: string
}

export function Switch({ checked, onChange, disabled, id, ...aria }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      id={id}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900 disabled:opacity-50 disabled:cursor-not-allowed ${
        checked ? 'bg-highlight' : 'bg-gray-200 dark:bg-gray-700'
      }`}
      {...aria}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform duration-200 ${
          checked ? 'translate-x-[1.375rem]' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}
