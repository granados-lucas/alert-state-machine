# Qualidade

## Comandos

| Comando | O que prova |
|---|---|
| `pnpm lint` | ESLint com presets oficiais do Next/TypeScript, limite de 350 linhas, sem `console` direto, sem acesso a dados na apresentação, guardas de `update`/`delete` do Drizzle |
| `pnpm typecheck` | `next typegen` e `tsc --noEmit` com TypeScript estrito |
| `pnpm lint:typed` | `no-floating-promises` e `no-misused-promises` como erro (config `eslint.typed.config.mjs`) |
| `pnpm lint:rules` | Auto-verificação das regras locais em `eslint-rules/` |
| `pnpm test` | Vitest em Node, sem servidor de banco: domínio, adaptador do Datadog, ingestão, alertas, remediação, rotas da API e utilitários. O SQL e os triggers rodam em PGlite com as migrações reais |
| `pnpm test:coverage` | O mesmo com cobertura V8 e limites mínimos: 90% de statements/linhas/funções e 80% de branches (`vitest.config.mts`) |
| `pnpm test:simulator` | Testes da aplicação separada `simulator/` (catálogo, payloads, oráculo, receptor) |
| `pnpm build` | Build de produção do Next.js, sem credenciais |
| `pnpm check` | lint, tipos, lint tipado, regras, cobertura, testes do simulador e build. Não conecta a banco real nem aplica migração |
| `docker compose --profile simulator up --build --abort-on-container-exit --exit-code-from simulator simulator` | Validação ponta a ponta contra PostgreSQL real: 32 aplicações, 200 alertas, 1500 eventos e comparação com um oráculo (código 0 = tudo bateu) |

Rode `pnpm check` antes de concluir uma mudança; use `pnpm test` ou um arquivo específico durante o desenvolvimento.

## Regras base

- TypeScript estrito e presets oficiais do framework.
- Limite de 350 linhas por arquivo; organização proporcional ao comportamento.
- Logs estruturados no servidor; sem acesso a dados direto da apresentação.
- Com Drizzle, `update`/`delete` sem `where` falham no lint; revisar consultas e migrações.
- Validação de entrada e ambiente com Zod; erros sem segredos; testes de fronteira relevantes.

## Estratégia de testes

Pirâmide: domínio puro e adaptador (rápidos) → serviços e rotas com PGlite → ponta a ponta no Docker com o simulador.

- **Cobertura medida em 2026-10-23** (`pnpm test:coverage`, 91 testes): statements 97,5%, branches 93,6%, funções 99,2%, linhas 99,4%. Escopo: todo `src/**/*.ts` exceto testes, `src/test/` e o esquema/constantes de UI (`src/db/schema`, `meta.ts`). Telas `.tsx` **não entram na cobertura**: são verificadas por build, tipos, lint e pelo smoke test HTTP; lógica de tela vive em `.ts` testáveis (layout do mapa, geometria, payload do formulário). Não há teste de interface em navegador.
- **O que PGlite não prova:** concorrência real entre conexões. Ele roda numa conexão só; o teste de "eventos concorrentes" ali valida lógica, não bloqueio. A concorrência (duplicatas simultâneas, 12 monitores em paralelo, pool, DNS) é validada pelo simulador contra o PostgreSQL do compose, e foi ele que achou o defeito de esgotamento de threads/pool descrito em `docs/architecture.md`.
- **O simulador** (aplicação separada) verifica por oráculo: resposta de cada evento (`applied/unchanged/stale/duplicate`, 401, 400), estado final de cada alerta, nº de `state_changed` por alerta, status por aplicação e por jornada, composição das jornadas, aplicações sem jornada e contagem exata de remediações (incluindo header `env:` resolvido e destino que responde 503). Última execução: 1500 eventos em ~9 s (~160/s), 0 divergências.
- Não há teste de carga sustentada, de falha do banco no meio da transação em PostgreSQL real, nem E2E em navegador.

Capacidades adotadas (evidência em `docs/setup.md`):

- `next-dev-loop`: **pendente** — exige `agent-browser` no PATH (preparo de máquina).
- `next-bundle-optimizer`: `next analyze` está disponível no Next.js 16.4.3 (apenas Turbopack); nenhuma auditoria executada.
- `supabase-postgres-best-practices`: consultada para o esquema (chaves por identidade, FKs indexadas, índice parcial, `timestamptz`, paginação por cursor). Sem `EXPLAIN ANALYZE` em volume real ainda.

Lint tipado: duas regras assíncronas focadas, severidade `error`, comando `pnpm lint:typed`. Custo medido em 2026-10-23 no Windows/Node 24.22: ~6 s (o `pnpm lint` completo levou ~36 s na primeira execução, com cache frio). Sem limitação de compatibilidade ou recurso.

## Revisão após implementação

Escolher o escopo pelo risco e pelo diff real. Para trabalho não trivial, usar revisão independente quando disponível. Registrar alvo exato, chamadores/contratos/testes conectados, achados confirmados e cobertura. Encerrar quando os achados relevantes estiverem resolvidos ou explicitamente tratados, os checks afetados passarem e os riscos residuais registrados.

## Revisão de segurança

O webhook é a principal superfície de ataque (entrada não autenticada por natureza). Fonte reutilizável, versionada:

- Prompt: bloco "Prompt" de `docs/prompts/13-security-review.md` do toolkit na revisão `790a895304e0c08b70a5b215c9d334f1c86b816c` — <https://raw.githubusercontent.com/soumatheusgomes/vibe-coding-toolkit/790a895304e0c08b70a5b215c9d334f1c86b816c/docs/prompts/13-security-review.md>
- Invocação (repositório inteiro): "Leia a URL acima e execute todo o bloco Prompt neste repositório. Use o modo repositório, preserve meu cliente/modelo/autenticação e salve um relatório redigido fora do repositório." Para um diff: "Use o modo diff, base=<ref>, head=<ref>, comparação=endpoint ou merge-base, dirty=excluir ou incluir" com refs reais.
- Skill opcional para diffs: `differential-review` (instalada em `.claude/skills/`).
- Relatórios ficam privados, fora do repositório; somente leitura; correções só com pedido separado. "Sem achados" não é garantia de segurança.
- Atualização: reler o prompt na revisão desejada, registrar a nova revisão aqui e em `docs/setup.md`. **Nenhuma revisão de segurança formal foi executada** apesar de já existir superfície sensível (webhook, API de gestão, chamadas de saída). Recomenda-se rodar o prompt em modo repositório antes de expor o sistema.

## Harness

Método nativo inspirado no Harness2, adaptado ao cliente atual (não executa o framework Harness2 nem reproduz seus resultados). Fonte reutilizável: `docs/prompts/15-harness-improvement.md`, mesma revisão do toolkit — <https://raw.githubusercontent.com/soumatheusgomes/vibe-coding-toolkit/790a895304e0c08b70a5b215c9d334f1c86b816c/docs/prompts/15-harness-improvement.md>. Invocação: "Leia a URL e execute a seção Prompt para configurar um fluxo limitado de melhoria de harness neste projeto." Casos de avaliação: `docs/07-harness-evaluation.md` e prompt 14 do toolkit. Rodar de novo os casos relevantes após mudanças em instruções, memória, skills ou orquestração. Resultados iniciais em `docs/setup.md`; um caso que passa é teste de fumaça, não taxa de confiabilidade.

## Dependências e entrega

Auditoria completa e de produção são separadas. Passar em lint/build não significa auditoria limpa. Estado em 2026-10-23: produção sem vulnerabilidades; desenvolvimento com 1 advisory moderado (ver `docs/onboarding.md`). Checks são comandos explícitos; sem hooks do Git nem bloqueios de push por padrão. Atualizar este documento junto com scripts e regras.
