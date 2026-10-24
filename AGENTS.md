<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Global Alerts

## Produto e stack

- Produto e escopo: `PRODUCT.md`.
- Stack: Next.js 16 (App Router, Turbopack), React 19, TypeScript estrito, Tailwind 4, Drizzle ORM + PostgreSQL (`pg`), Zod, Pino, Vitest. Node 24, pnpm. Versões reais em `package.json`, `pnpm-lock.yaml` e `docs/setup.md`.
- Setup e validações: `docs/setup.md`.

## Comandos canônicos

- Instalar: `pnpm install`
- Desenvolver: `pnpm dev`
- Lint: `pnpm lint`
- Tipos: `pnpm typecheck` (gera tipos de rota com `next typegen`, depois `tsc`)
- Lint tipado (promises): `pnpm lint:typed`
- Regras locais de lint: `pnpm lint:rules`
- Testes: `pnpm test` (`pnpm test:watch` para observar)
- Build: `pnpm build`
- Verificar a fundação: `pnpm check` (nunca conecta ao banco nem aplica migrações)
- Cobertura: `pnpm test:coverage` (limites 90% / branches 80%). Simulador: `pnpm test:simulator`.
- SQL: `pnpm db:generate` gera sem conexão; `pnpm db:migrate` exige `DATABASE_URL` de destino autorizado.
- Docker: `docker compose up --build` (app em http://localhost:3000). Validação ponta a ponta com o simulador do Datadog: `docker compose --profile simulator up --build --abort-on-container-exit --exit-code-from simulator simulator`. Zerar dados: `docker compose down -v`.

No Windows, o Node 24 vem do `fnm`; se `node` não estiver no PATH da sessão, ative com `fnm env` antes dos comandos.

## Acordos de trabalho

- Ler código e instruções relevantes antes de editar. Declarar premissas que afetam comportamento ou escopo.
- Resolver o pedido com a menor mudança suficiente. Reutilizar padrões, componentes e dependências existentes.
- Preservar mudanças locais, validação, tratamento de erro, segurança, acessibilidade e requisitos explícitos.
- Não criar abstrações, arquitetura, opções, dependências ou funcionalidades para necessidades não pedidas.
- Rodar as verificações adequadas. Testar lógica relevante e regressões; mudanças triviais não precisam de testes que apenas espelham o código.
- Não transformar premissas em fatos nem integrações pendentes em resultados simulados.
- Continuar trabalho autorizado. Perguntar só por informação essencial ou ação fora da autorização.
- Publicar, contatar terceiros, gerar custo e ações destrutivas exigem autorização específica. Instalar uma ferramenta não concede essa autorização.

## Continuidade

- Um bloqueio interrompe só as tarefas dependentes; concluir as independentes que seguem seguras e autorizadas.
- Não repetir tentativa idêntica sem evidência nova. Respeitar limites de custo, tempo e tentativas.
- Ao retomar um handoff, conferir arquivos, Git, checks e processos reais. Não afirmar execução em segundo plano sem processo verificável.
- Trabalho inacabado entre sessões: handoff curto no registro de plano/tarefa existente (objetivo, estado verificado, pendências, próxima ação). Não virar memória permanente.

## Padrões e documentação

- Persistência: Drizzle + PostgreSQL. Esquema em `src/db/schema/`, SQL versionado em `drizzle/`, um único ponto de conexão em `src/db/index.ts` (pool limitado, preguiçoso). Gerar e revisar SQL antes de migrar para destino autorizado; nunca migrar em build ou requisição; sem `db:push`.
- Validar entrada e ambiente com Zod. Pino apenas no servidor, sem segredos nem corpos completos. Apresentação chama módulos de feature e não importa o cliente do banco.
- Preferir tipos inferidos, consultas parametrizadas, projeções explícitas, listagens limitadas e DTOs seguros.
- Consultar fontes oficiais atuais e canal estável antes de mudar stack/APIs; registrar fonte, motivo e resultado em `docs/setup.md`. Sem migração automática de major.
- Dono de cada assunto: `PRODUCT.md` escopo; `docs/architecture.md` estrutura e decisões; `docs/design.md` interface; `docs/onboarding.md` preparação; `docs/quality.md` checks. Atualizar o documento responsável na mesma mudança, sem duplicar regras.
- Memória: a fonte canônica é este arquivo e os documentos versionados; a memória nativa do Claude Code complementa. Local, carregamento e verificação em `docs/setup.md`. Memória durável registra fonte, última verificação e gatilho de invalidação; conferir contra o código atual.

## Ferramentas e estilo

- **Ponytail:** modo `full` para código. `stop ponytail` desativa.
- **Caveman:** conversa concisa no idioma do usuário, sem perder clareza. Código, documentação e commits em linguagem normal. `stop caveman` desativa.
- **Superpowers:** usar skills relevantes e dimensionar o fluxo ao escopo; instruções explícitas e execução já autorizada valem mais que aprovações repetidas.
- **Context7:** consultar documentação atual para APIs/bibliotecas, uma questão por vez, sem segredos nem código privado. Indisponível: usar fontes oficiais e registrar.
- **RTK:** hook nativo ativo no Claude Code; não envolver comandos duas vezes. `rtk proxy <comando>` para a saída original.
- **Graphify:** usar `graphify-out/graph.json` para perguntas estruturais; registrar quando desatualizado. Exclusões em `.graphifyignore`.
- **LLMs:** preservar cliente, modelo e autenticação autorizados. Não trocar provedor nem habilitar API paga ou proxy em silêncio.

Verificar instalação e descoberta antes de depender de uma ferramenta. Ausência exige registro ou alternativa suportada.

## Skills do projeto (`.claude/skills/`, versionadas, `skills-lock.json`)

- `vercel-react-best-practices`: escrever/revisar React e Next.js, dados e desempenho.
- `vercel-composition-patterns`: decisões concretas de composição de componentes.
- `web-design-guidelines`: revisão de interface e acessibilidade (usar nas telas do grafo).
- `writing-guidelines`: revisão de documentação e prosa.
- `vercel-react-view-transitions`: só se transições forem pedidas.
- `vercel-optimize`, `deploy-to-vercel`, `vercel-cli-with-tokens`: só com pedido e destino autorizados; o setup não publica.
- `find-skills`: descobrir capacidade ausente.
- `next-dev-loop`: feedback de runtime/navegador (exige `agent-browser` no PATH; pendente, ver `docs/setup.md`).
- `next-bundle-optimizer`: auditoria de bundle com evidência.
- `supabase-postgres-best-practices`: carregar antes de trabalho de esquema, SQL, migração ou desempenho PostgreSQL; preserva provedor e ORM.
- `differential-review`: revisar diffs sensíveis à segurança (webhook, autenticação, acesso a dados).

Instalar uma skill não executa suas ações. Não forçar animações, cache, deploy ou arquitetura só porque a skill existe.

Revisão de segurança: usar o prompt versionado referenciado em `docs/quality.md`; somente leitura, relatório privado fora do repositório, "sem achados" não é garantia.

## Git e colaboração

- Sem bloqueio de push em `main`, sem exigência de branch/worktree, sem hooks `pre-commit`/`pre-push` por padrão.
- Lint, tipos, testes e build são checks explícitos.
- Delegar quando pedido ou quando houver ganho real de isolamento/paralelismo; um escritor por arquivo.

## Convenções

- Alias `@/*` aponta para `src/`. Código de servidor importa `server-only`.
- Arquivos até 350 linhas (regra de lint). Sem `console.*` direto: usar o logger do servidor.
- A tabela de estados e transições é dado único consumido pela lógica e pelo grafo; não duplicar.
- Só `src/providers/<nome>` conhece o formato de uma ferramenta de monitoramento. Domínio e serviços usam `NormalizedEvent`.
- Serviços em `src/server` recebem o banco por parâmetro (`Db`); testes usam PGlite (`src/test/db.ts`). Concorrência real se valida no Docker com o simulador, não no PGlite.
- Sem login na aplicação: o SSO corporativo fica na frente e a identidade vem do cabeçalho `AUTH_USER_HEADER` (`actorOf`). Não reintroduzir tokens compartilhados; autorização por papel é pós-MVP.
- `audit_log` é só de inserção (trigger). Toda mutação de alerta/remediação/dependência grava auditoria com ator.
- Remediação é chamada de saída: respeitar allowlist, `env:NOME` para segredos e o limite de concorrência. Não afrouxar sem revisão de segurança.
- Ações de escrita no provedor (silenciar) passam por `AlertProvider.control` e `src/server/muting.ts`: prazo e motivo obrigatórios, chamar o provedor antes de gravar, auditar sucesso e falha, nunca logar chaves. Testar contra o Datadog simulado, não contra o real.
- `simulator/` é uma aplicação separada: só usa a API HTTP da principal e não importa código dela.
