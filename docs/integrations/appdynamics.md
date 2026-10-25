# Integração com o AppDynamics

Estudo feito em 2026-10-25 nas páginas do Splunk AppDynamics sobre [ações e modelos de requisição HTTP](https://help.splunk.com/en/appdynamics-saas/get-started/26.3.0/alert-and-respond/actions/http-request-actions-and-templates/create-or-modify-an-http-request-template/custom-templating-variables), [variáveis predefinidas](https://help.splunk.com/en/appdynamics-on-premises/get-started/26.2.0/alert-and-respond/actions/predefined-templating-variables) e do [guia do PagerDuty](https://www.pagerduty.com/docs/guides/appdynamics-integration-guide/) (usado como exemplo de modelo). **Nada foi validado com um controller real.**

## Como o AppDynamics chega aqui

Uma **política** do AppDynamics dispara uma **ação de requisição HTTP** com um **modelo** (método, URL, cabeçalhos e corpo com variáveis Velocity `${…}`). O Global Alerts recebe esse POST no webhook único, `/api/webhooks`, identificado por `"source": "appdynamics"` no corpo.

## Configurar

1. Use o `WEBHOOK_SECRET` da aplicação (o mesmo de todas as ferramentas).
2. No AppDynamics, crie um **modelo de requisição HTTP**:
   - **Método e URL:** `POST https://<host-do-global-alerts>/api/webhooks`
   - **Cabeçalho:** `X-Webhook-Secret: <o segredo>` (cabeçalhos personalizados são suportados; **não verificado** se o valor fixo é aceito sem variável).
   - **Corpo (JSON):**

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

3. Crie uma **ação** com esse modelo e ligue-a à política, para os gatilhos de **violação de regra de saúde** (abertura, continuação, subida/descida de severidade e encerramento).
4. **Prioridade:** o AppDynamics não tem prioridade de alerta. Ela é o valor fixo `"priority"` do modelo: crie **um modelo por prioridade** (P1…P5) e use o que convém a cada política. Sem prioridade conta como P3.

Cadastro manual (opcional): fonte **AppDynamics** e, no ID, `<aplicação>/<nome da regra de saúde>`.

## Como a aplicação interpreta

- **Identidade do alerta:** `<aplicação>/<regra de saúde>` (se a regra não vier preenchida, usa o nome da política). **Nome:** a regra de saúde. **Aplicação:** `latestEvent.application.name`. **Idempotência:** `latestEvent.id`.
- **Estados** pelo `latestEvent.eventType` (tabela na tela **Máquina de estados**): `POLICY_OPEN_WARNING`/`POLICY_CONTINUES_WARNING` → Aviso; `POLICY_OPEN_CRITICAL`/`POLICY_CONTINUES_CRITICAL`/`POLICY_UPGRADED` → Alerta; `POLICY_DOWNGRADED` → Aviso; `POLICY_CLOSE_*` e `POLICY_CANCELED_*` → Ok. Tipo desconhecido mantém o estado.
- **Variável não preenchida** (texto `${…}`, vazio ou `null`) conta como vazia; sem aplicação ou sem regra/política o evento é recusado (400).
- **Horário:** `event_time` como epoch em milissegundos ou data ISO; qualquer outro formato cai no horário de recebimento.

## Riscos e pontos a validar

1. **Tipos de evento:** a documentação lista como exemplos `POLICY_OPEN_WARNING`, `POLICY_CONTINUES_WARNING`, `POLICY_OPEN_CRITICAL`, `POLICY_CONTINUES_CRITICAL`, `POLICY_UPGRADED`, `POLICY_DOWNGRADED` e `POLICY_CLOSE_WARNING` ("podem não ser exaustivos"). `POLICY_CLOSE_CRITICAL` e `POLICY_CANCELED_*` são **suposição**. Se algum encerramento não for reconhecido, o alerta fica preso em Alerta: confirme cada tipo com um evento real.
2. **Formato de `${latestEvent.eventTime}`:** a página não especifica. Um formato não reconhecido usa o horário de recebimento (a ordenação por horário do provedor se perde nesse caso).
3. **`${latestEvent.deepLink}`:** há relato antigo (2019) de que vem nulo; nesse caso o alerta fica sem link.
4. **Ordem e reentrega:** não verificado como o AppDynamics reenvia em caso de falha da ação. Não há reconciliação nem silenciamento para o AppDynamics (só webhook).
5. **Eventos que não são de regra de saúde** (anomalias, incidentes) também podem acionar a ação; sem `health_rule` caem na política e viram alertas com o nome dela.
