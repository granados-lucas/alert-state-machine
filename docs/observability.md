# Observabilidade da própria aplicação

O que dá para ver sobre o Global Alerts em operação: se está de pé, se o banco responde, se cada fonte de alertas ainda entrega eventos, se há silêncios sem desfecho, se a reconciliação e as remediações estão funcionando. Não monitora os sistemas dos outros (isso é o produto); monitora **ele mesmo**.

## O que existe

| Onde | Para quê | Banco? |
|---|---|---|
| `GET /api/health/live` | **Liveness**: o processo responde. Use para reiniciar o contêiner | não |
| `GET /api/health` | **Readiness**: o banco responde (`select 1`); 503 se não | sim |
| `GET /api/metrics` | Métricas no formato de texto do Prometheus | sim (para as medidas de estado) |
| `/status` (tela) | As mesmas medidas, para uma pessoa: banco, fontes, último evento por fonte, silêncios pendentes, última reconciliação, falhas de remediação | sim |
| Logs (Pino, JSON) | Cada webhook loga com `requestId` e `provider` | não |

### Correlação por requisição

O webhook lê `X-Request-Id` (se for simples: letras, números, `.`, `_`, `-`, até 64 caracteres) ou gera um UUID, grava em todos os logs da requisição e o devolve no cabeçalho da resposta. Com o mesmo ID dá para achar no log o que aconteceu com uma entrega específica. Só o webhook faz isso hoje.

## Métricas (`/api/metrics`)

Prefixo `global_alerts_`. **Contadores e histogramas vivem na memória do processo** (zeram ao reiniciar, como qualquer contador do Prometheus; com várias instâncias, some-as na consulta). As **medidas de estado** saem do banco na hora da coleta, então valem entre reinícios e instâncias.

| Métrica | Tipo | Rótulos | Significado |
|---|---|---|---|
| `webhook_requests_total` | contador | `provider`, `outcome` | `applied`, `unchanged`, `stale`, `ignored`, `duplicate`, `handshake`, `unauthorized`, `invalid`, `rejected`, `error`, `unknown_provider` |
| `webhook_duration_seconds` | histograma | `provider` | tempo de processamento |
| `remediation_runs_total` | contador | `status` | `success`, `failed`, `skipped` |
| `mute_operations_total` | contador | `action`, `status` | `mute`/`unmute` × `succeeded`/`failed` |
| `provider_api_requests_total` | contador | `provider`, `operation`, `outcome` | chamadas à API da fonte: `ok`, `error`, `rate_limited` |
| `reconciliation_runs_total`, `reconciliation_duration_seconds` | contador, histograma | `provider`, `status` | execuções e duração |
| `unhandled_errors_total` | contador | | erros que viraram resposta 500 |
| `alerts` | medida | `state` | alertas ativos por estado |
| `last_event_timestamp_seconds` | medida | `provider` | instante do último evento aplicado (0 = nenhum) |
| `provider_webhook_enabled` | medida | `provider` | 1 se o segredo da fonte está configurado |
| `mute_operations_pending`, `mute_operations_oldest_pending_seconds` | medida | | silêncios sem desfecho gravado |
| `reconciliation_last_run_timestamp_seconds` | medida | | início da última reconciliação (0 = nunca) |
| `remediation_recent_failed` | medida | | falhas entre as últimas 50 remediações |
| `database_up`, `database_latency_seconds`, `database_pool_connections{state}` | medida | | banco e pool (`total`, `idle`, `waiting`) |
| `build_info{version}`, `process_uptime_seconds`, `process_resident_memory_bytes` | medida | | versão e processo |

Os rótulos têm valores fixos (fontes e resultados conhecidos): **nunca** ID de alerta, nome ou usuário, e fonte desconhecida entra como `unknown`.

### Coletar

`/api/metrics` **não tem login nem token** (o projeto não usa tokens compartilhados; o acesso é decidido pela rede). Faça o Prometheus alcançá-lo por dentro: ou o SSO exclui `/api/metrics` da autenticação e a rede limita quem chega, ou o coletor fala direto com o contêiner. O conteúdo é só agregado, sem segredos.

```yaml
scrape_configs:
  - job_name: global-alerts
    metrics_path: /api/metrics
    static_configs: [{ targets: ["app:3000"] }]
```

### Alertas sugeridos (ajuste os limiares ao seu ritmo)

| Condição (PromQL) | Por quê |
|---|---|
| `global_alerts_database_up == 0` | banco fora: nada é gravado e o webhook responde 500 |
| `time() - global_alerts_last_event_timestamp_seconds{provider="datadog"} > 3600 and global_alerts_provider_webhook_enabled{provider="datadog"} == 1` | a fonte parou de entregar (webhook quebrado, segredo trocado). Só você sabe o ritmo normal de cada fonte |
| `increase(global_alerts_webhook_requests_total{outcome="unauthorized"}[10m]) > 0` | segredo errado na fonte, ou alguém tentando |
| `increase(global_alerts_webhook_requests_total{outcome=~"invalid|error"}[10m]) > 0` | payload fora do formato (perde eventos) ou erro interno |
| `global_alerts_mute_operations_oldest_pending_seconds > 600` | silêncio aplicado na fonte e não gravado, sem recuperação |
| `global_alerts_remediation_recent_failed > 0` | remediação falhando |
| `global_alerts_database_pool_connections{state="waiting"} > 0` por vários minutos | pool saturado |
| `increase(global_alerts_unhandled_errors_total[10m]) > 0` | erro inesperado nos logs |

## Limites conhecidos

- Sem rastreamento distribuído (tracing) e sem métricas de latência das páginas; só o webhook (o caminho crítico) é medido e correlacionado.
- Contadores zeram a cada reinício; a tela `/status` e as medidas de estado não dependem disso.
- O "último evento" vem de `alerts.last_event_at` (eventos aplicados): eventos descartados como antigos não o movem.
- Não há alerta embutido: a aplicação expõe os dados; quem avisa é o seu Prometheus/Alertmanager. A tela de status não declara uma fonte "parada" (cada fonte tem um ritmo diferente).
- As métricas não foram coletadas por um Prometheus real; o formato foi validado só por testes.
