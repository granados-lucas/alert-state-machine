# 07 — Outras fontes: CloudWatch, AppDynamics e genérica

Todas entram pelo **mesmo webhook** (`POST /api/webhooks`) e o **mesmo segredo** (`WEBHOOK_SECRET`). A fonte é identificada por:

```text
fonteDe(corpo):
  se corpo.source não existe:
       se corpo.Type é texto E corpo.TopicArn é texto → "cloudwatch"   (envelope do SNS, que não é personalizável)
       senão → "generic"
  se corpo.source é um dos ids conhecidos → esse id
  senão → desconhecida (400 "unknown source")
```

Ids: `datadog`, `cloudwatch`, `appdynamics`, `generic`. **Nenhum adaptador abaixo foi validado com a ferramenta real**; os formatos vêm da documentação e de guias de terceiros.

Para adicionar uma fonte nova: escrever o adaptador (`parse`, e `handshake`/`control`/`source` só se preciso), a tabela de equivalência de estados, registrar no catálogo (id, rótulo, tabela) e nos testes. Não há rota nem segredo novos; o id vira o valor de `source`.

---

## Amazon CloudWatch (via SNS)

O CloudWatch não chama webhooks: o **alarme publica num tópico do SNS** e o SNS entrega por **assinatura HTTPS** ao webhook. Fatos da documentação do SNS:

- A URL da assinatura aceita usuário e senha (`https://usuario:senha@host`), enviados como Basic sobre HTTPS. **O SNS não consegue enviar cabeçalho personalizado**: por isso o webhook aceita Basic com o segredo como senha (usuário ignorado).
- O segredo vai dentro de uma URL: use **só letras, números, `-` e `_`** (um `@`, `:` ou `/` quebra a URL).
- Ao assinar, o SNS manda uma mensagem `SubscriptionConfirmation` com `SubscribeURL` e `Token`; **nenhuma notificação chega antes da confirmação**.
- O corpo é JSON mas o `Content-Type` é `text/plain`: leia o corpo como JSON de qualquer forma.
- O SNS retenta em 5xx e 429; os demais 4xx são falhas permanentes.
- Cada mensagem tem `MessageId` único (o mesmo na reentrega).
- O SNS **não suporta endpoints privados**: o caminho do webhook precisa ser alcançável pela internet.

### Configurar

1. `WEBHOOK_SECRET` com os caracteres permitidos acima. Opcional: `CLOUDWATCH_TOPIC_ARNS` (ARNs de tópico aceitos, separados por vírgula; vazio = qualquer tópico que conheça o segredo).
2. Criar um tópico SNS e uma assinatura **HTTPS** para `https://sns:<SEGREDO>@<endereço>/api/webhooks`.
3. A aplicação confirma a assinatura sozinha (`200 {"status":"handshake"}`); se falhar (502), o SNS tenta de novo.
4. Em cada alarme, adicionar o tópico como ação para **ALARM**, **OK** e **INSUFFICIENT_DATA**.
5. Na **descrição do alarme** incluir `service:<aplicação>` e, opcionalmente, `priority:<1 a 5>` (ex.: `service:checkout priority:2 CPU acima de 80%`).

### Interpretação

Envelope SNS: `{Type, MessageId, TopicArn, Message (texto JSON), Timestamp, SubscribeURL?}`.

**Handshake** (antes do `parse`):

- `Type = "UnsubscribeConfirmation"` → `200 {"status":"handshake","message":"unsubscribe confirmation ignored"}`.
- `Type = "SubscriptionConfirmation"`: se há lista de tópicos e o `TopicArn` não está nela → 400. `SubscribeURL` precisa ser **`https`**, host que case `^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$`, **sem usuário/senha** (senão 400, e a URL **não é chamada**: a aplicação não pode virar proxy). Chamar com **GET**, **sem seguir redirecionamentos**, timeout de 10 s. Rede falhou → 502; resposta não-2xx → 502. Sucesso → `200 {"status":"handshake","message":"subscription confirmed"}`.
- `Type = "Notification"` segue para o `parse`.

**Notificação** (`Type = "Notification"`, `Message` presente; lista de tópicos respeitada, senão 400): `Message` é o alarme em JSON:

| Campo do alarme | Uso |
|---|---|
| `AlarmArn` (obrigatório) | `externalAlertId` (identifica o alerta) |
| `AlarmName` (obrigatório) | nome |
| `NewStateValue` | estado (tabela abaixo) |
| `AlarmDescription` | tokens `chave:valor` separados por espaço (`^[A-Za-z_][\w-]*:\S+$`): `service:`/`app:`/`application:` → aplicação (senão `unassigned`); `priority:N` → prioridade; os tokens viram as tags |
| `StateChangeTime` | horário (aceita fuso `+0000`; normalizar para `+00:00`); senão `Timestamp` do SNS; senão agora |
| `MessageId` (do envelope) | `externalEventId` |

| `NewStateValue` | Estado aqui |
|---|---|
| `OK` | `ok` |
| `ALARM` | `alert` |
| `INSUFFICIENT_DATA` | `no_data` |
| outro | mantém o atual |

O CloudWatch **não tem estado de aviso**: nunca produz `warn`. Link: `https://console.aws.amazon.com/cloudwatch/home?region=<região do ARN>#alarmsV2:alarm/<nome codificado>` (⚠ não verificado). Alarmes compostos assumidos com o mesmo formato (⚠).

### Riscos

1. ⚠ **A assinatura das mensagens do SNS não é verificada** (`Signature`/`SigningCertURL`): quem sabe o segredo pode enviar eventos como CloudWatch. Compensar com segredo forte, HTTPS e `CLOUDWATCH_TOPIC_ARNS`. Verificar a assinatura exigiria baixar e validar o certificado do SNS.
2. ⚠ O campo a campo do JSON do alarme veio de guias de terceiros: confirmar com `aws cloudwatch set-alarm-state` em um alarme de teste.
3. O segredo fica na URL da assinatura (visível a quem tem acesso ao SNS). Troque ao revogar acesso.
4. Sem reconciliação nem silêncio para o CloudWatch (silenciar equivaleria a desativar as ações do alarme: não implementado).

---

## AppDynamics

Uma **política** dispara uma **ação de requisição HTTP** com um **modelo** (método, URL, cabeçalhos, corpo com variáveis `${...}`). Variáveis predefinidas da documentação: `${policy.name}`, `${latestEvent.id}`, `${latestEvent.eventType}`, `${latestEvent.eventTime}`, `${latestEvent.displayName}`, `${latestEvent.application.name}`, `${latestEvent.healthRule.name}`, `${latestEvent.severity}`, `${latestEvent.deepLink}` etc.

### Configurar

Crie um modelo de requisição HTTP:

- Método e URL: `POST https://<endereço>/api/webhooks`
- Cabeçalho: `X-Webhook-Secret: <WEBHOOK_SECRET>` (⚠ não verificado se um valor fixo é aceito sem variável).
- Corpo:

```json
{
  "source": "appdynamics",
  "event_id": "${latestEvent.id}",
  "event_type": "${latestEvent.eventType}",
  "application": "${latestEvent.application.name}",
  "health_rule": "${latestEvent.healthRule.name}",
  "policy": "${policy.name}",
  "event_time": "${latestEvent.eventTime}",
  "link": "${latestEvent.deepLink}",
  "priority": "2"
}
```

Ligue a ação à política nos gatilhos de **violação de regra de saúde** (abertura, continuação, subida/descida de severidade, encerramento). **A prioridade não existe no AppDynamics**: é o valor fixo `"priority"` do modelo; crie **um modelo por prioridade** (P1..P5). Sem prioridade, conta como P3.

### Interpretação

| Campo | Regra |
|---|---|
| `event_id` | obrigatório; idempotência |
| `event_type` | obrigatório; decide o evento (tabela abaixo; comparação em maiúsculas) |
| `application` | obrigatório (não vazio); aplicação do alerta |
| `health_rule`, `policy` | pelo menos um não vazio; o alerta é identificado por `<aplicação>/<regra>` (se não há regra, usa a política); nome = regra (ou política); `policy` vira a tag `policy:<nome>` |
| `event_time` | epoch em ms ou data; outro formato → horário de recebimento (a ordenação pelo horário da fonte se perde) |
| `link` | http/https ou nulo |
| `priority` | `1`..`5`/`P1`..`P5` ou nulo |

**Variável não preenchida** (texto contendo `${`, vazio, `null` ou `undefined`) conta como **vazia**. Sem aplicação ou sem regra/política: payload inválido (400).

| `event_type` | Estado aqui |
|---|---|
| `POLICY_OPEN_WARNING`, `POLICY_CONTINUES_WARNING` | `warn` |
| `POLICY_OPEN_CRITICAL`, `POLICY_CONTINUES_CRITICAL`, `POLICY_UPGRADED` | `alert` |
| `POLICY_DOWNGRADED` | `warn` |
| `POLICY_CLOSE_WARNING` | `ok` |
| `POLICY_CLOSE_CRITICAL`, `POLICY_CANCELED_WARNING`, `POLICY_CANCELED_CRITICAL` | `ok` (⚠ **suposição**: nomes não listados na documentação) |
| outro | mantém o atual |

A documentação lista como exemplos os tipos de `POLICY_OPEN_WARNING` até `POLICY_CLOSE_WARNING` ("podem não ser exaustivos"). Se um encerramento não for reconhecido, o alerta fica preso em Alerta: confirme cada tipo com um evento real.

### Riscos

1. ⚠ Tipos de evento de encerramento (acima).
2. ⚠ Formato de `${latestEvent.eventTime}` (a página não especifica).
3. ⚠ `${latestEvent.deepLink}` já foi relatado como nulo (2019): o alerta fica sem link.
4. ⚠ Reentrega em caso de falha da ação não verificada. Sem reconciliação nem silêncio para o AppDynamics.
5. Eventos que não são de regra de saúde (anomalias, incidentes) também podem acionar a ação; sem `health_rule` caem na política.

---

## Genérica (JSON canônico)

Para qualquer ferramenta sem adaptador (script, proxy do Alertmanager, sistema interno): o remetente já informa o **estado equivalente**.

`POST /api/webhooks` com `X-Webhook-Secret`:

```json
{
  "source": "generic",
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
| `source` | `generic`; pode ser omitido (corpo sem `source` é tratado como genérico) |
| `event_id`, `monitor_id`, `monitor_name` | obrigatórios (`event_id` e `monitor_id` aceitam número) |
| `state` | obrigatório: `ok`, `warn`, `alert` ou `no_data` (vira o evento correspondente) |
| `occurred_at` | opcional (data ISO ou epoch em ms); sem ele, horário de recebimento. Eventos mais antigos que o último aplicado são `stale` |
| `application` | opcional; senão vem da tag `service:`/`app:`/`application:`; senão `unassigned` |
| `tags` | opcional, lista de textos (padrão vazia) |
| `priority` | opcional, `1`..`5` ou `P1`..`P5` |
| `link` | opcional; só http/https |

Sem reconciliação nem silêncio.

## Formatos auxiliares comuns aos adaptadores

- **Prioridade**: aceita `P2`, `2` ou o número 2 (1–5); qualquer outra coisa → nulo.
- **Data/hora**: epoch em ms (número ou texto só com dígitos) ou ISO; fuso `+0000` é normalizado para `+00:00`; inválido ou zero → nulo (o adaptador cai para outra fonte de horário ou para "agora").
- **Link**: só `http`/`https`; qualquer outro esquema (`javascript:` etc.) → nulo. O link vira `href` na tela.
- **Texto ou número**: variáveis de modelo chegam como texto; números são aceitos por tolerância e convertidos em texto.
