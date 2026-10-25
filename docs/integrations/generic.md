# Fonte genérica (JSON canônico)

Para qualquer ferramenta sem adaptador: um script, um proxy do Alertmanager, um sistema interno. O remetente já informa o **estado equivalente** (`ok`, `warn`, `alert`, `no_data`).

`POST /api/webhooks/generic` com o cabeçalho `X-Webhook-Secret: <GENERIC_WEBHOOK_SECRET>` (≥ 16 caracteres):

```json
{
  "event_id": "evento-0001",
  "monitor_id": "fila-pagamentos-cheia",
  "monitor_name": "Fila de pagamentos cheia",
  "state": "alert",
  "occurred_at": "2026-03-01T10:00:00Z",
  "application": "pagamentos",
  "tags": ["env:prod", "team:pay"],
  "priority": "P2",
  "link": "https://painel.exemplo/alertas/fila-pagamentos-cheia"
}
```

| Campo | Regra |
|---|---|
| `event_id` | **obrigatório**; chave de idempotência (repetir responde `duplicate`) |
| `monitor_id`, `monitor_name` | **obrigatórios**; o ID identifica o alerta |
| `state` | **obrigatório**: `ok`, `warn`, `alert` ou `no_data` |
| `occurred_at` | opcional (ISO ou epoch em ms); eventos mais antigos que o último aplicado são descartados (`stale`). Sem ele vale o horário de recebimento |
| `application` | opcional; sem ele vem da tag `service:` (ou `app:`/`application:`); sem nenhum, `unassigned` |
| `priority` | opcional, `1` a `5` ou `P1` a `P5` |
| `link` | opcional; só `http(s)` |

Exemplo:

```bash
curl -X POST http://localhost:3000/api/webhooks/generic \
  -H "x-webhook-secret: $GENERIC_WEBHOOK_SECRET" -H "content-type: application/json" \
  -d '{"event_id":"e1","monitor_id":"m1","monitor_name":"Teste","state":"alert","application":"demo"}'
```

Sem reconciliação nem silenciamento (não há API de origem). Os formatos de resposta são os de `docs/guia-de-uso.md`, seção 4.5.
