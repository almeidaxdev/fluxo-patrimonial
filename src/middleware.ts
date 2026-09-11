// src/middleware.ts
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { verifyToken } from '@/lib/auth'

const PUBLIC_ROUTES = ['/login', '/cadastro']
// Fluxo Patrimonial — Demo: a tela de login precisa consultar
// GET /api/demo/status ANTES de existir qualquer sessão (decide se mostra
// o botão "Acessar demonstração"), e POST /api/demo/entrar É o próprio
// mecanismo de login da demo — nenhum dos dois pode exigir uma sessão que
// ainda não existe. Caminho EXATO (nunca prefixo "/api/demo") — não isenta
// nenhuma outra rota do mesmo namespace (ex.: futuras rotas sensíveis sob
// /api/demo/*). A proteção de verdade de status/entrar continua sendo
// feita pelas próprias rotas (DEMO_MODE=true, rate limit em entrar) — isto
// só remove o gate de sessão do middleware, que nunca deveria existir para
// elas. Ver DEMO_RESET_EXACT_PATH abaixo para o caso (diferente) de
// /api/internal/demo-reset.
const PUBLIC_DEMO_API_ROUTES = ['/api/demo/status', '/api/demo/entrar']
// POST|GET /api/internal/demo-reset: rota administrativa pensada para
// automação server-to-server que NUNCA tem cookie de sessão — POST para
// disparo manual/server-to-server (npm run demo:reset — ver
// scripts/demo-reset.ts) e GET exclusivo do Vercel Cron (ver
// vercel.json). A autenticação de verdade desta rota é exclusivamente o
// secret de cada verbo — DEMO_RESET_SECRET no header x-demo-reset-secret
// para o POST, CRON_SECRET no header Authorization: Bearer para o GET —
// comparado em tempo constante DENTRO do handler
// (src/app/api/internal/demo-reset/route.ts) — cookie de sessão nunca foi
// nem deve virar autorização para reset, nem mesmo a sessão do
// Administrador Demo (ver o próprio handler: ele não lê
// getSession()/getValidatedMutationSession() em nenhum momento).
// Isentar esta rota do gate de sessão do middleware não é um bypass de
// segurança: é remover um SEGUNDO gate (sessão) que nunca foi a
// credencial real dela, deixando só a credencial que de fato importa (o
// secret de cada verbo) decidir. Caminho EXATO + MÉTODOS EXATOS
// (POST e GET, cada um com sua própria credencial no handler) — nunca
// prefixo "/api/internal/*" (outras rotas internas futuras continuam
// exigindo sessão normalmente), nunca libera PUT/PATCH/DELETE nem
// qualquer outro verbo nesta mesma rota.
const DEMO_RESET_EXACT_PATH = '/api/internal/demo-reset'
const DEMO_RESET_METODOS_LIBERADOS = ['POST', 'GET']
const PATRIMONIO_ROUTES = ['/todas-solicitacoes', '/patrimonios', '/pendencias', '/atendimento-imediato', '/relatorios']
const ADMIN_ROUTES = ['/colaboradores', '/categorias']
const GESTOR_ROUTES = ['/aprovacoes']
// Etapa feat/patrimonio-operational-ux: páginas PESSOAIS de colaborador
// (criar/ver a própria solicitação) que não fazem sentido operacionalmente
// para o perfil PATRIMONIO — a equipe de Patrimônio já opera pelas telas
// coletivas (Pendências, Todas as Solicitações, Atendimento Imediato), nunca
// pelo fluxo de "minha própria reserva". Restrição de PÁGINA (nunca só o
// Sidebar) — acessar a URL diretamente também é bloqueado aqui, no
// middleware, antes de qualquer render. Exclusivo de `permissao ===
// 'patrimonio'`: ADMINISTRADOR continua acessando as duas normalmente (ele
// também pode ter uma solicitação pessoal), e COLABORADOR/GESTOR nunca são
// afetados por esta lista. Nunca confundir com PATRIMONIO_ROUTES acima
// (o oposto: rotas EXCLUSIVAS de Patrimônio/Admin, negadas a colaborador).
const PATRIMONIO_PAGINAS_PESSOAIS_RESTRITAS = ['/nova-solicitacao', '/minhas-solicitacoes']

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const isApiRoute = pathname.startsWith('/api/')

  // Allow public routes
  if (PUBLIC_ROUTES.some((r) => pathname.startsWith(r))) {
    return NextResponse.next()
  }

  // Allow API auth routes
  if (pathname.startsWith('/api/auth')) {
    return NextResponse.next()
  }

  // Allow the two demo endpoints that must work WITHOUT a session (ver
  // PUBLIC_DEMO_API_ROUTES acima).
  if (PUBLIC_DEMO_API_ROUTES.includes(pathname)) {
    return NextResponse.next()
  }

  // Allow POST/GET /api/internal/demo-reset WITHOUT a session — caminho E
  // métodos exatos (ver DEMO_RESET_EXACT_PATH/DEMO_RESET_METODOS_LIBERADOS
  // acima). Qualquer outro verbo (PUT/PATCH/DELETE/...) para o mesmo
  // caminho, ou qualquer outra rota sob /api/internal/, continua caindo no
  // gate de sessão normal abaixo.
  if (DEMO_RESET_METODOS_LIBERADOS.includes(request.method) && pathname === DEMO_RESET_EXACT_PATH) {
    return NextResponse.next()
  }

  const token = request.cookies.get('session')?.value

  if (!token) {
    if (isApiRoute) {
      return NextResponse.json({ message: 'Não autorizado.' }, { status: 401 })
    }
    return NextResponse.redirect(new URL('/login', request.url))
  }

  const user = await verifyToken(token)

  if (!user) {
    if (isApiRoute) {
      const res = NextResponse.json({ message: 'Não autorizado.' }, { status: 401 })
      res.cookies.delete('session')
      return res
    }
    const response = NextResponse.redirect(new URL('/login', request.url))
    response.cookies.delete('session')
    return response
  }

  // As regras de PATRIMONIO_ROUTES/ADMIN_ROUTES/GESTOR_ROUTES abaixo são uma
  // proteção de PÁGINA (evitar que a tela renderize para quem não deveria
  // acessá-la). Elas usam correspondência por substring (`.includes`), que
  // colide com endpoints de API que compartilham o mesmo nome de segmento
  // (ex.: '/api/categorias' contém '/categorias'). Rotas de API já validam
  // sua própria permissão internamente e devolvem JSON — então esse bloco
  // não deve ser aplicado a elas, sob risco de redirecionar (307, HTML)
  // chamadas de fetch que deveriam apenas responder 200/401/403 em JSON.
  if (isApiRoute) {
    return NextResponse.next()
  }

  // Check patrimonio routes
  if (PATRIMONIO_ROUTES.some((r) => pathname.includes(r))) {
    if (user.permissao === 'colaborador') {
      return NextResponse.redirect(new URL('/lobby', request.url))
    }
  }

  // Páginas pessoais de colaborador, indisponíveis para o perfil PATRIMONIO
  // (ver comentário da constante acima) — redireciona para o painel
  // operacional (/lobby, role-aware para este perfil), nunca deixa a página
  // pessoal renderizar só porque a URL foi digitada/colada diretamente.
  if (PATRIMONIO_PAGINAS_PESSOAIS_RESTRITAS.some((r) => pathname.includes(r))) {
    if (user.permissao === 'patrimonio') {
      return NextResponse.redirect(new URL('/lobby', request.url))
    }
  }

  // Check admin routes
  if (ADMIN_ROUTES.some((r) => pathname.includes(r))) {
    if (user.permissao !== 'administrador') {
      return NextResponse.redirect(new URL('/lobby', request.url))
    }
  }

  // Check gestor routes (permissão adicional, não é um perfil exclusivo)
  if (GESTOR_ROUTES.some((r) => pathname.includes(r))) {
    if (!user.podeSerGestor && user.permissao !== 'administrador') {
      return NextResponse.redirect(new URL('/lobby', request.url))
    }
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/auth).*)'],
}
