// src/app/(dashboard)/solicitacoes/[id]/page.tsx
'use client'

import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import {
  CheckCircle2, XCircle, Loader2, Link as LinkIcon, PackageCheck, Truck,
  Undo2, Ban, Clock, Laptop, Package as PackageIcon, AlertTriangle, Wrench, Zap, Printer
} from 'lucide-react'
import { useSession } from '@/hooks/use-session'
import { useToast } from '@/hooks/use-toast'
import { Solicitacao, StatusSolicitacao, TIPO_EMPRESTIMO_LABELS, CondicaoDevolucao, CONDICAO_DEVOLUCAO_LABELS, TIPO_DOMINIO_LABELS } from '@/types'
import { StatusSolicitacaoBadge } from '@/components/ui/StatusBadge'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { podeTransitar } from '@/lib/status'
import { formatarAntecedencia, calcularReferenciaUtilizacao } from '@/lib/prazo'
import { cn, formatDataCivil, formatDateTime, formatPeriodos, isValidUrl } from '@/utils'

export default function SolicitacaoDetalhePage() {
  const { id } = useParams<{ id: string }>()
  const { user } = useSession()
  const { toast } = useToast()

  const [solicitacao, setSolicitacao] = useState<Solicitacao | null>(null)
  const [loading, setLoading] = useState(true)
  const [acao, setAcao] = useState<string | null>(null)

  const [modalRejeicao, setModalRejeicao] = useState<'gestor' | 'patrimonio' | null>(null)
  const [motivo, setMotivo] = useState('')
  const [modalAssinatura, setModalAssinatura] = useState(false)
  const [link, setLink] = useState('')
  const [modalDevolucao, setModalDevolucao] = useState(false)
  const [condicao, setCondicao] = useState<CondicaoDevolucao | ''>('')
  const [obsDevolucao, setObsDevolucao] = useState('')
  const [confirmCancelar, setConfirmCancelar] = useState(false)
  const [confirmAssinatura, setConfirmAssinatura] = useState(false)
  const [confirmNaoRetirado, setConfirmNaoRetirado] = useState(false)
  const [imprimindoTermo, setImprimindoTermo] = useState(false)

  const carregar = useCallback(() => {
    setLoading(true)
    fetch(`/api/solicitacoes/${id}`)
      .then((r) => r.json())
      .then((d) => setSolicitacao(d.solicitacao || null))
      .finally(() => setLoading(false))
  }, [id])

  useEffect(() => { carregar() }, [carregar])

  // Mantém `utilizacaoJaVenceu` em dia com a referência de utilização (data +
  // início do período — calcularReferenciaUtilizacao em @/lib/prazo, mesma
  // regra usada pela API, nunca duplicada aqui), para que "Marcar como não
  // retirado" apareça sem precisar de refresh manual, mesmo para referências
  // distantes no futuro.
  //
  // Agendamento recursivo/encadeado: setTimeout tem limite de 32 bits
  // (~24,8 dias) — acima disso o navegador dispara IMEDIATAMENTE em vez de
  // esperar. Por isso cada disparo só recalcula quanto falta e reagenda o
  // próximo trecho (nunca soma milissegundos extra depois do clamp); a
  // recursão vive inteiramente dentro desta única execução do efeito — não
  // depende do efeito rodar de novo — então funciona igual para uma
  // referência em 10 minutos, 10 dias, 30 dias ou 90 dias.
  const [utilizacaoJaVenceu, setUtilizacaoJaVenceu] = useState(false)
  useEffect(() => {
    if (!solicitacao || solicitacao.status !== 'PRONTA_RETIRADA') {
      setUtilizacaoJaVenceu(false)
      return
    }
    const referencia = calcularReferenciaUtilizacao(solicitacao.data, solicitacao.periodos)
    if (referencia === null) {
      setUtilizacaoJaVenceu(false)
      return
    }

    // Margem segura abaixo do limite de 32 bits assinado (2_147_483_647 ms);
    // nunca extrapolado, pois cada trecho usa Math.min contra este teto.
    const LIMITE_SETTIMEOUT_MS = 2_147_483_000
    let cancelado = false
    let timer: ReturnType<typeof setTimeout> | undefined

    function agendarProximoTrecho() {
      const restanteMs = referencia!.getTime() - Date.now()
      if (restanteMs <= 0) {
        if (!cancelado) setUtilizacaoJaVenceu(true)
        return
      }
      timer = setTimeout(() => {
        if (cancelado) return
        agendarProximoTrecho()
      }, Math.min(restanteMs, LIMITE_SETTIMEOUT_MS))
    }

    setUtilizacaoJaVenceu(false)
    agendarProximoTrecho()

    return () => {
      cancelado = true
      if (timer) clearTimeout(timer)
    }
  }, [solicitacao])

  async function chamar(url: string, body?: unknown) {
    setAcao(url)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })
      const result = await res.json()
      if (!res.ok) {
        toast({ title: 'Ação não realizada', description: result.message, variant: 'destructive' })
        return false
      }
      toast({ title: 'Ação realizada com sucesso.' })
      carregar()
      return true
    } catch {
      toast({ title: 'Erro', description: 'Falha de comunicação com o servidor.', variant: 'destructive' })
      return false
    } finally {
      setAcao(null)
    }
  }

  // Termo de Retirada e Devolução: só busca/abre o PDF, nunca chama `chamar()`
  // — geração é puramente de leitura (não altera status, histórico nem
  // qualquer dado da solicitação). Mesmo padrão fetch+blob já usado em
  // Relatórios (src/app/(dashboard)/relatorios/page.tsx#exportarPdf), mas
  // abrindo em nova aba (window.open) em vez de forçar download, já que o
  // objetivo aqui é imprimir direto do visualizador do navegador.
  async function imprimirTermo() {
    if (imprimindoTermo) return
    setImprimindoTermo(true)
    try {
      const res = await fetch(`/api/solicitacoes/${id}/termo`)
      if (!res.ok) {
        const payload = await res.json().catch(() => null)
        toast({ title: 'Não foi possível gerar o termo', description: payload?.message, variant: 'destructive' })
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      window.open(url, '_blank')
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch {
      toast({ title: 'Erro', description: 'Falha de comunicação com o servidor.', variant: 'destructive' })
    } finally {
      setImprimindoTermo(false)
    }
  }

  if (loading) return <div className="text-center py-16 text-gray-400">Carregando...</div>
  if (!solicitacao) return <div className="text-center py-16 text-gray-400">Solicitação não encontrada.</div>

  const isGestorDaSolicitacao = solicitacao.gestorId === user?.id
  const isPatrimonioOuAdmin = user?.permissao === 'patrimonio' || user?.permissao === 'administrador'
  const isSolicitante = solicitacao.solicitanteId === user?.id
  const status = solicitacao.status as StatusSolicitacao

  // Reaproveita a mesma máquina de transições usada no backend (src/lib/status.ts)
  // em vez de manter uma lista de status proibidos duplicada e sujeita a
  // dessincronizar — se o backend não permite mais cancelar a partir do
  // status atual (ex.: já EM_UTILIZACAO), o botão simplesmente não aparece.
  const podeCancelar = (isSolicitante || isPatrimonioOuAdmin) && podeTransitar(status, 'CANCELADA')

  // "Não retirado" só é oferecido depois que a data/horário de início do
  // período de utilização já passou — `utilizacaoJaVenceu` é mantido em dia
  // pelo efeito de agendamento acima. A API é a fonte definitiva desta
  // checagem (ver /api/solicitacoes/[id]/nao-retirada) — isto só evita
  // oferecer a ação antes da hora, não substitui a validação server-side.
  const podeMarcarNaoRetirado = isPatrimonioOuAdmin && status === 'PRONTA_RETIRADA' && utilizacaoJaVenceu

  return (
    <div className="max-w-4xl space-y-6">
      {/* Cabeçalho */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <h2 className="text-lg font-bold text-gray-900 dark:text-white">Solicitação #{solicitacao.numero}</h2>
          <StatusSolicitacaoBadge status={status} />
          <span className="text-xs text-gray-500 px-2 py-0.5 bg-gray-100 dark:bg-gray-800 rounded-full">{TIPO_EMPRESTIMO_LABELS[solicitacao.tipoEmprestimo]}</span>
          {solicitacao.origem === 'ATENDIMENTO_IMEDIATO' && (
            <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 bg-indigo-100 text-indigo-700 border border-indigo-200 rounded-full">
              <Zap size={12} /> Atendimento Imediato
            </span>
          )}
        </div>

        <div className="grid sm:grid-cols-2 gap-3 text-sm">
          <Info label="Solicitante" value={solicitacao.solicitante?.nome} />
          {solicitacao.criadoPorId !== solicitacao.solicitanteId && <Info label="Criado por" value={solicitacao.criadoPor?.nome} />}
          {/* solicitacao.data é a DATA CIVIL da reserva (@db.Date) — formatDataCivil(),
              não formatDate() (ver Etapa D.3.FOLLOW-UP). Devolvido em/histórico abaixo
              continuam em formatDateTime(): são instantes reais. */}
          <Info label="Data" value={formatDataCivil(solicitacao.data)} />
          <Info label="Período(s)" value={formatPeriodos(solicitacao.periodos)} />
          {solicitacao.ambiente && <Info label="Ambiente" value={solicitacao.ambiente} />}
          {solicitacao.atividadeExterna && <Info label="Atividade" value={solicitacao.atividadeExterna} />}
          {solicitacao.local && <Info label="Local" value={`${solicitacao.local} — ${solicitacao.cidade}`} />}
          {solicitacao.gestor && <Info label="Gestor" value={solicitacao.gestor.nome} />}
          {solicitacao.finalidade && <Info label="Finalidade" value={solicitacao.finalidade} />}
          {solicitacao.observacoes && <Info label="Observações" value={solicitacao.observacoes} />}
        </div>

        {(solicitacao.motivoRejeicaoGestor || solicitacao.motivoRejeicaoPatrimonio) && (
          <div className="mt-4 p-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded-xl text-sm text-red-700 dark:text-red-400">
            Motivo da rejeição: {solicitacao.motivoRejeicaoGestor || solicitacao.motivoRejeicaoPatrimonio}
          </div>
        )}
      </div>

      {/* Prazo da solicitação (Fase 3) — origem RESERVA apenas; atendimento
          imediato (quando implementado na Etapa 4) não terá esses campos
          preenchidos, pois não se aplica o conceito de prazo/antecedência. */}
      {solicitacao.origem !== 'ATENDIMENTO_IMEDIATO' && (
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm p-5 sm:p-6">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Prazo da solicitação</h3>
          {solicitacao.dentroDoPrazo === null || solicitacao.dentroDoPrazo === undefined ? (
            <p className="text-sm text-gray-400">Não disponível para esta solicitação.</p>
          ) : (
            <div className="flex flex-wrap items-center gap-4">
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-medium border',
                  solicitacao.dentroDoPrazo
                    ? 'bg-emerald-100 text-emerald-800 border-emerald-200'
                    : 'bg-red-100 text-red-800 border-red-200'
                )}
              >
                {solicitacao.dentroDoPrazo ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
                {solicitacao.dentroDoPrazo ? 'Dentro do prazo' : 'Fora do prazo'}
              </span>
              <div className="text-sm">
                <span className="text-gray-500">Antecedência: </span>
                <span className="font-medium text-gray-800 dark:text-gray-200">
                  {formatarAntecedencia(solicitacao.antecedenciaMinutos ?? 0)}
                </span>
              </div>
              <div className="text-sm">
                <span className="text-gray-500">Prazo recomendado: </span>
                <span className="font-medium text-gray-800 dark:text-gray-200">{solicitacao.prazoHoras}h</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Devolução — só aparece quando já houve devolução registrada.
          Nunca mistura enum com texto legado: condição estruturada
          (devoluções novas) e texto legado (devoluções antigas) são
          mutuamente exclusivos por construção (ver migration 9A-C). */}
      {solicitacao.devolucaoEm && (
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm p-5 sm:p-6">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Devolução</h3>
          <div className="grid sm:grid-cols-2 gap-3 text-sm">
            <Info label="Devolvido em" value={formatDateTime(solicitacao.devolucaoEm)} />
            <Info
              label="Condição"
              value={
                solicitacao.devolucaoCondicao
                  ? CONDICAO_DEVOLUCAO_LABELS[solicitacao.devolucaoCondicao]
                  : (solicitacao.devolucaoCondicaoTextoLegado ?? undefined)
              }
            />
            {solicitacao.devolucaoObs && <Info label="Observação" value={solicitacao.devolucaoObs} />}
          </div>
        </div>
      )}

      {/* Itens */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm p-5 sm:p-6 space-y-4">
        {solicitacao.itensPatrimonio && solicitacao.itensPatrimonio.length > 0 && (
          <div>
            <div className="flex items-center justify-between gap-2 mb-2">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 flex items-center gap-2"><Laptop size={16} /> Bens Patrimoniais</h3>
              {/* Domínio (Etapa domain-flow): propriedade da solicitação como um
                  todo, não por item — só faz sentido exibir quando há notebook
                  (notebooksComDominio !== null). Nunca inventa Educacional/
                  Administrativo para registros antigos sem tipoDominio. */}
              {solicitacao.notebooksComDominio !== null && solicitacao.notebooksComDominio !== undefined && (
                <span className={cn(
                  'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border',
                  solicitacao.notebooksComDominio
                    ? 'bg-brand/10 text-brand border-brand/20'
                    : 'bg-gray-100 text-gray-500 border-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-700'
                )}>
                  {solicitacao.notebooksComDominio
                    ? `Domínio: ${solicitacao.tipoDominio ? TIPO_DOMINIO_LABELS[solicitacao.tipoDominio] : 'tipo não informado'}`
                    : 'Sem domínio'}
                </span>
              )}
            </div>
            <ul className="space-y-1.5">
              {solicitacao.itensPatrimonio.map((i) => (
                <li key={i.id} className="text-sm text-gray-700 dark:text-gray-300 px-3 py-2 bg-gray-50 dark:bg-gray-800 rounded-lg">
                  {i.patrimonio?.categoria?.nome}: {i.patrimonio?.marca} {i.patrimonio?.modelo} ({i.patrimonio?.numero})
                  {i.comDominio !== null && i.comDominio !== undefined && (
                    <span className="ml-2 text-xs text-gray-400">— {i.comDominio ? 'com domínio' : 'sem domínio'}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {solicitacao.itensPapelaria && solicitacao.itensPapelaria.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-2"><PackageIcon size={16} /> Papelaria</h3>
            <ul className="space-y-1.5">
              {solicitacao.itensPapelaria.map((i) => (
                <li key={i.id} className="text-sm text-gray-700 dark:text-gray-300 px-3 py-2 bg-gray-50 dark:bg-gray-800 rounded-lg">
                  {i.quantidade}x {i.descricao}
                </li>
              ))}
            </ul>
          </div>
        )}
        {solicitacao.itensServico && solicitacao.itensServico.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-2"><Wrench size={16} /> Serviços / Movimentações</h3>
            <ul className="space-y-1.5">
              {solicitacao.itensServico.map((i) => (
                <li key={i.id} className="text-sm text-gray-700 dark:text-gray-300 px-3 py-2 bg-gray-50 dark:bg-gray-800 rounded-lg">
                  {i.tipoServico?.nome}
                  {i.quantidade ? ` — ${i.quantidade}` : ''}
                  {i.ambiente ? ` — ${i.ambiente}` : ''}
                  {i.observacao ? ` (${i.observacao})` : ''}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Ações */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm p-5 sm:p-6 space-y-3">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1">Ações</h3>
        <div className="flex flex-wrap gap-3">
          {/* Termo de Retirada e Devolução — Patrimônio/Admin, em qualquer
              status (não é uma ação de fluxo: não muda status, não cria
              movimentação, não confirma retirada nem devolução). */}
          {isPatrimonioOuAdmin && (
            <BotaoAcao icon={<Printer size={16} />} label="Imprimir Termo" cor="gray" outline loading={imprimindoTermo} onClick={imprimirTermo} />
          )}

          {/* Gestor */}
          {isGestorDaSolicitacao && status === 'AGUARDANDO_GESTOR' && (
            <>
              <BotaoAcao icon={<CheckCircle2 size={16} />} label="Aprovar" cor="green" loading={acao === `/api/solicitacoes/${id}/aprovar-gestor`} onClick={() => chamar(`/api/solicitacoes/${id}/aprovar-gestor`)} />
              <BotaoAcao icon={<XCircle size={16} />} label="Rejeitar" cor="red" onClick={() => setModalRejeicao('gestor')} />
            </>
          )}

          {/* Patrimônio */}
          {isPatrimonioOuAdmin && status === 'AGUARDANDO_PATRIMONIO' && (
            <>
              <BotaoAcao icon={<CheckCircle2 size={16} />} label="Confirmar" cor="green" loading={acao === `/api/solicitacoes/${id}/confirmar-patrimonio`} onClick={() => chamar(`/api/solicitacoes/${id}/confirmar-patrimonio`)} />
              <BotaoAcao icon={<XCircle size={16} />} label="Rejeitar" cor="red" onClick={() => setModalRejeicao('patrimonio')} />
            </>
          )}

          {isPatrimonioOuAdmin && (status === 'CONFIRMADA' || status === 'AGUARDANDO_ENVIO_ASSINATURA') && (
            <BotaoAcao icon={<LinkIcon size={16} />} label="Enviar link de assinatura" cor="blue" onClick={() => setModalAssinatura(true)} />
          )}
          {isPatrimonioOuAdmin && status === 'CONFIRMADA' && (
            <BotaoAcao icon={<PackageCheck size={16} />} label="Ir direto para separação (sem assinatura)" cor="gray" loading={acao === `/api/solicitacoes/${id}/separacao`} onClick={() => chamar(`/api/solicitacoes/${id}/separacao`)} />
          )}

          {(isSolicitante) && status === 'AGUARDANDO_ASSINATURA' && solicitacao.assinatura?.link && (
            <>
              <a href={solicitacao.assinatura.link} target="_blank" rel="noreferrer" className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-brand text-white">
                <LinkIcon size={16} /> Assinar agora
              </a>
              <BotaoAcao icon={<CheckCircle2 size={16} />} label="Concluí a assinatura" cor="green" onClick={() => setConfirmAssinatura(true)} />
            </>
          )}
          {isPatrimonioOuAdmin && status === 'AGUARDANDO_ASSINATURA' && (
            <>
              <BotaoAcao
                icon={<LinkIcon size={16} />}
                label="Reenviar link de assinatura"
                cor="gray"
                outline
                onClick={() => { setLink(solicitacao.assinatura?.link || ''); setModalAssinatura(true) }}
              />
              <BotaoAcao icon={<CheckCircle2 size={16} />} label="Validar assinatura manualmente" cor="gray" onClick={() => setConfirmAssinatura(true)} />
            </>
          )}

          {isPatrimonioOuAdmin && status === 'ASSINATURA_CONFIRMADA' && (
            <BotaoAcao icon={<PackageCheck size={16} />} label="Registrar separação" cor="blue" loading={acao === `/api/solicitacoes/${id}/separacao`} onClick={() => chamar(`/api/solicitacoes/${id}/separacao`)} />
          )}

          {/* Fluxo interno: confirmação pelo Patrimônio já entra direto em
              EM_SEPARACAO (sem etapa de assinatura). Reaproveita o mesmo
              endpoint /separacao já usado acima para o fluxo externo. */}
          {isPatrimonioOuAdmin && status === 'EM_SEPARACAO' && (
            <BotaoAcao icon={<PackageCheck size={16} />} label="Marcar como pronta para retirada" cor="blue" loading={acao === `/api/solicitacoes/${id}/separacao`} onClick={() => chamar(`/api/solicitacoes/${id}/separacao`)} />
          )}

          {isPatrimonioOuAdmin && status === 'PRONTA_RETIRADA' && (
            <>
              <BotaoAcao icon={<Truck size={16} />} label="Registrar retirada" cor="blue" loading={acao === `/api/solicitacoes/${id}/retirada`} onClick={() => chamar(`/api/solicitacoes/${id}/retirada`, {})} />
              {podeMarcarNaoRetirado && (
                <BotaoAcao icon={<AlertTriangle size={16} />} label="Marcar como não retirado" cor="gray" outline onClick={() => setConfirmNaoRetirado(true)} />
              )}
            </>
          )}

          {isPatrimonioOuAdmin && status === 'EM_UTILIZACAO' && (
            <BotaoAcao icon={<Undo2 size={16} />} label="Registrar devolução" cor="blue" onClick={() => setModalDevolucao(true)} />
          )}

          {podeCancelar && (
            <BotaoAcao icon={<Ban size={16} />} label="Cancelar solicitação" cor="red" outline onClick={() => setConfirmCancelar(true)} />
          )}

          {['FINALIZADA', 'CANCELADA', 'REJEITADA_GESTOR', 'REJEITADA_PATRIMONIO', 'NAO_RETIRADA'].includes(status) && (
            <p className="text-sm text-gray-400">Nenhuma ação disponível — solicitação encerrada.</p>
          )}
        </div>
      </div>

      {/* Timeline */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm p-5 sm:p-6">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-4 flex items-center gap-2"><Clock size={16} /> Linha do tempo</h3>
        <div className="space-y-4">
          {solicitacao.historico?.map((h) => (
            <div key={h.id} className="flex gap-3">
              <div className="w-2 h-2 rounded-full bg-brand mt-1.5 shrink-0" />
              <div>
                <p className="text-sm text-gray-800 dark:text-gray-200">{h.descricao || h.acao}</p>
                <p className="text-xs text-gray-400">{formatDateTime(h.createdAt)}{h.usuario ? ` — ${h.usuario.nome}` : ''}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Modais */}
      {modalRejeicao && (
        <ModalTexto
          titulo={`Rejeitar solicitação (${modalRejeicao === 'gestor' ? 'gestor' : 'Patrimônio'})`}
          descricao="Informe a justificativa da rejeição (obrigatória)."
          valor={motivo}
          onChange={setMotivo}
          maxLength={1000}
          loading={!!acao}
          onCancelar={() => { setModalRejeicao(null); setMotivo('') }}
          onConfirmar={async () => {
            const ok = await chamar(`/api/solicitacoes/${id}/rejeitar-${modalRejeicao}`, { motivo })
            if (ok) { setModalRejeicao(null); setMotivo('') }
          }}
        />
      )}

      {modalAssinatura && (
        <ModalTexto
          titulo={status === 'AGUARDANDO_ASSINATURA' ? 'Reenviar link de assinatura' : 'Enviar link de assinatura'}
          descricao={
            status === 'AGUARDANDO_ASSINATURA'
              ? 'Confira o link abaixo (ou cole um novo) e reenvie ao solicitante.'
              : 'Cole o link do sistema institucional de assinatura.'
          }
          valor={link}
          onChange={setLink}
          loading={!!acao}
          placeholder="https://..."
          onCancelar={() => { setModalAssinatura(false); setLink('') }}
          onConfirmar={async () => {
            if (!isValidUrl(link)) { toast({ title: 'O link informado não é válido.', variant: 'destructive' }); return }
            const ok = await chamar(`/api/solicitacoes/${id}/assinatura`, { link })
            if (ok) { setModalAssinatura(false); setLink('') }
          }}
        />
      )}

      {modalDevolucao && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setModalDevolucao(false)} />
          <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl p-6 w-full max-w-md space-y-4">
            <h3 className="font-semibold text-gray-900 dark:text-white">Registrar devolução</h3>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Condição *</label>
              <select
                value={condicao}
                onChange={(e) => setCondicao(e.target.value as CondicaoDevolucao | '')}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition"
              >
                <option value="">Selecione a condição</option>
                {Object.entries(CONDICAO_DEVOLUCAO_LABELS).map(([valor, label]) => (
                  <option key={valor} value={valor}>{label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Descrição / Observação {condicao && condicao !== 'SEM_AVARIAS' ? '*' : '(opcional)'}
              </label>
              <textarea
                value={obsDevolucao}
                onChange={(e) => setObsDevolucao(e.target.value)}
                rows={3}
                maxLength={1000}
                placeholder={condicao && condicao !== 'SEM_AVARIAS' ? 'Descreva o problema encontrado (obrigatório).' : ''}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition"
              />
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setModalDevolucao(false)} className="px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-sm font-medium">Cancelar</button>
              <button
                onClick={async () => {
                  if (!condicao) { toast({ title: 'Selecione a condição de devolução.', variant: 'destructive' }); return }
                  if (condicao !== 'SEM_AVARIAS' && !obsDevolucao.trim()) {
                    toast({ title: 'Descreva o problema encontrado na devolução.', variant: 'destructive' })
                    return
                  }
                  const ok = await chamar(`/api/solicitacoes/${id}/devolucao`, { condicao, observacoes: obsDevolucao })
                  if (ok) { setModalDevolucao(false); setCondicao(''); setObsDevolucao('') }
                }}
                disabled={!!acao}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium disabled:opacity-60"
              >
                {acao ? <Loader2 size={14} className="animate-spin" /> : null} Confirmar devolução
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmCancelar}
        title="Cancelar solicitação"
        description="Tem certeza que deseja cancelar esta solicitação? Esta ação não pode ser desfeita."
        confirmLabel="Cancelar solicitação"
        variant="danger"
        loading={!!acao}
        onCancel={() => setConfirmCancelar(false)}
        onConfirm={async () => { const ok = await chamar(`/api/solicitacoes/${id}/cancelar`); if (ok) setConfirmCancelar(false) }}
      />

      <ConfirmDialog
        open={confirmNaoRetirado}
        title="Marcar como não retirado?"
        description="Confirme que o solicitante não compareceu para retirar os itens desta solicitação. Esta ação encerrará o fluxo da solicitação e liberará os bens para novas reservas."
        confirmLabel="Confirmar não retirada"
        variant="warning"
        loading={!!acao}
        onCancel={() => setConfirmNaoRetirado(false)}
        onConfirm={async () => { const ok = await chamar(`/api/solicitacoes/${id}/nao-retirada`, {}); if (ok) setConfirmNaoRetirado(false) }}
      />

      <ConfirmDialog
        open={confirmAssinatura}
        title="Confirmar assinatura"
        description="Confirma que os documentos foram assinados no sistema institucional?"
        confirmLabel="Confirmar"
        variant="warning"
        loading={!!acao}
        onCancel={() => setConfirmAssinatura(false)}
        onConfirm={async () => { const ok = await chamar(`/api/solicitacoes/${id}/assinatura/confirmar`); if (ok) setConfirmAssinatura(false) }}
      />
    </div>
  )
}

function Info({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null
  return (
    <div>
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">{label}</p>
      <p className="text-gray-800 dark:text-gray-200">{value}</p>
    </div>
  )
}

function BotaoAcao({ icon, label, cor, loading, outline, onClick }: {
  icon: React.ReactNode; label: string; cor: 'green' | 'red' | 'blue' | 'gray'; loading?: boolean; outline?: boolean; onClick: () => void
}) {
  const cores: Record<string, string> = {
    green: outline ? 'border-2 border-emerald-500 text-emerald-600' : 'bg-emerald-600 text-white',
    red: outline ? 'border-2 border-red-500 text-red-600' : 'bg-red-600 text-white',
    blue: outline ? 'border-2 border-brand text-brand' : 'bg-brand text-white',
    gray: outline ? 'border-2 border-gray-300 text-gray-600' : 'bg-gray-600 text-white',
  }
  return (
    <button onClick={onClick} disabled={loading} className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium disabled:opacity-60 ${cores[cor]}`}>
      {loading ? <Loader2 size={16} className="animate-spin" /> : icon}
      {label}
    </button>
  )
}

function ModalTexto({ titulo, descricao, valor, onChange, onCancelar, onConfirmar, loading, placeholder, maxLength }: {
  titulo: string; descricao: string; valor: string; onChange: (v: string) => void
  onCancelar: () => void; onConfirmar: () => void; loading?: boolean; placeholder?: string; maxLength?: number
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onCancelar} />
      <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl p-6 w-full max-w-md space-y-4">
        <div>
          <h3 className="font-semibold text-gray-900 dark:text-white">{titulo}</h3>
          <p className="text-sm text-gray-500 mt-1">{descricao}</p>
        </div>
        <textarea
          value={valor}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={3}
          maxLength={maxLength}
          className="w-full px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition"
        />
        <div className="flex justify-end gap-3">
          <button onClick={onCancelar} className="px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-sm font-medium">Cancelar</button>
          <button onClick={onConfirmar} disabled={loading || !valor.trim()} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium disabled:opacity-60">
            {loading ? <Loader2 size={14} className="animate-spin" /> : null} Confirmar
          </button>
        </div>
      </div>
    </div>
  )
}
