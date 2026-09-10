// prisma/seed.ts
// Seed DEMONSTRATIVO do Fluxo Patrimonial — dados 100% fictícios, pensados
// para popular o Dashboard, o Painel do Patrimônio, Minhas Reservas, Todas
// as Reservas e Aprovações com um cenário realista de portfólio.
// Idempotente: usuários/categorias/serviços/patrimônios usam upsert; as
// solicitações de demonstração só são criadas se ainda não existir nenhuma
// (não há um identificador de negócio natural para fazer upsert nelas).
//
// O dataset em si (quais usuários/categorias/patrimônios/solicitações
// existem) NÃO é definido aqui — vive em src/lib/demo/dataset.ts, a MESMA
// fonte usada pela rota de reset da demo pública
// (POST /api/internal/demo-reset). Nunca duplicar a definição do dataset
// entre os dois lugares.
//
// Import relativo (não "@/lib/..."): `npm run db:seed` roda via
// `ts-node --compiler-options '{"module":"CommonJS"}'`, sem
// `tsconfig-paths/register` — só alias "@/*" funciona nos scripts/test-*.ts
// (que rodam com esse register habilitado), não aqui.
import { PrismaClient } from '@prisma/client'
import {
  popularUsuariosDemo,
  popularCategoriasDemo,
  popularTiposServicoDemo,
  popularPatrimoniosDemo,
  popularSolicitacoesDemo,
} from '../src/lib/demo/dataset'

const prisma = new PrismaClient()

async function main() {
  console.log('🌱 Iniciando seed demonstrativo do Fluxo Patrimonial...')

  // restaurarExistentes: false — o seed inicial NUNCA sobrescreve um
  // usuário já existente (diferente do reset da demo, que restaura os
  // valores canônicos a cada execução).
  const { idsPorEmail: usuariosIdsPorEmail, senhasGeradas } = await popularUsuariosDemo(prisma, {
    restaurarExistentes: false,
  })
  console.log('✅ Usuários (existentes ou criados):', Object.keys(usuariosIdsPorEmail))

  const categoriasIdsPorNome = await popularCategoriasDemo(prisma)
  console.log('✅ Categorias:', Object.keys(categoriasIdsPorNome).join(', '))

  await popularTiposServicoDemo(prisma)
  console.log('✅ Tipos de serviço populados.')

  const patrimoniosIdsPorNumero = await popularPatrimoniosDemo(prisma, categoriasIdsPorNome)
  console.log('✅ Patrimônios:', Object.keys(patrimoniosIdsPorNumero).length)

  const jaTemSolicitacoes = (await prisma.solicitacao.count()) > 0
  if (jaTemSolicitacoes) {
    console.log('ℹ️  Já existem solicitações no banco — nenhuma solicitação demonstrativa foi criada.')
  } else {
    await popularSolicitacoesDemo(prisma, usuariosIdsPorEmail, patrimoniosIdsPorNumero)
    console.log('✅ Solicitações e notificações demonstrativas criadas.')
  }

  console.log('\n🎉 Seed demonstrativo concluído com sucesso!')

  if (Object.keys(senhasGeradas).length > 0) {
    console.log('\n📋 Credenciais de acesso (senha temporária, gerada só nesta execução):')
    for (const [email, senha] of Object.entries(senhasGeradas)) {
      console.log(`  ${email.padEnd(20)} | ${senha}`)
    }
    console.log('\n⚠️  Estas senhas só aparecem aqui, uma única vez, e nunca são gravadas em texto plano.')
    console.log('⚠️  Troque-as no primeiro acesso (menu "Minha Conta" → "Alterar Senha").')
  } else {
    console.log('\nℹ️  Nenhum usuário novo foi criado nesta execução — senhas existentes preservadas.')
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
