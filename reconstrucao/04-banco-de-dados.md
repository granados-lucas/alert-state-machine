# 04 — Banco de dados (PostgreSQL)

Esquema **final** consolidado. Em uma reconstrução do zero, aplique este SQL uma vez (ou o equivalente na ferramenta de migração da empresa). Não existe `db push`/sincronização automática: o SQL é versionado, revisado e aplicado de forma explícita, **nunca** durante o build nem a cada requisição.

Convenções: chaves `bigint` por identidade (`GENERATED ALWAYS AS IDENTITY`); datas `timestamptz`; chaves estrangeiras sempre com índice; nomes em `snake_case`. Todas as chaves estrangeiras são `ON DELETE NO ACTION` (nada é apagado em cascata).

```sql
-- ===== Tipos =====
CREATE TYPE alert_state            AS ENUM ('ok', 'warn', 'alert', 'no_data');
CREATE TYPE event_outcome          AS ENUM ('applied', 'unchanged', 'stale', 'ignored');
CREATE TYPE remediation_mode       AS ENUM ('webhook', 'api');
CREATE TYPE run_status             AS ENUM ('success', 'failed', 'skipped');
CREATE TYPE mute_action            AS ENUM ('mute', 'unmute');
CREATE TYPE mute_operation_status  AS ENUM ('pending', 'succeeded', 'failed');
CREATE TYPE reconciliation_status  AS ENUM ('running', 'succeeded', 'partial', 'failed');
CREATE TYPE audit_kind AS ENUM (
  'alert_created', 'alert_updated', 'alert_archived', 'state_changed',
  'remediation_created', 'remediation_updated', 'remediation_run',
  'journey_created', 'journey_updated', 'journey_applications_updated', 'journey_deleted',
  'monitor_muted', 'monitor_unmuted', 'monitor_mute_failed', 'reconciliation_run'
);

-- ===== Aplicações e jornadas =====
CREATE TABLE applications (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE journeys (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE journey_applications (
  journey_id     bigint NOT NULL REFERENCES journeys(id),
  application_id bigint NOT NULL REFERENCES applications(id),
  PRIMARY KEY (journey_id, application_id)
);
CREATE INDEX journey_applications_application_id_idx ON journey_applications (application_id);

-- ===== Alertas =====
CREATE TABLE alerts (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  application_id     bigint NOT NULL REFERENCES applications(id),
  provider           text   NOT NULL,                       -- datadog | cloudwatch | appdynamics | generic
  external_id        text   NOT NULL,                       -- ID do monitor na fonte
  name               text   NOT NULL,
  state              alert_state NOT NULL DEFAULT 'no_data',
  priority           smallint,                              -- 1..5 ou nulo (validado pela aplicação)
  tags               text[] NOT NULL DEFAULT '{}'::text[],
  link               text,
  last_event_at      timestamptz,                           -- horário (na fonte) do último evento aplicado
  provider_state     text,                                  -- último estado BRUTO lido na API da fonte (ex.: 'Skipped')
  provider_state_at  timestamptz,
  state_changed_at   timestamptz NOT NULL DEFAULT now(),
  archived_at        timestamptz,
  muted_until        timestamptz,                           -- silêncio aplicado por esta aplicação
  muted_scope        text,
  mute_reason        text,
  muted_by           text,
  muted_at           timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alerts_provider_external_id_key UNIQUE (provider, external_id)
);
-- Alertas ativos por aplicação e estado: base do mapa e das listagens.
CREATE INDEX alerts_application_state_idx ON alerts (application_id, state) WHERE archived_at IS NULL;

-- ===== Eventos recebidos (idempotência e prova) =====
CREATE TABLE webhook_events (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider          text NOT NULL,
  external_event_id text NOT NULL,
  alert_id          bigint REFERENCES alerts(id),
  outcome           event_outcome NOT NULL,
  occurred_at       timestamptz NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  payload           jsonb NOT NULL,
  CONSTRAINT webhook_events_provider_event_key UNIQUE (provider, external_event_id)
);
CREATE INDEX webhook_events_alert_id_idx ON webhook_events (alert_id);

-- ===== Remediações =====
CREATE TABLE remediations (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  alert_id       bigint NOT NULL REFERENCES alerts(id),
  name           text NOT NULL,
  mode           remediation_mode NOT NULL,
  url            text NOT NULL,
  method         text NOT NULL DEFAULT 'POST',
  headers        jsonb NOT NULL DEFAULT '{}'::jsonb,        -- valores sensíveis só como referência "env:NOME"
  body_template  text,
  trigger_states alert_state[] NOT NULL DEFAULT '{alert}'::alert_state[],
  timeout_ms     integer NOT NULL DEFAULT 5000,
  enabled        boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT remediations_timeout_range CHECK (timeout_ms BETWEEN 100 AND 15000)
);
CREATE INDEX remediations_alert_id_idx ON remediations (alert_id);

CREATE TABLE remediation_runs (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  remediation_id bigint NOT NULL REFERENCES remediations(id),
  alert_id       bigint NOT NULL REFERENCES alerts(id),
  event_id       bigint REFERENCES webhook_events(id),
  trigger_state  alert_state NOT NULL,
  status         run_status NOT NULL,
  http_status    smallint,
  duration_ms    integer,
  error          text,
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX remediation_runs_alert_id_idx       ON remediation_runs (alert_id, at);
CREATE INDEX remediation_runs_remediation_id_idx ON remediation_runs (remediation_id);
CREATE INDEX remediation_runs_event_id_idx       ON remediation_runs (event_id);

-- ===== Auditoria (somente inserção) =====
CREATE TABLE audit_log (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at             timestamptz NOT NULL DEFAULT now(),
  kind           audit_kind NOT NULL,
  actor          text NOT NULL,
  alert_id       bigint REFERENCES alerts(id),
  application_id bigint REFERENCES applications(id),
  from_state     alert_state,
  to_state       alert_state,
  event_id       bigint REFERENCES webhook_events(id),
  details        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_alert_id_idx       ON audit_log (alert_id, id);
CREATE INDEX audit_log_application_id_idx ON audit_log (application_id, id);
CREATE INDEX audit_log_at_idx             ON audit_log (at);
CREATE INDEX audit_log_event_id_idx       ON audit_log (event_id);

CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$;
CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();

-- ===== Reconciliação =====
CREATE TABLE reconciliation_runs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider    text NOT NULL,
  trigger     text NOT NULL,                                 -- manual | schedule
  actor       text NOT NULL,
  status      reconciliation_status NOT NULL DEFAULT 'running',
  dry_run     boolean NOT NULL DEFAULT false,
  options     jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary     jsonb NOT NULL DEFAULT '{}'::jsonb,
  rate_limit  jsonb NOT NULL DEFAULT '{}'::jsonb,            -- últimos cabeçalhos X-RateLimit-* vistos
  error       text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
-- No máximo uma execução "running" por provedor.
CREATE UNIQUE INDEX reconciliation_runs_one_running_idx ON reconciliation_runs (provider) WHERE status = 'running';
CREATE INDEX reconciliation_runs_started_at_idx ON reconciliation_runs (started_at);

-- ===== Silenciar atômico =====
CREATE TABLE mute_operations (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  alert_id    bigint NOT NULL REFERENCES alerts(id),
  action      mute_action NOT NULL,
  status      mute_operation_status NOT NULL DEFAULT 'pending',
  actor       text NOT NULL,
  reason      text,
  minutes     integer,
  until       timestamptz,
  scope       text,
  all_scopes  boolean NOT NULL DEFAULT false,
  recovered   boolean NOT NULL DEFAULT false,                -- concluída por reexecução
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
-- No máximo uma operação pendente por alerta.
CREATE UNIQUE INDEX mute_operations_one_pending_idx ON mute_operations (alert_id) WHERE status = 'pending';
CREATE INDEX mute_operations_alert_id_idx ON mute_operations (alert_id, id);
```

## Notas de uso do esquema

- **Idempotência da ingestão** vem de `webhook_events (provider, external_event_id)` único: `INSERT ... ON CONFLICT DO NOTHING` e verificar se inseriu.
- **Serialização por alerta** vem de `SELECT ... FOR UPDATE` na linha do alerta dentro da transação.
- **Descoberta automática** usa `INSERT ... ON CONFLICT DO NOTHING` em `alerts` e depois lê com trava.
- **Listagens grandes** usam paginação por cursor (`id` decrescente, `id < cursor`), nunca `OFFSET`.
- A busca por nome usa `ILIKE` com `\`, `%` e `_` escapados.
- O mapa agrupa `alerts` por `(aplicação, estado, prioridade)` só dos não arquivados (índice parcial acima).
- Tabelas de histórico (`webhook_events`, `audit_log`, `remediation_runs`) crescem sem parar. Defina uma política de retenção/particionamento antes de produção (a versão original **não** tem; é uma pendência). O gatilho da auditoria impede `DELETE`: para expirar dados antigos, particione por data e desanexe partições (ou ajuste o gatilho com decisão consciente).
- Pool de conexões: limitado (a versão original usa no máximo 5 conexões, timeout de conexão de 5 s, ociosa 30 s), criado sob demanda e **um só ponto de conexão** no código.

## Formato da auditoria (`details` por tipo)

| `kind` | Campos relevantes (`details` e colunas) |
|---|---|
| `alert_created` | `source` ("webhook" ou "api"), `externalId`, `name`, (`remediations`: quantidade, no cadastro) |
| `alert_updated` | `changes`: `{campo: {from, to}}`; ou `changes.applicationId` quando a fonte moveu o alerta de aplicação |
| `alert_archived` | `archived` (booleano) |
| `state_changed` | colunas `from_state`, `to_state`, `event_id`; `details`: `event`, `occurredAt` |
| `remediation_created` | `remediationId`, `name`, `mode`, `url`, `triggerStates` |
| `remediation_updated` | `remediationId`, `changes` |
| `remediation_run` | colunas `to_state`, `event_id`; `details`: `remediationId`, `name`, `status`, `httpStatus`, `durationMs`, `error`. Ator `system:remediation` |
| `journey_created` | `journeyId`, `name`, `applications` |
| `journey_updated` | `journeyId`, `changes` |
| `journey_applications_updated` | `journeyId`, `name`, `from`, `to` |
| `journey_deleted` | `journeyId`, `name`, `description`, `applications` |
| `monitor_muted` | `reason`, `minutes`, `until`, `scope`, `providerState`, `operationId`, `recovered` |
| `monitor_unmuted` | `reason`, `scope`, `allScopes`, `providerState`, `operationId`, `recovered` |
| `monitor_mute_failed` | `action`, `status` (HTTP ou nulo), `message`, `reason`, `until`, `scope`, `operationId`, `recovered` |
| `reconciliation_run` | `runId`, `provider`, `status`, `dryRun`, `trigger`, `counts` (resumo sem a lista de detalhes), `error`. Ator: quem iniciou a execução (as correções de estado feitas por ela usam o ator `system:reconciliation`) |
