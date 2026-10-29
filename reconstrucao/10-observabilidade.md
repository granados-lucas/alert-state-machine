# 10 — Observabilidade da própria aplicação

Mostra se o Global Alerts está de pé, se o banco responde, se cada fonte ainda entrega eventos, se há silêncios sem desfecho e se reconciliação e remediações funcionam. Não monitora os sistemas dos outros (isso é o produto): monitora **ele mesmo**.

## O que existe

| Onde | Para quê | Toca o banco |
|---|---|---|
| `GET /api/health/live` | Liveness: o processo responde. Use para reiniciar | não |
| `GET /api/health` | Readiness: `select 1`; 503 se o banco não responde | sim |
| `GET /api/metrics` | Métricas em texto do Prometheus | sim (medidas de estado) |
| Tela `/status` | As mesmas medidas, para uma pessoa (08) | sim |
| Logs JSON | Webhook loga com `requestId` e a fonte | não |

### Logs

Logs estruturados (JSON). Campos sensíveis são removidos (`password`, `token`, `secret`, `authorization`, `cookie`, chaves de API). Nunca registrar o corpo completo de webhooks nem segredos. O webhook registra: credencial rejeitada, fonte desconhecida, payload inválido (com o motivo curto), evento processado (fonte, alerta, resultado, estado). Erros inesperados: nome do erro, código do banco e mensagem curta (200 caracteres), **sem** o `detail` do driver (pode conter valores).

### Correlação

O webhook lê `X-Request-Id` (se simples: `[A-Za-z0-9_.-]`, até 64 caracteres) ou gera um UUID, põe em todos os logs da requisição e devolve no cabeçalho da resposta.

## Métricas (`/api/metrics`)

Prefixo `global_alerts_`. **Contadores e histogramas vivem na memória do processo** (zeram ao reiniciar; com várias instâncias, some na consulta). As **medidas de estado** saem do banco **na hora da coleta**, então valem entre reinícios e instâncias. Rótulos têm valores fixos: **nunca** ID de alerta, nome ou usuário; fonte desconhecida entra como `unknown`.

| Métrica | Tipo | Rótulos | Significado |
|---|---|---|---|
| `webhook_requests_total` | contador | `provider`, `outcome` | `outcome`: `applied`, `unchanged`, `stale`, `ignored`, `duplicate`, `handshake`, `unauthorized`, `unknown_source`, `invalid`, `rejected` (outro 4xx), `error` (5xx). `provider` é `unknown` quando ainda não dá para saber (ex.: não autenticou) |
| `webhook_duration_seconds` | histograma | `provider` | tempo de processamento. Baldes: 0,005 0,01 0,025 0,05 0,1 0,25 0,5 1 2,5 5 10 |
| `remediation_runs_total` | contador | `status` | `success`, `failed`, `skipped` |
| `mute_operations_total` | contador | `action`, `status` | `mute`/`unmute` × `succeeded`/`failed` (conta só quem fechou a operação) |
| `provider_api_requests_total` | contador | `provider`, `operation`, `outcome` | `operation`: `mute`, `unmute`, `list_monitors`; `outcome`: `ok`, `error`, `rate_limited` |
| `reconciliation_runs_total`, `reconciliation_duration_seconds` | contador, histograma | `provider`, `status` | execuções e duração |
| `unhandled_errors_total` | contador | | erros que viraram resposta 500 |
| `alerts` | medida | `state` | alertas ativos por estado |
| `last_event_timestamp_seconds` | medida | `provider` | instante do último evento aplicado (0 = nenhum); vem do maior `alerts.last_event_at` por fonte |
| `webhook_enabled` | medida | | 1 se `WEBHOOK_SECRET` válido está configurado |
| `mute_operations_pending`, `mute_operations_oldest_pending_seconds` | medida | | silêncios sem desfecho gravado e a idade do mais antigo (0 = nenhum) |
| `reconciliation_last_run_timestamp_seconds` | medida | | início da última reconciliação (0 = nunca) |
| `remediation_recent_failed` | medida | | falhas entre as últimas 50 remediações (consulta pela chave primária decrescente, barata) |
| `database_up`, `database_latency_seconds`, `database_pool_connections{state}` | medida | | banco e pool (`total`, `idle`, `waiting`) |
| `build_info{version}`, `process_uptime_seconds`, `process_resident_memory_bytes` | medida | | versão e processo |

Formato: linhas `# HELP`, `# TYPE` e amostras; histogramas com `_bucket{le=...}`, `_sum` e `_count`; valores de rótulo com `\`, `"` e quebra de linha escapados; `Content-Type: text/plain; version=0.0.4`. Sempre publicar `HELP`/`TYPE`, mesmo sem amostras. Se o banco falhar, responder **200** com `database_up 0` (o sinal é justamente "banco fora").

Em ambientes com várias cópias do módulo (hot reload, múltiplos bundles), mantenha o registro de contadores em um único objeto global do processo.

## Alertas sugeridos (ajuste os limiares ao seu ritmo)

| Condição (PromQL) | Por quê |
|---|---|
| `global_alerts_database_up == 0` | banco fora: nada é gravado |
| `time() - global_alerts_last_event_timestamp_seconds{provider="datadog"} > 3600 and global_alerts_webhook_enabled == 1` | a fonte parou de entregar (webhook quebrado, segredo trocado). Só você sabe o ritmo normal |
| `increase(global_alerts_webhook_requests_total{outcome="unauthorized"}[10m]) > 0` | segredo errado na ferramenta, ou tentativa indevida |
| `increase(global_alerts_webhook_requests_total{outcome=~"invalid\|error"}[10m]) > 0` | payload fora do formato (perde eventos) ou erro interno |
| `global_alerts_mute_operations_oldest_pending_seconds > 600` | silêncio aplicado na fonte e não gravado, sem recuperação |
| `global_alerts_remediation_recent_failed > 0` | remediação falhando |
| `global_alerts_database_pool_connections{state="waiting"} > 0` por vários minutos | pool saturado |
| `increase(global_alerts_unhandled_errors_total[10m]) > 0` | erro inesperado |

Coleta: `metrics_path: /api/metrics` no Prometheus, alcançando a aplicação pela rede interna.

## Limites conhecidos

- Sem rastreamento distribuído; só o webhook (caminho crítico) é medido e correlacionado.
- Contadores zeram a cada reinício; a tela de status e as medidas de estado não dependem disso.
- "Último evento" considera eventos **aplicados**; eventos descartados como antigos não o movem.
- A aplicação expõe os dados; quem avisa é o Prometheus/Alertmanager da empresa. A tela de status **não** declara uma fonte "parada" (cada fonte tem ritmo próprio).
- O formato das métricas foi validado só por testes, não por um Prometheus real.
