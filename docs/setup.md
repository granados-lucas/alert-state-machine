# Setup e evidências

Estados usados: **validado** (executado e observado), **configurado sem execução**, **pendente**.

## Origem e contexto

- Data: 2026-10-23.
- Toolkit: `soumatheusgomes/vibe-coding-toolkit`, revisão única `790a895304e0c08b70a5b215c9d334f1c86b816c` (prompt 11, guias 04/06, `docs/tools/`, templates). Obtido em diretório temporário fora do projeto; nada do repositório do toolkit foi copiado além dos templates aplicados.
- Produto: Global Alerts (ver `PRODUCT.md`).
- Cliente: Claude Code 2.1.303 (extensão VS Code), modelo `claude-sonnet-5-5`, autenticação da sessão preservada; sem API paga, proxy ou troca de provedor. Política de subagentes: nenhuma autorizada nesta execução; a sessão não delegou.
- Runtime: Windows 10, Node 24.22.0 (via `fnm`, não estava no PATH da sessão), pnpm 12.11.2.

## Decisões e fontes

| Decisão | Motivo | Fonte / data |
|---|---|---|
| `create-next-app@latest` com flags explícitas (`--typescript --tailwind --eslint --app --src-dir --import-alias '@/*' --use-pnpm --disable-git --no-react-compiler --no-cache-components --no-agent-feedback`) | Canal estável: `next@latest` = 16.4.3; `canary`, `preview` e `beta` não usados | `npm view next dist-tags`, `create-next-app --help`, 2026-10-23 |
| `@types/node@24` | Alinha com Node 24 e com os peers do Vitest | `pnpm add`, 2026-10-23 |
| `@next/env` fixado em 16.4.3 | Alinhado ao Next | idem |
| `esbuild: false` em `allowBuilds` (`pnpm-workspace.yaml`) | pnpm 12 bloqueia scripts de build e falhava a instalação; o binário do esbuild vem de pacote de plataforma, sem precisar do script | `pnpm add` falhou com `ERR_PNPM_IGNORED_BUILDS`; `db:generate`, testes e build passam |
| Skills em modo `--copy`, só para `claude-code` | Windows: evita junctions com caminho absoluto; único cliente em uso. Codex existe na máquina, mas não foi selecionado | guia 16 do toolkit |
| Página inicial trocada por placeholder do produto, `lang="pt-BR"` | Remover boilerplate do scaffold; nenhuma funcionalidade implementada | — |
| `.gitignore`: `!.env.example` e `graphify-out/` | O scaffold ignorava `.env*` | — |

Context7: o plugin está habilitado, mas o servidor MCP respondeu "Needs authentication" em `claude mcp list`; consulta real **pendente**. Não foi criado `.mcp.json` local porque já existe integração de plugin (o toolkit manda reutilizar). As decisões acima usaram `--help` do CLI, o registro npm e os guias do toolkit.

## Componentes

Pacotes (de `pnpm list --depth 0`): next 16.4.3, react/react-dom 19.3.0, typescript 5.9.3, tailwindcss 4.3.3, drizzle-orm 0.45.4, drizzle-kit 0.31.11, pg 8.23.1, zod 4.6.7, pino 10.4.0, vitest 5.0.5, eslint 9.39.5, eslint-config-next 16.4.3, eslint-plugin-drizzle 0.2.3, clsx 2.1.1, tailwind-merge 3.7.0, server-only 0.0.1. Lockfile único: `pnpm-lock.yaml`.

| Componente | Ação e motivo | Escopo | Estado e evidência |
|---|---|---|---|
| Ponytail 5.3.2, Caveman 4.0.1, Superpowers 7.0.0 | Reutilizados; acordos gravados em `AGENTS.md` | Usuário (plugin) | Habilitados em `claude plugin list`; a sessão carregou as skills (Ponytail e Superpowers aparecem na lista de skills). Descoberta em sessão nova: pendente |
| RTK 1.0.1 | Reutilizado | Máquina | Hook `rtk hook claude` presente em `~/.claude/settings.json`; comandos desta sessão passaram pelo hook. Validado |
| Context7 1.0.4 | Reutilizado | Usuário (plugin) | Habilitado; MCP sem autenticação. Consulta real **pendente** |
| Graphify | Reutilizado; `.graphifyignore` copiado | Projeto | `GRAPHIFY_NO_AUTO_REFRESH=1 graphify extract . --code-only --no-cluster`: 25 arquivos de código, 145 nós, 194 arestas em `graphify-out/graph.json`. Validado (8 arquivos sem símbolos, como config/schema vazio). Sem hooks de refresh |
| Skills Vercel (8) + `find-skills` | Instaladas de `vercel-labs/agent-skills` e `vercel-labs/skills`; catálogo upstream conferido em 2026-10-23, sem renomeações; `vercel-react-native-skills` omitida (sem mobile) | Projeto, `.claude/skills/`, `skills-lock.json` | Instaladas; `skills list --agent claude-code` lista as 12 skills do projeto. Descoberta pelo cliente em sessão nova: pendente |
| `next-dev-loop` | Instalada; Next 16.4.3 + Turbopack compatíveis | Projeto | Instalada. Execução **pendente**: `agent-browser` não está no PATH (preparo de máquina, não instalado) |
| `next-bundle-optimizer` | Instalada | Projeto | Instalada; `next analyze --help` existe (somente Turbopack). Nenhuma auditoria executada |
| `supabase-postgres-best-practices` | Instalada: o projeto usa PostgreSQL via Drizzle; provedor não definido, sem SDK Supabase | Projeto | Instalada; nenhum SQL real ainda |
| `differential-review` (Trail of Bits) | Instalada: o webhook é sensível à segurança | Projeto | Instalada; nenhuma revisão executada |
| `gh-fix-ci` | **Não selecionada**: fluxo suportado é Codex + GitHub Actions; o cliente aqui é Claude Code e não há remoto/CI | — | Reavaliar se o projeto ganhar GitHub Actions e Codex |
| `shadcn` | **Não selecionada**: nenhum shadcn/ui adotado | — | Reavaliar ao escolher a UI |
| Sentry MCP | **Não configurado**: nenhum serviço/organização escolhido | — | Pendente de decisão externa |
| Harness2 (método nativo) | Adaptação nativa padrão; ver `docs/quality.md` | Projeto | Procedimento reutilizável registrado; fumaça inicial abaixo. CLI oficial não selecionada (nenhum lab, nenhum benchmark autorizado) |
| Prompt de revisão de segurança | Referência versionada (sem cópia, pois não há pasta de prompts) | Projeto | Registrada em `docs/quality.md`; nenhuma revisão executada |

Não foi instalado nenhum hook do Git, bloqueio em `main` ou exigência de branch/worktree.

## Documentação criada

`PRODUCT.md`, `README.md`, `AGENTS.md` (com o bloco gerado pelo Next preservado), `CLAUDE.md` (`@AGENTS.md`), `docs/architecture.md`, `docs/design.md`, `docs/onboarding.md`, `docs/quality.md` e `docs/setup.md` têm conteúdo específico do projeto. O diretório só continha `.git` (sem commits), então não houve arquivos anteriores para preservar ou consolidar. Nada foi commitado.

## Verificações

| Item | Estado | Evidência |
|---|---|---|
| `pnpm lint` | Validado | saída 0 (~36 s, cache frio) |
| `pnpm typecheck` | Validado | saída 0 (~7 s) |
| `pnpm lint:typed` | Validado | saída 0 (~6 s) |
| `pnpm lint:rules` | Validado | 3 regras `ok` |
| `pnpm test` | Validado | 3 arquivos, 8 testes passando (mocks; sem banco) |
| `pnpm build` | Validado | Next 16.4.3, rotas `/` e `/_not-found` estáticas |
| `pnpm check` | Validado | saída 0, ~50 s, sem credenciais |
| `pnpm db:generate` | Validado | "0 tables… nothing to migrate"; sem esquema não há SQL para revisar |
| Banco real / migração | Pendente | sem `DATABASE_URL` autorizada; nada foi conectado ou migrado |
| App em porta livre | Validado | `next start` em porta efêmera: HTTP 200, conteúdo "Global Alerts" e `lang="pt-BR"`; processo criado pelo setup foi encerrado |
| `pnpm audit --prod` | Validado | sem vulnerabilidades conhecidas |
| `pnpm audit` (completo) | 1 advisory moderado | esbuild via `drizzle-kit>@esbuild-kit/*` (GHSA-67mh-4wv8-2f99), só desenvolvimento; correção exigiria override forçado, não aplicado |
| Graphify | Validado | ver Componentes |

Recursos temporários criados: clone do toolkit e cópia do fixture do harness no diretório scratchpad da sessão (fora do projeto); servidor `next start` encerrado. Dependências instaladas permanecem em `node_modules/` (ignorado).

## Memória e harness

- **Memória:** fonte canônica é o conjunto versionado `AGENTS.md` + `docs/`; `CLAUDE.md` importa `AGENTS.md`, que o Claude Code carrega no início da sessão. A memória nativa do Claude Code (diretório de projeto em `~/.claude/projects/…/memory`, índice `MEMORY.md`) é complementar e começa vazia. Regras: memória durável registra fonte, última verificação (data) e gatilho de invalidação; conferir contra o código antes de usar. Recuperação em contexto limpo: **não executada** nesta sessão (exigiria nova sessão ou subagente, não autorizados aqui).
- **Casos de harness** (toolkit `790a895…`, avaliador `scripts/validate-harness.mjs` SHA-256 `EBC2CDD04021BCC18348A302394BDCEABB80700FDC0F569F3EF859A9E8A55B8C`, Node 24.22.0):
  - Avaliador contra o fixture intacto (cópia descartável): 7 testes, 5 passam e 2 falham exatamente nos esperados (isolamento entre tenants e identidades inválidas). Isso valida o avaliador, **não** o comportamento do agente.
  - Casos de agente (correção de fronteira, handoff obsoleto, revisão somente leitura, reaplicar setup, conflito de recurso, bloqueio parcial, parar e retomar): **não executados**. Motivo: exigem contexto independente (subagente ou sessão nova), que não foi autorizado nesta execução; a própria sessão que fez o setup não serve como observação independente.
  - Nenhuma falha observada justificou comparação de candidato; as instruções existentes foram preservadas.
- Reaplicar o setup: preservar `AGENTS.md`, documentos e skills; reaproveitar evidências inalteradas; rerodar `pnpm check` e os casos relevantes se cliente, modelo ou instruções mudarem materialmente.

## Pendências e próxima entrega

Pendências: definição dos estados/transições e do payload e autenticação do webhook do Datadog (ver `PRODUCT.md`); autenticação de usuários; hospedagem e PostgreSQL; biblioteca de grafo; consulta real ao Context7 (autenticar o plugin); `agent-browser` para `next-dev-loop`; casos de harness com contexto independente; commit inicial (nada foi commitado).

Próxima entrega: primeiro webhook ponta a ponta (ver `PRODUCT.md`). Após o setup foram implementados o domínio `src/domain/alert-machine` e a página `/graph` com React Flow. Publicação e serviços externos exigem autorização específica.

## Fase 2 — funcionalidades (2026-10-23)

Webhook do Datadog, mapa por aplicação, remediação, auditoria, API de gestão, Docker e simulador. Detalhes em `PRODUCT.md`, `docs/architecture.md` e `docs/integrations/datadog.md`.

| Item | Estado | Evidência |
|---|---|---|
| Estudo das APIs do Datadog | Validado contra a documentação oficial; três pontos **pendentes** de teste com webhook real | `docs/integrations/datadog.md` (valores de `$ALERT_TRANSITION` Warn/No Data, escape de JSON, autenticação da Monitors API). O Context7 seguiu sem autenticação; as páginas foram lidas por WebFetch/WebSearch |
| Dependências novas | `@xyflow/react` 12.12.0; dev: `@electric-sql/pglite` 0.5.11, `@vitest/coverage-v8` 5.0.5 | `pnpm-lock.yaml` |
| `pnpm check` | Validado | lint, tipos, lint tipado, regras, 91 testes com cobertura (stmts 97,5%, branches 93,6%, funções 99,2%, linhas 99,4%), 8 testes do simulador, build |
| Migrações em PostgreSQL 17 real | Validado | serviço `migrate` do compose criou as 7 tabelas (`\dt`); trigger de auditoria exercitado nos testes (PGlite) |
| Stack Docker | Validado | `docker compose up --build`: db saudável, migrate encerra com 0, app saudável (`/api/health`) |
| Simulador (32 apps, 200 alertas, 1500 eventos) | Validado | 0 divergências contra o oráculo: estado e auditoria de cada alerta, status das 32 aplicações, dependências, 94 chamadas de remediação esperadas = 94 recebidas; ~160 eventos/s |
| Defeito achado pelo simulador | Corrigido | Remediação para host que não resolve esgotava as threads do libuv e o pool do banco (500 em cascata). Correção: limite de 4 chamadas simultâneas + fila, `UV_THREADPOOL_SIZE=16`; teste unitário do limite |
| Páginas | Verificado por HTTP | `/`, `/alerts`, `/alerts/1`, `/alerts/new`, `/applications/checkout`, `/graph` = 200; id/aplicação inexistente = 404. **Sem verificação visual em navegador** |
| Revisão de segurança formal | **Não executada** | Recomendada antes de expor o sistema (ver `docs/quality.md`) |
| Autenticação de usuários | **Fora da aplicação (decisão do MVP)** | O token de administração foi removido em 2026-10-24; o SSO corporativo fica na frente e a aplicação confia no cabeçalho de identidade |

Recursos criados e deixados em execução: stack `global-alerts` no Docker (db, app), volume `pgdata` com os dados do último simulador. Para remover: `docker compose down -v`.

## Fase 3 — redesign (2026-10-23)

Design system FlowPay aplicado (escuro, acento roxo, Inter, barra lateral, KPIs, cards, tabelas, formulário em seções). Tokens e decisões em `docs/design.md`. Verificação: `pnpm check` (94 testes; cobertura 97,6% stmts, 93,8% branches, 99,2% funções, 99,4% linhas), build Docker e capturas do Chrome headless das 6 telas. Defeitos achados nas capturas e corrigidos: minimapa vazio (nós sem tamanho explícito em fluxo controlado), rótulos de arestas sobrepostos, mapa ilegível com 32 aplicações (zoom semântico). Instável observado: o Vitest abortava com PGlite em paralelo total no Windows (exit 0x80000003); com `maxWorkers: 2` passou 4 de 4 execuções. **Pendente:** tema claro, revisão em celular, medição de contraste e leitor de tela.

## Fase 4 — jornadas no lugar de dependências (2026-10-24)

A pedido do solicitante, as ligações entre aplicações foram removidas e o mapa passou a ser de **jornadas** (N:N com aplicações). Detalhes em `PRODUCT.md` e `docs/architecture.md`.

| Item | Estado | Evidência |
|---|---|---|
| Migrações 0002 (remove `application_dependencies`) e 0003 (jornadas + valores de enum) | Validado em PostgreSQL 17 real, **sobre dados existentes** | `docker compose up --build` aplicou as duas num banco que já tinha 200 alertas; 8 jornadas e 52 vínculos criados depois |
| `pnpm check` | Validado | 104 testes (cobertura 96,9% statements, 92,7% branches, 99,4% funções, 99,1% linhas) + 11 do simulador |
| Simulador de verificação (32 apps, 200 alertas, 8 jornadas, 1500 eventos) | Validado | 0 divergências: estado de cada alerta, auditoria, status de cada aplicação e de cada jornada, composição das jornadas, 2 aplicações sem jornada, 94 remediações; ~260 eventos/s |
| Modo demonstração | Validado | ~0,6 mudança de estado/s; ~4,5% dos alertas fora de OK; mapa com jornadas vermelhas, âmbar e (às vezes) verdes |
| Telas | Verificado por capturas do Chrome headless e HTTP | `/`, `/journeys/[id]`, `/journeys/new`, `/journeys/[id]/edit`, `/applications/[name]`, `/alerts/[id]`. **Não testei o envio dos formulários em navegador** (a API é coberta por testes) |
| Dados | Reiniciados | `docker compose down -v` apagou o banco anterior (só dados do simulador) |

## Fase 5 — silenciar monitores no Datadog (2026-10-24)

| Item | Estado | Evidência |
|---|---|---|
| Estudo da API (mute/unmute v1, Downtimes v2) | Lido nas páginas oficiais; pontos **não verificados** listados | `docs/integrations/datadog.md` |
| Migração 0004 (colunas `muted_*`, 3 valores de enum) | Validada em PostgreSQL 17 real **sobre dados existentes** | `docker compose up --build` com 200 alertas já gravados |
| `pnpm check` | Validado | 139 testes (cobertura 96,4% stmts, 92,9% branches, 98,3% funções, 98,5% linhas) + 13 do simulador |
| Simulador com Datadog simulado | Validado | 0 divergências: 6 silenciados (prazo ~3600 s e escopo conferidos no Datadog simulado), estado mudado sem webhook, 3 reativados com estado sincronizado, 3 ainda silenciados, 1 recusado (403 → 502, auditado, nada gravado), 95 remediações |
| Chamada ao Datadog **real** | **Não executada** | Sem chaves nem conta de teste; só mocks e o simulador |
| Tela do alerta | Verificado por captura do Chrome headless | Cartão "Silêncio no Datadog", etiqueta "Silenciado", auditoria. O envio do formulário em navegador **não foi testado** (a API sim) |
| Dados | Reiniciados | `docker compose down -v` (só dados do simulador) |

## Fase 6 — token de administração removido (2026-10-24)

A pedido do solicitante: o `ADMIN_API_TOKEN` saiu (API, formulários, simulador, compose, testes). A aplicação passa a confiar no SSO corporativo que ficará na frente e lê a identidade em `AUTH_USER_HEADER` (padrão `x-forwarded-email`). Ver `docs/architecture.md` ("Identidade e autorização") para o que o deploy precisa garantir. Evidência: ver a seção de verificação abaixo.

## Fase 7 — equivalência de estados e reconciliação (2026-10-24)

| Item | Estado | Evidência |
|---|---|---|
| Equivalência de estados (`providers/datadog/states.ts`) | Validada por testes; **semântica de Unknown/Skipped/Ignored não verificada** | Teste garante cobertura do enum documentado; decisão de produto registrada em `docs/integrations/datadog.md` |
| Estudo dos limites da API | Lido (Get all monitors, Rate Limits) | A documentação **não publica números por endpoint**; usamos os cabeçalhos `X-RateLimit-*` |
| Migrações 0005 e 0006 | Validadas em PostgreSQL 17 real **sobre dados existentes** | 200 alertas preservados ao subir a stack |
| `pnpm check` | Validado | 182 testes (cobertura 97,4% stmts, 94,3% branches, 97,7% funções, 97,9% linhas), 14 do simulador, 5 do script |
| Simulador ponta a ponta | Validado | 0 divergências; reconciliação: 8 corrigidos, 3 criados, 2 mantidos, 1 ausente, 1×429 absorvido, nova execução idempotente |
| Script `scripts/reconcile.mjs` | Executado contra a stack Docker | simulação e execução real: 200 monitores em 5 páginas, 0 divergências; saída 0 |
| Chamada ao Datadog **real** | **Não executada** | Sem chaves/conta de teste |
## Fase 8 — várias fontes, silêncio atômico, pesos e observabilidade (2026-10-25)

| Item | Estado | Evidência |
|---|---|---|
| Pesos por prioridade (cor com rebaixamento e índice de saúde) | Validado | Testes de unidade e de integração; o oráculo independente do simulador confere cor e índice de 32 aplicações e 10 jornadas |
| Silenciar atômico (`mute_operations`: intenção, provedor, resultado) | Validado contra o Datadog **simulado** | Testes com falha injetada na gravação (a operação fica pendente e a recuperação conclui, expira ou falha), 409 durante a janela de espera, recuperação concorrente sem duplicar. **Idempotência do mute/unmute no Datadog real não verificada** |
| Migração 0007 | Validada em PostgreSQL 17 real **sobre dados existentes** | Stack com dados do modo demonstração atualizada sem perda |
| Webhook único (`POST /api/webhooks`, um `WEBHOOK_SECRET`, fonte no campo `source`) | Validado com a stack Docker | Decisão do solicitante em 2026-10-25 (simplicidade e troca fácil de ferramenta); o simulador envia as 4 fontes pela mesma URL e segredo. Custo assumido: um segredo só vale para todas as fontes |
| Página `/docs` (documentação dentro da aplicação) | Validada com a imagem Docker | Renderiza os Markdown do repositório no build (`src/server/docs.ts`, páginas estáticas). **Dependência nova: `marked` 18.1.0** (MIT, sem dependências; fonte: npm e README do pacote, consultada em 2026-10-26). Escolhida a 18.1.0, de 2026-10-05, e não a 18.1.2 publicada no mesmo dia da consulta. Sem migração automática de major. HTML cru dos arquivos é escapado; `.dockerignore` libera `PRODUCT.md` e `docs/**/*.md` para o build; o aviso de rastreamento do Turbopack foi resolvido com `turbopackIgnore` |
| Fontes CloudWatch (SNS), AppDynamics e genérica | Testadas com payloads montados a partir da documentação; **nunca com as ferramentas reais** | `docs/integrations/cloudwatch.md` e `appdynamics.md`: formatos do alarme, tipos de evento de encerramento e verificação de assinatura do SNS ficaram como pontos a validar |
| Observabilidade (`/api/metrics`, `/api/health/live`, `/status`, `X-Request-Id`) | Validada com a stack Docker | Métricas lidas após o simulador (webhooks por fonte e resultado, silêncios, chamadas à API, reconciliações, remediações); formato **não** consumido por um Prometheus real |
| `pnpm check` | Validado | 240 testes (cobertura 97,3% stmts, 94,4% branches, 97,6% funções, 97,9% linhas), 17 do simulador, 5 do script |
| Simulador ponta a ponta (base zerada) | Validado | 0 divergências: 200 alertas, 96 remediações, silêncio, reconciliação e cenário multifonte (9 alertas de 3 fontes) |
