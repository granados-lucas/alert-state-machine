# Combinações de alertas — plano de implementação

> **Para executores:** SUB-SKILL OBRIGATÓRIA: use superpowers:subagent-driven-development (recomendado) ou superpowers:executing-plans para executar este plano tarefa a tarefa. Os passos usam caixas de seleção (`- [ ]`).

**Objetivo:** observar 1 ou mais alertas existentes por uma regra (E, OU, PELO MENOS N) com duração, dar à combinação um estado próprio (`ok`, `pendente`, `alert`) e disparar automações (chamada ou webhook) na entrada em `alert` e na volta a `ok`, num menu novo que não toca o mapa de jornadas nem a saúde.

**Arquitetura:** regra e transição de estado são funções puras em `src/domain/combination`. Um avaliador em `src/server` lê o estado atual dos alertas no banco, trava a linha da combinação e grava a transição com auditoria; devolve as automações a executar depois do commit. Ele roda após cada alerta que muda de estado (dentro de `ingestEvent`) e por um processo periódico (~30 s) que chama `POST /api/combinations/evaluate`. A execução da automação reaproveita a função de saída da remediação.

**Stack:** Next.js 16 (App Router), React 19, TypeScript estrito, Drizzle + PostgreSQL (PGlite nos testes), Zod 4, Vitest, scripts Node sem dependências.

**Spec:** `docs/superpowers/specs/2026-11-06-combinacoes-de-alertas-design.md`

## Restrições globais

- Branch: `feat/combinacoes-de-alertas`. Um commit por tarefa. Não fazer push nem tag.
- Antes de editar Next.js: `AGENTS.md` manda ler o guia em `node_modules/next/dist/docs/` quando a tarefa tocar rotas ou páginas.
- Regras: `E` = todos, `OU` = pelo menos um, `PELO MENOS N` = N ou mais. Valores no banco e na API: `and`, `or`, `at_least`. Nada de "exatamente um".
- Estados da combinação: `ok`, `pending`, `alert`. Nasce `ok`. Rótulos na tela: "Normal", "Armando", "Alerta".
- "Alertando" = componente com `state = 'alert'`, **não arquivado** e **não silenciado** (`muted_until` no futuro). `warn`, `ok` e `no_data` não contam.
- Duração: `duration_seconds` de 0 a 86400. Duração 0 vai direto de `ok` para `alert`. Se a regra deixar de ser verdadeira, a contagem zera.
- Componentes: 1 a 20 alertas por combinação, sem repetição, todos existentes e não arquivados no momento de salvar. `min_count` entre 1 e o número de componentes, só com `at_least`.
- Automação: gatilhos só `alert` e `ok` (nunca `pending`). Mesmas regras de segurança da remediação (lista `REMEDIATION_ALLOWED_HOSTS`, `env:NOME`, URL sem credenciais, sem redirecionamento, limite de concorrência 4).
- Tela inicial, jornadas e índice de saúde **não mudam**. Combinações não entram em nenhum cálculo de saúde.
- Auditoria só de inserção. Toda mutação grava auditoria com ator.
- Arquivos ≤ 350 linhas. Sem `console.*`. Serviços de `src/server` recebem `Db`. Textos de interface em pt-BR.
- Cada tarefa termina com `pnpm lint`, `pnpm typecheck` e o teste da tarefa passando. A última tarefa roda `pnpm check`.

## Foco da revisão

Entradas e condições que a spec implica mas nenhum teste óbvio cobre; cada uma tem seu teste na tarefa dona:

1. Combinação com 1 componente e duração > 0 ("este alerta por 5 min"). Tarefa 1, 5.
2. Componente que sai de `alert` antes da duração e volta: a contagem recomeça do zero. Tarefa 1, 5.
3. Silêncio do componente expira sem nenhum evento (só o avaliador periódico percebe). Tarefa 5.
4. Dois avaliadores ao mesmo tempo geram uma transição, uma auditoria e uma automação. Tarefa 5.
5. Falha do avaliador dentro de `ingestEvent` não pode derrubar o webhook já gravado. Tarefa 7.
6. `at_least` com `min_count` maior que o número de componentes, ao criar e ao editar a lista de alertas. Tarefa 6.

---

### Tarefa 1: Regra e transição de estado (domínio puro)

**Arquivos:**
- Criar: `src/domain/combination/index.ts`
- Teste: `src/domain/combination/index.test.ts`

**Interfaces:**
- Produz (usadas por todas as tarefas seguintes):
  ```ts
  export const COMBINATION_RULES = ["and", "or", "at_least"] as const;
  export type CombinationRule = (typeof COMBINATION_RULES)[number];
  export const COMBINATION_STATES = ["ok", "pending", "alert"] as const;
  export type CombinationState = (typeof COMBINATION_STATES)[number];
  export type RuleConfig = { rule: CombinationRule; minCount: number | null };
  export function ruleMet(config: RuleConfig, alerting: number, total: number): boolean;
  export type Step = { state: CombinationState; satisfiedSince: Date | null; changed: boolean };
  export function nextState(input: {
    state: CombinationState; satisfiedSince: Date | null; met: boolean; durationSeconds: number; now: Date;
  }): Step;
  ```

- [ ] **Passo 1: escrever os testes que falham** em `index.test.ts`:
  - `ruleMet`: `and` com (2,2) verdadeiro, (1,2) falso, (0,0) falso (sem componentes nunca satisfaz); `or` com (1,3) verdadeiro, (0,3) falso; `at_least` com `minCount: 2` e (2,3) verdadeiro, (1,3) falso; `at_least` com `minCount: null` lança erro.
  - `nextState`, com `now = 2026-01-01T10:02:00Z`:
    - `ok`, `met`, duração 0 → `{state:"alert", satisfiedSince: now, changed:true}`
    - `ok`, `met`, duração 120 → `{state:"pending", satisfiedSince: now, changed:true}`
    - `ok`, `!met` → `{state:"ok", satisfiedSince:null, changed:false}`
    - `pending` desde 10:00:00, `met`, duração 120 → `alert`, `satisfiedSince` 10:00:00 mantido, `changed:true`
    - `pending` desde 10:00:30, `met`, duração 120 → continua `pending`, `changed:false`
    - `pending`, `!met` → `{state:"ok", satisfiedSince:null, changed:true}`
    - `alert`, `met` → `changed:false`, `satisfiedSince` mantido
    - `alert`, `!met` → `{state:"ok", satisfiedSince:null, changed:true}`
    - **foco 1**: combinação de 1 componente (`ruleMet` `and` (1,1)) com duração 300 passa por `pending` e só vira `alert` aos 300 s
    - **foco 2**: `pending`, `!met`, depois `met` de novo 1 min depois → novo `satisfiedSince` = esse instante
- [ ] **Passo 2:** rodar `pnpm vitest run src/domain/combination` e confirmar que falha (módulo inexistente).
- [ ] **Passo 3:** implementar as duas funções em `index.ts` conforme a tabela acima. `ruleMet` lança `Error` se `rule === "at_least"` e `minCount === null`.
- [ ] **Passo 4:** rodar o teste e confirmar que passa.
- [ ] **Passo 5: commit** `feat(combinations): regra e transição de estado`

---

### Tarefa 2: Esquema do banco e migração

**Arquivos:**
- Modificar: `src/db/schema/index.ts` (enums, tabelas, coluna e valores de auditoria)
- Criar: `drizzle/0008_<nome gerado>.sql` e o snapshot/journal gerados por `pnpm db:generate`
- Teste: `src/db/combinations-schema.test.ts`

**Interfaces:**
- Consome: `COMBINATION_RULES`, `COMBINATION_STATES` da tarefa 1.
- Produz (exportados de `@/db/schema`):
  - `combinationRule`, `combinationState` (`pgEnum`: `combination_rule`, `combination_state`)
  - `combinations`: `id`, `name` text único não nulo, `description` text, `rule`, `minCount` smallint (`min_count`), `durationSeconds` integer não nulo padrão 0 (`duration_seconds`), `state` padrão `ok`, `stateChangedAt` (`state_changed_at`, padrão agora), `satisfiedSince` (`satisfied_since`), `archivedAt`, `createdAt`, `updatedAt`
  - `combinationAlerts`: `combinationId`, `alertId`, chave primária composta, índice em `alert_id`
  - `combinationAutomations`: espelha `remediations` (mesmas colunas e tipos) com `combinationId` no lugar de `alertId` e `triggerStates` do tipo `combination_state[]` (padrão `{alert}`)
  - `combinationAutomationRuns`: `id`, `automationId`, `combinationId`, `triggerState` (`combination_state`), `status` (`run_status`), `httpStatus`, `durationMs`, `error`, `at`
  - `combinationEvaluatorHeartbeat`: `id` smallint chave primária padrão 1, `lastRunAt` (`last_run_at`)
  - tipos `Combination`, `CombinationAutomation`
  - `auditLog.combinationId` (`combination_id`, nulo, FK + índice `(combination_id, id)`)
  - valores novos em `auditKind`: `combination_created`, `combination_updated`, `combination_archived`, `combination_state_changed`, `combination_automation_created`, `combination_automation_updated`, `combination_automation_run`
- Restrições no banco (`check`): `duration_seconds between 0 and 86400`; `rule = 'at_least' and min_count >= 1 or rule <> 'at_least' and min_count is null`; `heartbeat id = 1`; `timeout_ms between 100 and 15000`; automação sem `pending` em `trigger_states`.

- [ ] **Passo 1: escrever o teste** em `combinations-schema.test.ts` com `createTestDb()`: inserir combinação válida; inserir `at_least` sem `min_count` rejeita; `and` com `min_count` rejeita; duração 86401 rejeita; nome repetido rejeita; automação com `{pending}` rejeita; segunda linha de heartbeat com id 2 rejeita; `audit_log` aceita `combination_id` e continua rejeitando `UPDATE` (trigger existente).
- [ ] **Passo 2:** rodar o teste e confirmar que falha.
- [ ] **Passo 3:** editar o esquema e rodar `pnpm db:generate`. Ler o SQL gerado antes de seguir: os `ALTER TYPE audit_kind ADD VALUE` não podem ser usados na mesma migração; conferir que `createTestDb` (PGlite) aplica tudo.
- [ ] **Passo 4:** rodar o teste e a suíte inteira (`pnpm test`) para garantir que nada antigo quebrou.
- [ ] **Passo 5: commit** `feat(combinations): esquema e migração`

---

### Tarefa 3: Tornar a execução de saída reutilizável (sem mudar comportamento)

**Arquivos:**
- Modificar: `src/server/remediation.ts`
- Teste: `src/server/remediation.test.ts` (os testes existentes devem passar sem edição) e acrescentar os novos abaixo.

**Interfaces:**
- Produz:
  ```ts
  export type RequestSpec = { vars: Record<string, unknown>; payload: unknown };
  export type Outcome = { status: "success" | "failed" | "skipped"; httpStatus: number | null; durationMs: number | null; error: string | null };
  export type OutboundTarget = Pick<Remediation, "url" | "method" | "mode" | "bodyTemplate" | "headers" | "timeoutMs">;
  export function renderVars(template: string, vars: Record<string, unknown>): string;   // {{chave}} -> JSON-escapado
  export function execute(target: OutboundTarget, spec: RequestSpec, deps: RemediationDeps): Promise<Outcome>;
  export function withSlot<T>(task: () => Promise<T>): Promise<T | "queue-full">;
  ```
- `renderTemplate(template, ctx)` continua exportada com a mesma assinatura e passa a chamar `renderVars` com as chaves `alert.*`. `runOne` passa a montar um `RequestSpec` (`vars` = as chaves `alert.*`, `payload` = o objeto padrão atual, com o mesmo `firedAt`) e chamar `execute`.

- [ ] **Passo 1: escrever o teste novo** em `remediation.test.ts`: `renderVars('{"n":"{{combination.name}}"}', {"combination.name": 'a "b"\nc'})` produz JSON válido; chave inexistente vira string vazia.
- [ ] **Passo 2:** rodar `pnpm vitest run src/server/remediation.test.ts`; o teste novo falha.
- [ ] **Passo 3:** refatorar. `buildRequest` passa a receber `(target, spec)`; o corpo padrão é `JSON.stringify(spec.payload)`; no modo `api` com `bodyTemplate`, `renderVars(bodyTemplate, spec.vars)`. Nenhuma mudança de comportamento observável.
- [ ] **Passo 4:** rodar a suíte de remediação, de ingestão, de reconciliação e `api.test.ts`; todas devem passar sem alterar os testes antigos.
- [ ] **Passo 5: commit** `refactor(remediation): execução de saída reutilizável`

---

### Tarefa 4: Automações da combinação (cadastro, busca e execução)

**Arquivos:**
- Criar: `src/server/combination-automations.ts`
- Teste: `src/server/combination-automations.test.ts`

**Interfaces:**
- Consome: `remediationInputSchema`, `execute`, `withSlot`, `RequestSpec`, `RemediationDeps` (tarefa 3); tabelas da tarefa 2; `NotFoundError`.
- Produz:
  ```ts
  export const combinationAutomationSchema: z.ZodType<...>; // remediationInputSchema com triggerStates: z.array(z.enum(["alert","ok"])).min(1).default(["alert"])
  export const updateAutomationSchema: z.ZodType<Partial<z.infer<typeof combinationAutomationSchema>>>; // qualquer campo do cadastro, inclusive enabled; mesmas validações (a regra webhook/api é revalidada sobre o resultado mesclado); vazio é erro
  export type PendingAutomation = { automation: CombinationAutomation; combinationId: number; state: "alert" | "ok"; previousState: CombinationState };
  export function addAutomation(db: Db | Tx, combinationId: number, input: z.infer<typeof combinationAutomationSchema>, actor: string): Promise<CombinationAutomation>;
  export function updateAutomation(db: Db, combinationId: number, automationId: number, patch: z.infer<typeof updateAutomationSchema>, actor: string): Promise<CombinationAutomation>;
  export function findTriggeredAutomations(db: Pick<Db, "select">, combinationId: number, state: "alert" | "ok"): Promise<CombinationAutomation[]>;
  export function runAutomations(db: Db, pending: PendingAutomation[], deps: RemediationDeps): Promise<void>;
  ```
- Contexto enviado (`RequestSpec`): `vars` com `combination.id`, `combination.name`, `combination.state`, `combination.previous_state`, `combination.rule`, `combination.components` (nomes separados por vírgula). `payload` no formato do bloco "Payload padrão" da spec: `components` traz `{id, name, application, state, since, priority}` lidos do banco no momento da execução; `firedAt` ISO.
- `runAutomations` registra `combination_automation_runs` e auditoria `combination_automation_run` na mesma transação (como `runOne`), incrementa `combination_automation_runs_total{status}` (métrica criada na tarefa 10; aqui usar `increment` com o nome já declarado ali: declare a definição em `src/lib/metrics.ts` nesta tarefa).

- [ ] **Passo 1: escrever os testes** (PGlite; `fetch` simulado):
  - `combinationAutomationSchema`: aceita `{"alert","ok"}`; rejeita `pending`; cabeçalho `Authorization: "x"` rejeitado, `env:MEU_TOKEN` aceito; URL com usuário/senha rejeitada.
  - `addAutomation` grava a automação e a auditoria `combination_automation_created`; combinação inexistente → `NotFoundError`.
  - `updateAutomation` sem mudança real não grava auditoria; troca de URL, método, cabeçalhos, corpo, nome, gatilhos, timeout e `enabled` grava `combination_automation_updated` com antes/depois (sem valores de cabeçalho, só os nomes); resultado mesclado inválido (ex.: modo `webhook` com `bodyTemplate`, URL com credenciais, cabeçalho secreto literal) → erro; automação de outra combinação → `NotFoundError`; automação desativada não aparece em `findTriggeredAutomations`.
  - `findTriggeredAutomations` só devolve automações ativas cujo `triggerStates` contém o estado.
  - `runAutomations`: chamada acontece com o payload esperado (`combination.name`, lista de componentes com estado); host fora da lista → `skipped` sem chamada; resposta 500 → `failed` com `HTTP 500`; registra a execução e a auditoria; variável `env:` ausente → `failed`.
- [ ] **Passo 2:** rodar e confirmar que falha.
- [ ] **Passo 3:** implementar. `combination_automation_runs_total` entra em `DEFINITIONS` de `src/lib/metrics.ts` (contador, ajuda "Execuções de automação de combinação, por resultado.").
- [ ] **Passo 4:** rodar o teste e `pnpm vitest run src/lib/metrics.test.ts`.
- [ ] **Passo 5: commit** `feat(combinations): automações da combinação`

---

### Tarefa 5: Avaliador

**Arquivos:**
- Criar: `src/server/combination-evaluator.ts`
- Teste: `src/server/combination-evaluator.test.ts`

**Interfaces:**
- Consome: `ruleMet`, `nextState` (tarefa 1); tabelas (tarefa 2); `findTriggeredAutomations`, `PendingAutomation` (tarefa 4).
- Produz:
  ```ts
  export type EvaluateResult = { evaluated: number; changed: number; pending: PendingAutomation[] };
  export function evaluateCombinations(
    db: Db,
    options?: { alertId?: number; combinationIds?: number[]; now?: Date },
  ): Promise<EvaluateResult>;
  export function recordEvaluatorRun(db: Db, now?: Date): Promise<void>; // upsert da linha única de heartbeat
  ```
- Comportamento: seleciona combinações não arquivadas (todas, as que contêm `alertId`, ou as de `combinationIds`). Para cada uma, em transação própria: trava a linha (`FOR UPDATE`), carrega os componentes (join com `alerts`), conta os "alertando" (regras globais), chama `nextState`, e se `changed` atualiza `state`, `state_changed_at`, `satisfied_since`, `updated_at`; também atualiza `satisfied_since` quando ele muda sem mudar o estado (ex.: `pending` que continua). Em mudança grava auditoria `combination_state_changed` com `details: { from, to, alerting: [ids], rule, minCount, durationSeconds }` e, se o novo estado é `alert` ou se a volta é de `alert` para `ok`, busca as automações do gatilho (`alert` ou `ok`) e as devolve em `pending` com `previousState`. Volta de `pending` para `ok` não gera automação. Incrementa `combination_transitions_total{to}` (definir em `src/lib/metrics.ts`, rótulo `to` com `ok|pending|alert`).

- [ ] **Passo 1: escrever os testes** (relógio injetado por `now`; alertas criados direto no banco):
  - E com 2 alertas: um em `alert` → continua `ok`; os dois, duração 0 → `alert`, uma auditoria, uma automação pendente do gatilho `alert`.
  - Duração 120 s: vira `pending` no primeiro avaliar; `now + 119 s` continua `pending`; `now + 120 s` vira `alert` com automação. **Foco 2:** um alerta volta a `ok` aos 60 s → combinação volta a `ok` sem automação; ao reentrar, a contagem recomeça.
  - OU e `at_least` (2 de 3) com os casos de borda (1 de 3 falso).
  - Normalização: `alert` → regra falsa → `ok`, automação do gatilho `ok`; automação só com gatilho `alert` não é devolvida.
  - Silenciado (`muted_until` futuro) e arquivado não contam; **foco 3:** alerta em `alert` silenciado até `now + 1 min`, avaliar em `now + 2 min` sem nenhum evento → passa a contar.
  - **Foco 4:** `Promise.all` de duas chamadas de `evaluateCombinations` na mesma combinação gera uma linha de auditoria `combination_state_changed` e uma automação no total.
  - Combinação arquivada nunca é avaliada. `alertId` só avalia as combinações que o contêm.
  - `recordEvaluatorRun` cria e depois atualiza a mesma linha (sempre `id = 1`).
- [ ] **Passo 2:** rodar e confirmar que falha.
- [ ] **Passo 3:** implementar. Em `metrics.ts`, declarar `combination_transitions_total`.
- [ ] **Passo 4:** rodar o teste.
- [ ] **Passo 5: commit** `feat(combinations): avaliador de combinações`

---

### Tarefa 6: Cadastro e consulta de combinações (serviços)

**Arquivos:**
- Criar: `src/server/combinations.ts` (esquemas, criar, atualizar, arquivar)
- Criar: `src/server/combination-queries.ts` (leituras)
- Teste: `src/server/combinations.test.ts`

**Interfaces:**
- Consome: `evaluateCombinations` (tarefa 5), `addAutomation`, `combinationAutomationSchema` (tarefa 4), `ConflictError`, `NotFoundError`, `ValidationError`.
- Produz:
  ```ts
  export const createCombinationSchema = z.object({
    name: string 1..100, description: string ≤500 nullish,
    rule: z.enum(COMBINATION_RULES), minCount: int 1..20 nullish,
    durationSeconds: int 0..86400 default 0,
    alertIds: array(int positivo) 1..20,
    automations: array(combinationAutomationSchema) ≤10 default [],
  }).refine(...); // at_least exige minCount <= alertIds.length; and/or exigem minCount ausente; alertIds sem repetição
  export const updateCombinationSchema = createCombinationSchema.omit({ automations: true }).partial().extend({ archived: z.boolean().optional() })
    .refine(não vazio);
  export function createCombination(db: Db, input, actor): Promise<{ combination: Combination; pending: PendingAutomation[] }>;
  export function updateCombination(db: Db, id: number, patch, actor): Promise<{ combination: Combination; pending: PendingAutomation[] }>;
  // combination-queries.ts
  export type ComponentView = { id: number; name: string; application: string; state: AlertState; priority: number | null; stateChangedAt: Date; muted: boolean; archived: boolean; alerting: boolean };
  export type CombinationView = Combination & { components: ComponentView[]; alertingCount: number; hasArchivedComponent: boolean };
  export function listCombinations(db: Db, options?: { includeArchived?: boolean }): Promise<CombinationView[]>; // ordenadas alert, pending, ok e, dentro, por state_changed_at desc; limite 500
  export function getCombination(db: Db, id: number): Promise<(CombinationView & { automations: CombinationAutomation[]; runs: Run[]; audit: AuditRow[] }) | null>; // últimas 20 execuções e 50 linhas de auditoria
  ```
- `createCombination`: transação cria combinação, vínculos, automações e auditoria `combination_created` (+ `combination_automation_created`); depois do commit chama `evaluateCombinations(db, { combinationIds: [id] })` e devolve `pending`. Nome repetido → `ConflictError`. Alerta inexistente ou arquivado → `ValidationError` com o id. `updateCombination`: trava a linha, aplica só campos que mudam, grava `combination_updated` com `changes` antes/depois (incluindo a lista de `alertIds`), revalida `at_least` contra a lista **resultante** (foco 6), arquivar grava `combination_archived`, reavalia. Sem mudança real: nada gravado.

- [ ] **Passo 1: escrever os testes**:
  - criar válido grava tudo e a avaliação imediata (alertas já em `alert`, duração 0) deixa `state = 'alert'` e devolve a automação em `pending`;
  - nome repetido → `ConflictError`; `alertIds` com inexistente ou arquivado → `ValidationError`; 21 alertas → erro de validação; ids repetidos → erro;
  - **foco 6:** `at_least` com `minCount: 3` e 2 alertas → erro; atualizar só `alertIds` de 3 para 2 em uma combinação `at_least` com `minCount: 3` → erro; mudar a regra de `at_least` para `and` exige `minCount` nulo (limpar no mesmo patch);
  - atualizar sem mudança não grava auditoria; atualizar grava antes/depois e reavalia (trocar duração de 120 para 0 num `pending` leva a `alert`);
  - arquivar remove de `listCombinations()` e continua em `includeArchived: true`;
  - `listCombinations` ordena `alert` antes de `pending` antes de `ok`; `alerting` é falso para silenciado e arquivado e `hasArchivedComponent` é verdadeiro.
- [ ] **Passo 2:** rodar e confirmar que falha.
- [ ] **Passo 3:** implementar.
- [ ] **Passo 4:** rodar o teste.
- [ ] **Passo 5: commit** `feat(combinations): cadastro e consultas`

---

### Tarefa 7: Avaliação após cada mudança de estado de alerta

**Arquivos:**
- Modificar: `src/server/ingest.ts`, `src/server/runtime.ts`, `src/server/reconcile.ts`, `src/app/api/webhooks/route.ts`, `src/app/api/alerts/[id]/mute/route.ts`, `src/app/api/alerts/[id]/unmute/route.ts`
- Teste: `src/server/ingest.test.ts`, `src/server/reconcile.test.ts`, `src/app/api/api.test.ts`

**Interfaces:**
- Consome: `evaluateCombinations`, `runAutomations`, `PendingAutomation`.
- Produz:
  - `IngestResult` (ramo `processed`) ganha `combinations: PendingAutomation[]`.
  - `runAutomationsAfterResponse(db: Db, pending: PendingAutomation[]): void` em `src/server/runtime.ts` (usa `runAfterResponse` e `remediationDeps()`; não faz nada com lista vazia).
  - `ReconcileDeps.runAutomations?: (pending: PendingAutomation[]) => Promise<void>`; `reconcileDeps` em `runtime.ts` o preenche.
- Comportamento: depois do commit de `ingestEvent`, se `outcome === "applied"`, chama `evaluateCombinations(db, { alertId })` e devolve `combinations`. **Foco 5:** se o avaliador lançar, registra `logger.warn` (só o nome do erro) e devolve `combinations: []`; o resultado do evento continua válido. Webhook, reconciliação (acumula e executa junto de `runRemediations`, respeitando `input.remediate`) e mute/unmute chamam `runAutomationsAfterResponse` / `deps.runAutomations`. Arquivar alerta e fim de silêncio **não** disparam avaliação própria: o avaliador periódico cobre.

- [ ] **Passo 1: escrever os testes**:
  - `ingest.test.ts`: evento que leva o único componente de uma combinação (duração 0) a `alert` devolve `combinations` com 1 automação; evento `unchanged` ou `stale` devolve `[]`; **foco 5:** com o avaliador forçado a lançar (mock de `evaluateCombinations`), `ingestEvent` ainda devolve `processed/applied` e `combinations: []`.
  - `reconcile.test.ts`: reconciliação que corrige um alerta componente executa a automação por `deps.runAutomations`; com `remediate: false` não executa.
  - `api.test.ts`: webhook que fecha uma combinação responde 200 e a automação sai depois da resposta (fetch simulado chamado uma vez, para o host permitido).
- [ ] **Passo 2:** rodar e confirmar que falha.
- [ ] **Passo 3:** implementar. Os testes antigos de ingestão não podem mudar além de aceitar o campo novo.
- [ ] **Passo 4:** rodar `pnpm vitest run src/server src/app/api`.
- [ ] **Passo 5: commit** `feat(combinations): avaliar após mudança de estado de alerta`

---

### Tarefa 8: API HTTP

**Arquivos:**
- Criar: `src/app/api/combinations/route.ts` (`GET` lista, `POST` cria 201)
- Criar: `src/app/api/combinations/[id]/route.ts` (`GET`, `PATCH`, `DELETE` = arquivar)
- Criar: `src/app/api/combinations/[id]/automations/route.ts` (`POST` 201)
- Criar: `src/app/api/combinations/[id]/automations/[automationId]/route.ts` (`PATCH`)
- Criar: `src/app/api/combinations/evaluate/route.ts` (`POST`)
- Teste: `src/app/api/api.test.ts` (novo `describe("combinations")`)

**Interfaces:**
- Consome: serviços das tarefas 4 a 7, `actorOf`, `errorResponse`, `json`, `parseId`, `readJson` (mesmo estilo de `src/app/api/alerts/[id]/remediations/route.ts`), `export const dynamic = "force-dynamic"`.
- `POST /api/combinations/evaluate`: chama `evaluateCombinations(db)`, depois `recordEvaluatorRun(db)`, agenda `runAutomationsAfterResponse`, responde `{ evaluated, changed }` (200). Sem corpo obrigatório.
- Todas as outras rotas seguem o mesmo contrato de erros do restante da API (400/404/409).

- [ ] **Passo 1: escrever os testes de rota**: criar (201) e ler; nome repetido 409; `at_least` inválido 400; PATCH de regra reavalia; DELETE arquiva (some da lista, `GET /api/combinations/{id}` ainda responde); id inválido 400; id inexistente 404; POST de automação com cabeçalho secreto literal 400; PATCH de automação troca a URL e desativa (`enabled: false`), e a combinação deixa de chamá-la; PATCH com corpo vazio 400; automação de outra combinação 404; `POST /api/combinations/evaluate` completa uma duração (inserir combinação `pending` com `satisfied_since` antigo) e executa a automação; o heartbeat é gravado.
- [ ] **Passo 2:** rodar e confirmar que falha.
- [ ] **Passo 3:** implementar as rotas.
- [ ] **Passo 4:** rodar `pnpm vitest run src/app/api` e `pnpm typecheck`.
- [ ] **Passo 5: commit** `feat(combinations): API HTTP`

---

### Tarefa 9: Avaliador periódico (script e compose)

**Arquivos:**
- Criar: `scripts/evaluate-combinations.mjs`
- Criar: `scripts/evaluate-combinations.test.mjs`
- Modificar: `compose.yaml` (serviço `combination-evaluator`), `package.json` não precisa mudar (o `test:scripts` já pega `scripts/*.test.mjs`)

**Interfaces:**
- Produz: `export const EXIT = { ok: 0, usage: 2, unreachable: 4, failed: 1 }`; `export async function main(argv, env = process.env, deps = {})` e `export async function runOnce(config, deps)`, no estilo de `scripts/reconcile.mjs` (injeção de `fetchImpl`, `sleep`, `log`, `maxRuns`).
- Opções: `--url` (ou `EVALUATE_URL`), `--every` (padrão 30, mínimo 10; sem a opção roda uma vez), `--identity` (padrão `combination-evaluator@job`), `--identity-header` (padrão `AUTH_USER_HEADER` ou `x-forwarded-email`). Cada ciclo faz `POST /api/combinations/evaluate` e loga `avaliadas N, mudaram M`. Falha de rede não derruba o laço; SIGINT/SIGTERM encerram entre ciclos.
- `compose.yaml`: serviço **sem profile** (sobe por padrão), `image: node:24-alpine`, volume `./scripts/evaluate-combinations.mjs:/job/evaluate-combinations.mjs:ro`, `EVALUATE_URL: http://app:3000`, `AUTH_USER_HEADER`, `restart: unless-stopped`, `command: ["node", "/job/evaluate-combinations.mjs", "--every", "${EVALUATE_EVERY:-30}"]`, `depends_on: app: condition: service_healthy`.

- [ ] **Passo 1: escrever os testes** (`node:test`, como `reconcile.test.mjs`): sem `--url` sai 2; `--every 5` sai 2; uma execução chama `POST {url}/api/combinations/evaluate` com o cabeçalho de identidade e sai 0; resposta 500 sai 1; rede fora sai 4; modo periódico com `maxRuns: 2` faz 2 chamadas e continua depois de uma falha de rede.
- [ ] **Passo 2:** `pnpm test:scripts` falha.
- [ ] **Passo 3:** implementar o script e o serviço do compose.
- [ ] **Passo 4:** `pnpm test:scripts` passa; `docker compose config` valida o arquivo (se o Docker estiver disponível; senão registrar que não foi conferido).
- [ ] **Passo 5: commit** `feat(combinations): avaliador periódico`

---

### Tarefa 10: Observabilidade

**Arquivos:**
- Modificar: `src/server/telemetry.ts`, `src/server/telemetry.test.ts`, `src/app/status/page.tsx`, `docs/observability.md`

**Interfaces:**
- Consome: tabelas `combinations` e `combination_evaluator_heartbeat`.
- Produz: `Telemetry` ganha `combinationsByState: Record<CombinationState, number>` (só não arquivadas) e `combinationEvaluatorLastRunAt: Date | null`; `toGauges` ganha `combinations{state}` e `combination_evaluator_last_run_timestamp_seconds` (0 = nunca). O objeto `empty` os inicializa com zeros e `null` (banco fora continua respondendo).
- Tela `/status`: um `Fact` "Avaliador de combinações" com "há N s" (tom `ok` até 120 s; `alert` acima disso ou se nunca rodou e existe alguma combinação).

- [ ] **Passo 1: testes** em `telemetry.test.ts`: contagem por estado ignora arquivadas; heartbeat aparece como timestamp; sem heartbeat → 0; banco fora → zeros.
- [ ] **Passo 2:** rodar e confirmar que falha.
- [ ] **Passo 3:** implementar telemetria e o `Fact` na tela.
- [ ] **Passo 4:** `pnpm vitest run src/server/telemetry.test.ts src/lib/metrics.test.ts` passa.
- [ ] **Passo 5: commit** `feat(combinations): métricas e status do avaliador`

---

### Tarefa 11: Interface (menu "Combinações")

**Arquivos:**
- Modificar: `src/components/ui/app-shell.tsx` (item "Combinações", rota `/combinations`, ativo em `/combinations` e `/combinations/*`), `src/components/ui/icons.tsx` (novo ícone `CombineIcon`)
- Criar: `src/components/combination-state-badge.tsx`
- Criar: `src/app/combinations/page.tsx` (mapa), `src/app/combinations/[id]/page.tsx` (detalhe), `src/app/combinations/new/page.tsx`, `src/app/combinations/[id]/edit/page.tsx`
- Criar: `src/components/combination-form/combination-form.tsx` e `src/components/combination-form/payload.ts` (+ `payload.test.ts`)

**Interfaces:**
- Consome: `listCombinations`, `getCombination` (tarefa 6); `database()`; componentes `Card`, `PageHeader`, `SectionTitle`, `StateBadge`, `AutoRefresh`, `btnPrimary`, `field`, `tableHead`, `tableCell`; `GET /api/alerts?search=&limit=20` (existente) para a busca de componentes no formulário.
- Produz:
  - `CombinationStateBadge({ state: CombinationState })`: pílula com ponto e texto (nunca só cor), usando as cores `ok`/`warn`/`alert` já existentes: Normal / Armando / Alerta.
  - `describeRule({ rule, minCount, durationSeconds }, total): string` em `payload.ts` (ex.: "E · 2 min", "OU", "Pelo menos 2 de 3 · 5 min"; duração 0 não escreve tempo).
  - `buildCombinationPayload(values: FormValues): { ok: true; body: unknown } | { ok: false; error: string }` (minutos do formulário → `durationSeconds`; inclui `automations` quando marcada, no mesmo formato do formulário de alerta, gatilhos só Alerta/Normal).
- Mapa (`/combinations`): três seções na ordem Alerta, Armando, Normal; cartão com nome (link), regra em texto, componentes (nome, `StateBadge`, marcação "silenciado"/"arquivado", realce de quem está alertando), e em `Armando` o tempo que falta; aviso quando `hasArchivedComponent`. Atualização automática a cada 5 s (`AutoRefresh`). Estado vazio com chamada para "Nova combinação". Cabeçalho: indicador do avaliador ("em dia" / "parado há N min") lendo o heartbeat via `currentTelemetry()`.
- Detalhe: regra, componentes, automações (nome, destino, gatilhos, ativa), últimas execuções, histórico de auditoria; botões Editar e Arquivar (via `PATCH`).
- Formulário (criar/editar): nome, descrição, regra, N (só em "Pelo menos N"), duração em minutos, busca e seleção dos alertas componentes (chips removíveis), e na criação a seção de automação. Erros da API no mesmo formato do formulário de alerta.
- Automações na tela de detalhe (criar, **editar** e **ativar/desativar**): lista com interruptor "Ativa" por automação (PATCH `{ enabled }`), botão "Editar" que abre o mesmo grupo de campos do formulário de criação preenchido (nome, tipo, URL, método, cabeçalhos, corpo, gatilhos Alerta/Normal, timeout) e salva por `PATCH /api/combinations/{id}/automations/{automationId}`, e botão "Adicionar automação" (`POST`). Componente cliente `src/components/combination-form/automation-fields.tsx` reutilizado pelo formulário de criação e pelo detalhe. Valores de cabeçalho `env:NOME` aparecem como estão; cabeçalho sem referência não existe no banco, então não há segredo a mascarar.
- Seguir `docs/design.md`; rótulos `aria`, foco visível, tabelas com `caption`/`scope`, funciona a 390 px sem rolagem horizontal da página.

- [ ] **Passo 1: escrever `payload.test.ts`**: minutos viram segundos (2 → 120); `at_least` inclui `minCount`, `and` não; headers JSON inválido → erro; `describeRule` para os três casos.
- [ ] **Passo 2:** rodar e confirmar que falha.
- [ ] **Passo 3:** implementar `payload.ts`, o badge, o ícone, o menu, as páginas e o formulário. Ler antes `src/components/alert-form/alert-form.tsx` e `src/app/alerts/page.tsx` e seguir o mesmo estilo.
- [ ] **Passo 4:** rodar `pnpm vitest run src/components`, `pnpm lint`, `pnpm typecheck`, `pnpm build`. Subir com `pnpm dev` ou Docker e conferir à mão: mapa vazio, criar uma combinação, ver em `Armando`/`Alerta`, detalhe, editar, arquivar, e a 390 px sem rolagem horizontal. Anotar o que foi conferido e o que não.
- [ ] **Passo 5: commit** `feat(combinations): menu e telas`

---

### Tarefa 12: Documentação e kit de reconstrução

**Arquivos:**
- Modificar: `PRODUCT.md`, `README.md`, `docs/architecture.md`, `docs/guia-de-uso.md`, `docs/observability.md`, `docs/setup.md`, `docs/integrations/` (nada, se não houver mudança de fonte), `src/server/docs.ts` (só se houver página nova; preferir acrescentar uma seção no manual existente)
- Modificar: `reconstrucao/02-regras-de-negocio.md`, `04-banco-de-dados.md`, `05-api.md`, `08-telas.md`, `09-configuracao-e-implantacao.md`, `10-observabilidade.md`, `11-testes-e-aceite.md`, `12-plano-de-construcao.md`, `13-guia-de-uso.md`

**Conteúdo mínimo:** o que é uma combinação e para que serve (causa e consequência); as três regras com exemplos; duração e o estado `Armando`; o que conta como "alertando" (só `alert`, nem silenciado nem arquivado); automação (gatilhos `alert` e `ok`, payload e variáveis, segurança herdada); avaliador periódico e o atraso de até ~30 s; como editar e desativar uma automação na tela de detalhe; limites conhecidos (sem histerese, automação depois da resposta pode se perder se o processo cair); alerta Prometheus sugerido `time() - global_alerts_combination_evaluator_last_run_timestamp_seconds > 120`; o SQL final das tabelas novas em `reconstrucao/04`; cenários de aceite numerados em `reconstrucao/11` (continuar a numeração, 42 em diante) e uma fase nova em `reconstrucao/12`. Os documentos `reconstrucao/` não podem citar sistema de design nem ferramentas de desenvolvimento.

- [ ] **Passo 1:** atualizar cada documento no seu dono (escopo em `PRODUCT.md`, estrutura em `docs/architecture.md`, uso em `docs/guia-de-uso.md`, métricas em `docs/observability.md`, serviço do compose em `docs/setup.md`), sem duplicar regras.
- [ ] **Passo 2:** `pnpm vitest run src/server/docs.test.ts` (o teste valida que as páginas de documentação são lidas) e `pnpm build`.
- [ ] **Passo 3: commit** `docs(combinations): manual, arquitetura e kit de reconstrução`

---

### Tarefa 13: Simulador e validação ponta a ponta

**Arquivos:**
- Modificar: `simulator/src/*.mjs` (um cenário de combinações no mesmo padrão de `multiSourceScenario` em `simulator/src/sources.mjs`), `simulator/test/*.test.mjs`, `docs/` do simulador se existir seção
- Sem importar código da aplicação: o simulador só usa a API HTTP.

**Interfaces:**
- Consome: `POST /api/combinations`, `POST /api/combinations/evaluate`, `GET /api/combinations/{id}`, o webhook único e o receptor de remediação do simulador.
- Cenário: cria 2 alertas (um "comportamental", um "métrica"), uma combinação E com duração de 5 s e automação para o receptor; envia os dois em `alert`; confirma `pending` e que o receptor **não** foi chamado; chama `evaluate` depois de 5 s e confirma `alert` e uma chamada com o payload esperado; recupera um dos alertas e confirma `ok` e a automação de normalização (gatilhos `alert` e `ok`); segunda rodada em que um alerta volta antes dos 5 s e nenhuma automação sai. Oráculo próprio no simulador compara estado final e contagem de chamadas.

- [ ] **Passo 1:** escrever o teste do simulador (`pnpm test:simulator`) para a função pura do cenário (oráculo) com um cliente simulado.
- [ ] **Passo 2:** implementar o cenário e a opção no CLI.
- [ ] **Passo 3:** validar no Docker: `docker compose up --build -d`, conferir que o serviço `combination-evaluator` está de pé e logando, rodar o cenário. Se o Docker não estiver disponível, dizer isso explicitamente no resumo; não declarar validado.
- [ ] **Passo 4:** rodar `pnpm check` completo e anotar o resultado literal (testes, cobertura, build).
- [ ] **Passo 5: commit** `test(simulator): cenário de combinações`

---

## Autorrevisão

- **Cobertura da spec:** regras e duração (T1, T5); estados e nome (T1, T2); silenciado/arquivado (T5, T6); gatilhos `alert`/`ok` (T4, T5); tabelas próprias de automação (T2, T4); auditoria e coluna (T2, T5, T6); avaliar na criação e na edição (T6); avaliar após mudança de estado e periódico (T7, T9); API (T8); menu e mapa que não tocam a tela inicial (T11); avaliador no compose por padrão (T9); métricas, heartbeat e alerta (T4, T5, T10); documentação e `reconstrucao/` (T12); simulador (T13). Fora do plano por decisão: histerese, combinação de combinações, "exatamente um".
- **Decisões do construtor aqui:** rótulos de tela "Normal/Armando/Alerta"; o heartbeat é uma tabela de linha única (a métrica precisa valer entre instâncias, e o avaliador roda em outro processo); métricas só `combination_transitions_total`, `combination_automation_runs_total`, `combinations{state}` e o timestamp do avaliador. Pedido do usuário depois da aprovação: edição completa e ativar/desativar de automações também na interface (T4, T8, T11).
- **Consistência de tipos:** `PendingAutomation`, `EvaluateResult`, `CombinationView` e `ComponentView` são definidos uma vez (T4, T5, T6) e usados pelas tarefas seguintes com os mesmos nomes.
