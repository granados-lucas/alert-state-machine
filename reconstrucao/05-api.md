# 05 — API HTTP

Convenções gerais:

- Corpo e respostas em JSON. Rotas dinâmicas: **sem cache**.
- Identidade: cabeçalho do SSO (`AUTH_USER_HEADER`). As rotas de escrita registram o autor na auditoria. **Nenhuma rota de gestão tem token.**
- IDs na URL são inteiros positivos de até 15 dígitos; senão `400 {"error":"invalid id"}`.
- Corpo de entrada limitado a **64 KB** (`413 {"error":"payload too large"}`). JSON inválido: `400 {"error":"invalid JSON"}`.
- Erros de validação: `400 {"error":"validation failed","issues":[{"path":"campo.sub","message":"..."}]}`.

| Situação | Código | Corpo |
|---|---|---|
| Validação / regra de entrada | 400 | `error` (+ `issues`) |
| Não encontrado | 404 | `{"error":"... not found"}` |
| Conflito (já existe, operação em andamento) | 409 | `{"error": "..."}` |
| Fonte não suporta a ação | 501 | `{"error": "..."}` |
| Recurso desligado por falta de configuração | 503 | `{"error": "..."}` |
| Falha da API da fonte (credencial inválida, limite, rede) | 502 (ou 404 se a fonte respondeu 404) | `{"error":"<mensagem curta>"}` |
| Erro inesperado | 500 | `{"error":"internal error"}` |

## Webhook (único)

`POST /api/webhooks` — autenticação: cabeçalho `X-Webhook-Secret: <WEBHOOK_SECRET>` **ou** HTTP Basic com o segredo como senha (usuário ignorado).

| Resposta | Significado |
|---|---|
| `200 {"status":"applied"\|"unchanged"\|"stale"\|"ignored","alertId":N,"state":"..."}` | Processado (mudou / igual / evento antigo / sem efeito) |
| `200 {"status":"duplicate"}` | Evento já recebido |
| `200 {"status":"handshake","message":"..."}` | Mensagem de protocolo tratada (ex.: confirmação do SNS) |
| `401 {"error":"unauthorized"}` | Segredo ausente/errado, ou `WEBHOOK_SECRET` não configurado |
| `400 {"error":"unknown source"}` | `source` com valor inexistente |
| `400 {"error":"invalid payload"}` | Corpo não respeita o formato da fonte |
| `413` / `400 invalid JSON` | Corpo grande demais / não é JSON |
| `5xx` | Falha interna (ex.: banco fora): a ferramenta reenvia |

A resposta inclui o cabeçalho `X-Request-Id`. O corpo é lido como JSON **independente do `Content-Type`** (o SNS envia `text/plain`). Formatos por fonte: 06 e 07.

## Alertas

| Rota | Descrição |
|---|---|
| `GET /api/alerts` | Lista. Filtros: `state`, `application`, `search` (parte do nome, ≤100), `limit` (1–200, padrão 50), `before` (cursor). Resposta `{items:[...], nextCursor}`; ordem `id` decrescente; só não arquivados. Item: `id,name,state,priority,application,provider,externalId,stateChangedAt,archivedAt,mutedUntil` |
| `POST /api/alerts` | Cria (201 com o alerta). Corpo: `{provider?, externalId, name, application, priority?, tags?, link?, remediations?}` (limites em 02, seção 7). 409 se já existe |
| `GET /api/alerts/{id}` | Detalhe: `{alert, remediations, runs, audit, journeys, pendingMute}`. `alert` inclui os campos da lista mais `applicationId, providerState, providerStateAt, mutedScope, muteReason, mutedBy, mutedAt, tags, link, lastEventAt, createdAt`. `runs`: últimas 50 execuções de remediação; `audit`: últimas 200 linhas; `journeys`: jornadas da aplicação; `pendingMute`: operação de silêncio pendente ou nulo |
| `PATCH /api/alerts/{id}` | Atualiza `name`, `priority`, `tags`, `link`, `archived` (pelo menos um campo) |
| `DELETE /api/alerts/{id}` | **Arquiva** (não apaga). Devolve o alerta |
| `POST /api/alerts/{id}/remediations` | Cria remediação (201). Corpo em 02, seção 5 |
| `PATCH /api/alerts/{id}/remediations/{rid}` | Altera `enabled`, `triggerStates`, `timeoutMs` (pelo menos um) |

Remediação (entrada): `{name (1–100), mode ("webhook"|"api"), url (http/https, sem credenciais), method ("GET"|"POST"|"PUT"|"PATCH"|"DELETE", padrão POST), headers ({nome: valor}; nomes só [A-Za-z0-9-]; valor ≤2000; sensível exige "env:NOME"), bodyTemplate (≤4000), triggerStates (≥1, padrão ["alert"]), timeoutMs (100–15000, padrão 5000), enabled (padrão true)}`. Regra: `mode:"webhook"` exige método `POST` e **sem** `bodyTemplate`.

## Silêncio

| Rota | Descrição |
|---|---|
| `POST /api/alerts/{id}/mute` | Corpo `{minutes (1–10080, inteiro), reason (3–300), scope? (≤200)}`. Resposta 200 `{mutedUntil, scope, reason, synced}` onde `synced` é `{outcome, state}` (estado informado pela fonte aplicado ao alerta) ou nulo |
| `POST /api/alerts/{id}/unmute` | Corpo `{reason? (≤300), allScopes? (padrão false)}`. Resposta `{mutedUntil: null, synced}` |
| `GET /api/mute-operations` | Operações pendentes: `{pending:[...]}` |
| `POST /api/mute-operations/recover` | Reexecuta pendentes há mais de 60 s: `{found, succeeded, failed, errors}` |

Erros: 404 alerta inexistente; 400 arquivado; 501 fonte sem suporte; 503 sem credenciais; 409 operação em andamento (menos de 60 s); 502 falha da fonte (a tentativa fica auditada). As remediações de um estado novo informado pela fonte rodam depois da resposta.

## Aplicações e jornadas

| Rota | Descrição |
|---|---|
| `GET /api/applications` | `{applications:[{name, counts:{ok,warn,alert,no_data}, total, status, health, downgraded, buckets}]}` ordenadas pior primeiro |
| `GET /api/journeys` | `{journeys:[{id,name,description,applications:[...],counts,total,status,health,downgraded}], unassigned:[...], totalApplications}` |
| `POST /api/journeys` | Cria (201). `{name (1–100), description? (≤500), applications? (≤200 nomes)}`. 409 nome repetido |
| `GET /api/journeys/{id}` | `{journey, alerts:[...]}`: alertas ativos das aplicações da jornada, mais graves primeiro, até 300 |
| `PATCH /api/journeys/{id}` | `name` e/ou `description` |
| `PUT /api/journeys/{id}/applications` | `{applications:[nomes]}`: **substitui** o conjunto. Devolve `{applications:[...]}` |
| `DELETE /api/journeys/{id}` | Remove só a jornada. `{deleted:true}` |

## Reconciliação

| Rota | Descrição |
|---|---|
| `POST /api/reconciliation` | Inicia e responde **202** `{id, status:"running", dryRun}`. Corpo opcional (02, seção 9) + `trigger` ("manual"\|"schedule", padrão manual). 409 se já há uma execução; 501/503 se a fonte não existe ou não tem credenciais |
| `GET /api/reconciliation` | Últimas 20 execuções: `{runs:[...]}` |
| `GET /api/reconciliation/{id}` | A execução: `status`, `dryRun`, `options`, `summary` (contagens + até 100 detalhes), `rateLimit`, `error`, datas |

## Saúde e observabilidade

| Rota | Descrição |
|---|---|
| `GET /api/health/live` | `200 {"status":"ok"}` sem tocar o banco (liveness) |
| `GET /api/health` | `200 {"status":"ok"}` se `select 1` funciona; `503 {"status":"database unavailable"}` (readiness) |
| `GET /api/metrics` | Texto no formato Prometheus (10) |

## Script de reconciliação periódica

Um script sem dependências (Node 18+ ou equivalente em outra linguagem) que chama `POST /api/reconciliation`, espera `GET /api/reconciliation/{id}` até terminar e sai com código: `0` concluída, `1` falhou, `2` uso incorreto, `3` parcial, `4` aplicação inacessível, `5` já havia execução. Opções: `--url`, `--dry-run`, `--no-create`, `--no-remediate`, `--tag` (repetível), `--page-size`, `--every N` (repete a cada N segundos, mínimo 60), `--timeout` (segundos esperando; padrão 1800), `--identity` (valor do cabeçalho de identidade; padrão `reconciler@job`). Pode ser agendado por cron ou pelo agendador da plataforma; o script **não** acessa banco nem Datadog.
