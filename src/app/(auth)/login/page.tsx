import { isDemoModeAtivo } from '@/lib/demo-mode'
import LoginForm from './LoginForm'

export default function LoginPage() {
  // O HTML e a hidratação usam o mesmo valor, sem exibir autocadastro
  // enquanto o navegador ainda aguarda a identificação da demonstração.
  return <LoginForm demoModeAtivo={isDemoModeAtivo()} />
}
