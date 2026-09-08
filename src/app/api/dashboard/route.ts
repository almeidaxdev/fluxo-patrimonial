// src/app/api/dashboard/route.ts
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getSession } from '@/lib/auth'
import { isPatrimonioOuAdmin } from '@/lib/permissions'
import { STATUS_EM_ANDAMENTO_SOLICITANTE } from '@/lib/status'

// Etapa perf/system-optimization: antes, esta rota fazia um `prisma.user.
// findUnique` só para reler `id`/`podeSerGestor` — ambos já vêm no JWT da
// sessão (SessionUser), sem precisar de round-trip nenhum ao banco. Isso
// criava um waterfall de até 3 estágios sequenciais (findUnique → Promise.all
// de 4 counts → count condicional → Promise.all condicional de 9 counts).
// `session.id`/`session.podeSerGestor` já são a fonte usada em todo o resto
// do projeto para decisões equivalentes de "o que mostrar" (ex.:
// src/middleware.ts, que usa exatamente os mesmos campos do JWT para decidir
// rotas visíveis) — não é uma checagem de autorização sensível como as de
// relatorios-auth.ts (que reconsulta o banco de propósito, para revogar
// acesso imediatamente); aqui é só "quais cards aparecem no dashboard", e o
// pior caso de um JWT com até 24h de idade (Etapa security/session-revocation
// — era 7 dias) é mostrar/ocultar um card a mais/a menos até o próximo login
// — sem risco de negócio.
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ message: 'Não autorizado.' }, { status: 401 })

  const mostrarAprovacoes = session.podeSerGestor
  const mostrarPatrimonio = isPatrimonioOuAdmin(session)

  // Um ÚNICO Promise.all para toda a rota — antes eram até 2 rodadas
  // sequenciais (uma condicional a "user.podeSerGestor", outra a
  // "isPatrimonioOuAdmin"); como ambas as condições já são conhecidas sem
  // ler o banco, todas as queries (fixas + condicionais) partem juntas.
  //
  // Etapa feat/admin-dashboard-operational: removidas 3 queries que só
  // alimentavam a versão ANTIGA da seção operacional do Admin (Aguardando
  // assinatura como pendência do Patrimônio, e o card "Internos x
  // Externos") — o Painel do Patrimônio já havia deixado de usá-las
  // (Etapa feat/patrimonio-operational-ux) e agora o Dashboard do Admin usa
  // exatamente a mesma seção compartilhada (`OperacaoPatrimonio`), então
  // esses campos nunca tiveram outro consumidor. -3 round-trips para quem
  // vê o bloco `patrimonio` (Patrimônio/Admin).
  const [
    minhasPendentes,
    minhasAssinaturaPendente,
    minhasProntas,
    minhasRecentes,
    aprovacoesPendentes,
    aguardandoAnalise,
    emSeparacao,
    prontasRetirada,
    emUtilizacao,
    naoRetiradas,
    bensTotal,
    bensAtivos,
  ] = await Promise.all([
    // Etapa feat/admin-dashboard-operational (homologação): "em andamento"
    // agora usa a MESMA lista (`STATUS_EM_ANDAMENTO_SOLICITANTE`) que o
    // filtro `?status=EM_ANDAMENTO` do card pessoal aplica de verdade em
    // `GET /api/solicitacoes` — nunca duas definições divergentes da mesma
    // regra. Equivalente ao `notIn` anterior (os 5 status terminais/
    // negativos ficam de fora), só que como whitelist explícita.
    prisma.solicitacao.count({
      where: { solicitanteId: session.id, status: { in: STATUS_EM_ANDAMENTO_SOLICITANTE } },
    }),
    prisma.solicitacao.count({ where: { solicitanteId: session.id, status: 'AGUARDANDO_ASSINATURA' } }),
    prisma.solicitacao.count({ where: { solicitanteId: session.id, status: 'PRONTA_RETIRADA' } }),
    prisma.solicitacao.findMany({
      where: { solicitanteId: session.id },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, numero: true, status: true, data: true, tipoEmprestimo: true },
    }),
    mostrarAprovacoes
      ? prisma.solicitacao.count({ where: { gestorId: session.id, status: 'AGUARDANDO_GESTOR' } })
      : Promise.resolve(undefined),
    mostrarPatrimonio ? prisma.solicitacao.count({ where: { status: 'AGUARDANDO_PATRIMONIO' } }) : Promise.resolve(0),
    mostrarPatrimonio ? prisma.solicitacao.count({ where: { status: 'EM_SEPARACAO' } }) : Promise.resolve(0),
    mostrarPatrimonio ? prisma.solicitacao.count({ where: { status: 'PRONTA_RETIRADA' } }) : Promise.resolve(0),
    mostrarPatrimonio ? prisma.solicitacao.count({ where: { status: 'EM_UTILIZACAO' } }) : Promise.resolve(0),
    // Etapa feat/patrimonio-operational-ux: contagem simples (mesmo padrão
    // dos demais counts acima) — alimenta o card "Não retiradas" do Painel
    // do Patrimônio. Reaproveita o MESMO Promise.all já existente, sem
    // round-trip extra ao banco.
    mostrarPatrimonio ? prisma.solicitacao.count({ where: { status: 'NAO_RETIRADA' } }) : Promise.resolve(0),
    mostrarPatrimonio ? prisma.patrimonio.count() : Promise.resolve(0),
    mostrarPatrimonio ? prisma.patrimonio.count({ where: { ativo: true } }) : Promise.resolve(0),
  ])

  const payload: Record<string, unknown> = {
    minhasPendentes,
    minhasAssinaturaPendente,
    minhasProntas,
    minhasRecentes,
  }

  if (mostrarAprovacoes) {
    payload.aprovacoesPendentes = aprovacoesPendentes
  }

  if (mostrarPatrimonio) {
    payload.patrimonio = {
      aguardandoAnalise,
      emSeparacao,
      prontasRetirada,
      emUtilizacao,
      aguardandoDevolucao: emUtilizacao,
      naoRetiradas,
      bensTotal,
      bensAtivos,
    }
  }

  return NextResponse.json(payload, { status: 200 })
}
