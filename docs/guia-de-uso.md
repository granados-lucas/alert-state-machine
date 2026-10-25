# Guia de uso: criar alertas e ligá-los ao Datadog

Este guia é para quem opera o Global Alerts. Ele explica o que é cada coisa, como colocar a aplicação no ar, **como criar alertas** e **como ligar cada alerta a um monitor do Datadog** (webhook para receber estados; API para silenciar e reconciliar).

> **Estado da validação:** tudo aqui foi testado contra o Datadog **simulado**. A integração com o Datadog real ainda não foi executada; os pontos que dependem disso estão marcados com ⚠. Valide com um monitor de teste antes de usar em produção.

## 1. Como as peças se encaixam

| Conceito | O que é |
|---|---|
| **Monitor** | O monitor do Datadog. Identificado pelo **ID numérico** (está na URL: `.../monitors/<ID>`). |
| **Alerta** | O monitor dentro do Global Alerts: uma máquina de estados (`ok`, `warn`, `alert`, `no_data`) com histórico. A chave é **provedor + ID do monitor**: o mesmo monitor nunca vira dois alertas. |
| **Aplicação** | O sistema a que o alerta pertence. Vem da tag **`service:`** do monitor. |
| **Jornada** | Um fluxo de negócio (ex.: "Compra") formado por aplicações. A saúde da jornada é o pior estado dos alertas das aplicações dela, ponderado pela prioridade (ver "Prioridade e saúde"). |
| **Remediação** | Uma chamada (webhook ou API) que a aplicação faz quando o alerta entra em certos estados. |

```text
Monitor no Datadog ──(webhook: muda de estado)──▶ Global Alerts ──▶ alerta, aplicação, jornada, histórico
        ▲                                              │
        └──(API: silenciar, listar para reconciliar)───┘
```

Todo alerta **nasce em "Sem dados"** (`no_data`) e só muda quando chega o primeiro evento do Datadog (ou uma reconciliação). Um alerta que você cria e que ainda não recebeu nenhum webhook, portanto, aparece em "Sem dados": isso é esperado.

## 2. Colocar a aplicação no ar

```bash
docker compose up --build        # banco + migrações + aplicação em http://localhost:3000
```

Em produção, defina estas variáveis (nomes em `.env.example`; **nunca** versione valores reais):

| Variável | Para quê | Obrigatória |
|---|---|---|
| `DATABASE_URL` | PostgreSQL | sim |
| `DATADOG_WEBHOOK_SECRET` | segredo do webhook (≥ 16 caracteres). **Sem ele o webhook responde 401 a tudo** | sim, para receber eventos |
| `AUTH_USER_HEADER` | cabeçalho com a identidade do usuário, preenchido pelo SSO (padrão `x-forwarded-email`); só alimenta a auditoria | recomendada |
| `DD_API_KEY`, `DD_APP_KEY` | chaves da API do Datadog (silenciar e reconciliar) | só para essas funções |
| `DD_SITE` | site do Datadog: `datadoghq.com` (padrão), `datadoghq.eu`, `us3.datadoghq.com`, `us5.datadoghq.com`, `ap1.datadoghq.com`, `ap2.datadoghq.com`, `uk1.datadoghq.com`, `ddog-gov.com`, `us2.ddog-gov.com` | só com as chaves |
| `DD_API_BASE_URL` | substitui o destino da API (testes). **Deixe vazio no uso real**: no `compose.yaml` o padrão aponta para o Datadog *simulado* | não |
| `REMEDIATION_ALLOWED_HOSTS` | destinos permitidos para remediação (`host` ou `host:porta`, separados por vírgula). Vazio = nenhuma remediação sai | só com remediação |

**Segurança de implantação (importante):** a aplicação **não tem login**; o SSO corporativo deve ficar na frente e preencher o cabeçalho de identidade. Ela só pode ser alcançada através do SSO. A rota `/api/webhooks/*` precisa ficar **fora** do SSO (quem chama é o Datadog) e é protegida pelo `DATADOG_WEBHOOK_SECRET`. Detalhes em `docs/architecture.md`.

## 3. Criar alertas

Há três caminhos. Escolha conforme a situação.

### 3.1 Descoberta automática (o mais simples)

Depois de ligar o webhook (seção 4), **o primeiro evento de cada monitor cria o alerta sozinho**, com o nome, as tags, a prioridade e a aplicação que o Datadog enviou. Não há nada a cadastrar. Use esta opção quando você só quer enxergar os monitores.

Desvantagem: o alerta só aparece depois que o monitor mudar de estado pelo menos uma vez. Para importar todos os monitores de uma vez, use a **reconciliação** (seção 7).

### 3.2 Pela tela (**Novo alerta**, `/alerts/new`)

Use quando quiser registrar o monitor **antes** do primeiro webhook ou configurar **remediação**.

| Campo | O que preencher |
|---|---|
| **ID do monitor no provedor (Datadog)** | O ID numérico do monitor, da URL `.../monitors/<ID>`. **Tem que ser o ID real**: é por ele que os webhooks encontram o alerta. |
| **Nome** | Qualquer nome. O Datadog o atualiza quando enviar eventos. |
| **Aplicação** | O mesmo valor da tag `service:` do monitor (ex.: `checkout`). |
| **Prioridade** (opcional) | P1 a P5. |
| **Tags** (opcional) | Separadas por vírgula. |
| **Link do monitor** (opcional) | URL `http(s)` do monitor no Datadog. |
| **Remediação automática** (opcional) | Ver seção 6. |

Ao salvar, você cai na página do alerta. Se o monitor já tinha sido descoberto por webhook, a tela responde **409** ("alert already exists"): nesse caso o alerta já existe; use a tela do alerta ou adicione a remediação pela API (3.3).

### 3.3 Pela API

Sem token: a autenticação é do SSO (o cabeçalho de identidade vai para a auditoria).

```bash
curl -X POST http://localhost:3000/api/alerts \
  -H "content-type: application/json" \
  -H "x-forwarded-email: voce@empresa.com" \
  -d '{
    "externalId": "1234567",
    "name": "Checkout: taxa de erro alta",
    "application": "checkout",
    "priority": 2,
    "tags": ["service:checkout", "env:prod"],
    "link": "https://app.datadoghq.com/monitors/1234567"
  }'
```

`provider` assume `datadog`. Respostas: `201` criado, `400` entrada inválida (a resposta lista os campos), `409` já existe.

Outras operações (todas auditadas): `GET /api/alerts` (filtros `state`, `application`, `search`, `limit`, `before`), `GET /api/alerts/{id}`, `PATCH /api/alerts/{id}` (nome, prioridade, tags, link, `archived`), `DELETE /api/alerts/{id}` (arquiva; o histórico permanece) e `POST /api/alerts/{id}/remediations`.

## 4. Ligar um alerta ao Datadog: o webhook

Faça **uma vez** a configuração do webhook no Datadog e **uma vez por monitor** a referência a ele.

### 4.1 Configurar o webhook (uma vez)

No Datadog: **Integrations → Webhooks → New** (a integração Webhooks precisa estar instalada na conta).

| Campo | Valor |
|---|---|
| **Name** | `global-alerts` (é o nome que os monitores vão citar) |
| **URL** | `https://<endereço-do-global-alerts>/api/webhooks/datadog` |
| **Custom Headers** | `{"X-Webhook-Secret": "<o mesmo valor de DATADOG_WEBHOOK_SECRET>"}` |
| **Payload** | o JSON abaixo, **exatamente** (cole como está) |
| **Encode as form** | desmarcado |

```json
{
  "event_id": "$ID",
  "monitor_id": "$ALERT_ID",
  "monitor_name": "$ALERT_TITLE",
  "transition": "$ALERT_TRANSITION",
  "alert_type": "$ALERT_TYPE",
  "priority": "$ALERT_PRIORITY",
  "tags": "$TAGS",
  "last_updated": "$LAST_UPDATED",
  "link": "$LINK"
}
```

Dicas:
- Marque o segredo como variável **oculta** no Datadog (custom variables → *hide from view*), para não ficar visível na configuração.
- O endereço precisa ser alcançável **pelo Datadog** (internet pública ou uma rota permitida) e usar **HTTPS**.
- O Datadog dá timeout em 15 s e só reenvia em erro 5xx (até 5 vezes). A aplicação responde rápido e devolve 2xx para duplicatas, então reenvios são seguros.

### 4.2 Fazer cada monitor notificar o webhook

Em **cada monitor** que deve aparecer no Global Alerts:

1. **Cite o webhook na mensagem do monitor:** `@webhook-global-alerts`.
2. **Coloque a tag `service:<aplicação>`** no monitor (ex.: `service:checkout`). É dela que vem a aplicação do mapa. Sem `service:` (nem `app:` ou `application:`), o alerta cai na aplicação `unassigned`.

> ⚠ **Cuidado com condicionais na mensagem.** Se você colocar o `@webhook-global-alerts` só dentro de `{{#is_alert}}...{{/is_alert}}`, a aplicação **nunca saberá da recuperação** e o alerta ficará em "Alerta" para sempre. Cite o webhook **fora de condicionais**, ou dentro de todos os blocos (alerta, aviso, recuperação e sem dados). Esse comportamento das variáveis de mensagem é conhecimento geral do Datadog, não verificado nas páginas lidas.
>
> ⚠ Para o monitor emitir o estado "Sem dados", a opção de notificar quando faltam dados precisa estar ligada no monitor.

### 4.3 Como o Datadog e o Global Alerts se encontram

| Datadog envia | Global Alerts usa para |
|---|---|
| `monitor_id` (`$ALERT_ID`) | achar o alerta (é o **ID do monitor**: o campo "ID do monitor" do cadastro) |
| `event_id` (`$ID`) | idempotência: o mesmo evento não gera duas transições |
| `transition` / `alert_type` | decidir o novo estado (tabela de equivalência na tela **Máquina de estados**) |
| `last_updated` | ordenar: evento mais antigo que o último aplicado é descartado |
| `tags` | aplicação (`service:`), tags do alerta |
| `monitor_name`, `priority`, `link` | nome, prioridade e link do alerta |

Se o monitor ainda não existe como alerta, ele é criado; se existe (por cadastro manual), é atualizado. Os dois casos usam o mesmo ID, por isso o ID tem de ser exato.

### 4.4 Testar a ligação

**Sem o Datadog** (confere segredo, formato e criação do alerta):

```bash
curl -i -X POST https://<endereço>/api/webhooks/datadog \
  -H "content-type: application/json" \
  -H "x-webhook-secret: <DATADOG_WEBHOOK_SECRET>" \
  -d '{"event_id":"teste-1","monitor_id":"1234567","monitor_name":"Teste","transition":"Triggered","alert_type":"error","priority":"P2","tags":"service:checkout","last_updated":"1767225600000","link":""}'
```

Resposta esperada: `200 {"status":"applied","alertId":…,"state":"alert"}`. Repetir o mesmo comando devolve `{"status":"duplicate"}`.

**Com o Datadog:** provoque a mudança de estado de um monitor de teste (ou use o teste de notificação do editor do monitor, se a sua conta tiver) e confira em **Alertas** que o alerta mudou e, no detalhe, que a auditoria tem a mudança de estado (ator `system:datadog`).

### 4.5 Respostas do webhook e o que fazer

| Resposta | Significado | Ação |
|---|---|---|
| `200` `applied` / `unchanged` / `stale` / `ignored` / `duplicate` | processado (estado mudou / igual / evento antigo / sem efeito / repetido) | nada |
| `401` | segredo ausente ou errado (ou `DATADOG_WEBHOOK_SECRET` não configurado) | conferir o cabeçalho `X-Webhook-Secret` e a variável |
| `400` | JSON inválido ou campos obrigatórios ausentes | conferir o payload; ver a armadilha das aspas abaixo |
| `413` | corpo maior que 64 KB | não deve ocorrer com o payload recomendado |
| `404` | provedor desconhecido na URL | use `/api/webhooks/datadog` |
| `500` | falha interna (ex.: banco fora do ar) | o Datadog reenvia sozinho |

> ⚠ **Aspas no nome do monitor.** A documentação do Datadog não diz se ele escapa aspas e barras nos valores do payload. Um nome de monitor com `"` pode gerar JSON inválido: a aplicação responde 400, o Datadog **não** reenvia (4xx) e o evento se perde. Evite aspas em nomes de monitores e use a reconciliação (seção 7) como rede de segurança.

## 5. Organizar: aplicações e jornadas

- A **aplicação** é criada automaticamente a partir da tag `service:`.
- Para agrupar aplicações em um fluxo de negócio, use **Nova jornada** (`/journeys/new`): nome, descrição e as aplicações (marque as existentes ou digite novas separadas por vírgula). Uma aplicação pode estar em **várias** jornadas.
- Pela API: `POST /api/journeys` com `{"name":"Compra","description":"...","applications":["checkout","payments"]}`; troque as aplicações com `PUT /api/journeys/{id}/applications`.
- O mapa (`/`) mostra cada jornada com a cor do pior estado entre os alertas das aplicações dela (com o rebaixamento por prioridade) e o índice de saúde. Aplicações fora de qualquer jornada aparecem no grupo "Sem jornada".

### Prioridade e saúde (o peso do alerta)

A **prioridade** do alerta (P1 a P5; no Datadog, 1 é a mais alta) é o seu **peso**: P1=16, P2=8, P3=4, P4=2, P5=1; alerta sem prioridade conta como P3. Ela define dois resultados em cada aplicação e jornada:

- **Cor:** o pior estado dos alertas, com **rebaixamento**: um alerta em Alerta só deixa o item **vermelho** se for P1, P2, P3 ou sem prioridade; P4 e P5 em Alerta deixam **âmbar**. A tela mostra quantos foram rebaixados.
- **Índice de saúde (0 a 100%)**: média ponderada pelo peso (ok 0, sem dados 25%, aviso 50%, alerta 100% de desconto). Um P1 em Alerta derruba o índice muito mais que um P5.

Onde a prioridade vem: do campo **Prioridade** no cadastro, do `priority` do webhook (`$ALERT_PRIORITY`) ou do `PATCH /api/alerts/{id}`; mudar a prioridade muda a cor na próxima leitura. Defina a prioridade nos monitores do Datadog para o mapa refletir a importância de cada um.

## 6. Remediação: acionar outra ferramenta quando o alerta mudar de estado

Configure no cadastro do alerta (seção "Remediação automática") ou por `POST /api/alerts/{id}/remediations`.

| Campo | Detalhe |
|---|---|
| **Tipo** | `webhook` (POST com o payload padrão) ou `api` (método, headers e corpo próprios) |
| **URL** | `http(s)`, **sem usuário/senha na URL**, e o host **tem que estar em `REMEDIATION_ALLOWED_HOSTS`**; senão a execução é registrada como "pulada" |
| **Dispara ao entrar em** | um ou mais estados (padrão: Alerta) |
| **Timeout** | 100 ms a 15 s (padrão 5 s) |
| **Headers** (tipo `api`) | JSON. **Segredos nunca em texto**: use `env:NOME` (a aplicação lê a variável `NOME` do ambiente na hora de chamar). Header sensível (`authorization`, `*token*`, `*key*`, `*secret*`, `cookie`, `password`) com valor literal é recusado |
| **Corpo** (tipo `api`) | modelo com `{{alert.id}}`, `{{alert.name}}`, `{{alert.application}}`, `{{alert.state}}`, `{{alert.previous_state}}`, `{{alert.priority}}`, `{{alert.link}}`, `{{alert.tags}}` (valores já escapados para JSON; você escreve as aspas) |

Payload padrão do tipo `webhook`:

```json
{ "source": "global-alerts", "alert": { "id": 1, "name": "…", "application": "checkout", "state": "alert", "previous_state": "ok", "priority": 2, "tags": ["…"], "link": "…" }, "firedAt": "2026-…" }
```

Cada execução (sucesso, falha ou pulada, com status HTTP e duração) aparece no detalhe do alerta e na auditoria. Uma tentativa por disparo, sem retry automático.

## 7. Silenciar monitores e reconciliar (usam a **API** do Datadog)

Pré-requisito: `DD_API_KEY`, `DD_APP_KEY` (e `DD_SITE`) configurados e `DD_API_BASE_URL` **vazio**. Sem as chaves, esses recursos ficam desligados (a tela avisa).

**Criar as chaves (Datadog):** uma chave de API e uma chave de aplicação, de preferência de uma conta de serviço, com o menor escopo possível: `monitors_write` para silenciar e `monitors_read` para listar (reconciliar). ⚠ Os cabeçalhos usados são `DD-API-KEY` e `DD-APPLICATION-KEY` (esquema usual; não verificado nas páginas lidas).

- **Silenciar** (cartão "Silêncio no Datadog" na página do alerta): escolha a duração (15 min a 7 dias, **obrigatória**), o motivo (**obrigatório**, fica na auditoria) e, se quiser, um escopo (ex.: `host:app1`). Durante o silêncio o Datadog não envia notificações, então o estado aqui pode ficar desatualizado; ao silenciar e ao remover, a aplicação aplica o estado que o Datadog informa. O alerta continua contando na saúde da jornada, com a etiqueta "Silenciado".
- **Operação pendente:** se a aplicação cair depois de o Datadog aceitar o silêncio e antes de gravá-lo, a página do alerta mostra o aviso "operação sem desfecho gravado". Ela é concluída sozinha na próxima reconciliação (ou com `POST /api/mute-operations/recover`); enquanto isso, novos silêncios nesse alerta respondem `409` por até 1 minuto.
- **Reconciliar** (tela **Reconciliação**, ou `scripts/reconcile.mjs`): compara todos os alertas com o estado real dos monitores, corrige divergências (webhook perdido, monitor silenciado), **cria alertas dos monitores novos** (a forma mais rápida de importar tudo) e aponta os que sumiram. Comece **simulando** (a opção vem marcada). Respeita o limite de uso da API do Datadog. Para rodar periodicamente: `node scripts/reconcile.mjs --url http://app:3000 --every 300` (mais exemplos no README).

## 8. Conferir o resultado

| Onde | O que ver |
|---|---|
| **Mapa de jornadas** (`/`) | cor de cada jornada e aplicação; "Mudanças recentes" ao lado |
| **Alertas** (`/alerts`) | lista com filtros por estado, aplicação e nome |
| **Detalhe do alerta** | estado, **estado bruto lido no Datadog** (e aviso se divergir), jornadas, remediações e execuções, silêncio e a **auditoria completa** (quem, quando, antes/depois) |
| **Máquina de estados** (`/graph`) | transições e a **tabela de equivalência** com os estados do Datadog |
| **Reconciliação** (`/reconciliation`) | histórico de execuções, resumo e limites de uso vistos |

## 9. Problemas comuns

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| Webhook devolve `401` | segredo diferente ou não configurado | igualar o cabeçalho `X-Webhook-Secret` e `DATADOG_WEBHOOK_SECRET` |
| O alerta existe mas fica em "Sem dados" | nenhum evento chegou: o `@webhook-global-alerts` não está na mensagem do monitor, ou o ID do cadastro não é o do monitor | conferir a mensagem do monitor e o ID; rodar uma reconciliação |
| O alerta foi criado, mas na aplicação `unassigned` | o monitor não tem a tag `service:` | adicionar a tag no monitor (o próximo evento move o alerta) |
| Dois alertas "iguais" | IDs de monitor diferentes | cada monitor do Datadog é um alerta; arquive o que sobrar |
| O alerta nunca volta para OK | o webhook só está dentro de `{{#is_alert}}` (sem recuperação) | citar o webhook fora de condicionais; reconciliar para corrigir agora |
| Estado diferente do Datadog | webhook perdido ou monitor silenciado | reconciliar; o detalhe do alerta mostra o estado bruto lido |
| Silenciar responde `503` | chaves do Datadog não configuradas | definir `DD_API_KEY` e `DD_APP_KEY` |
| Silenciar responde `502` | o Datadog recusou (403 sem permissão, 429 limite de uso, rede) | ver a mensagem; a tentativa fica na auditoria como falha |
| Silenciar responde `409` | há uma operação de silêncio em andamento ou pendente neste alerta | aguardar 1 minuto, ou `POST /api/mute-operations/recover` |
| Silenciar responde `404` | o monitor não existe no Datadog (ID errado) | corrigir o ID |
| Remediação "pulada" | host fora de `REMEDIATION_ALLOWED_HOSTS` | adicionar o host (com cuidado: é uma chamada de saída) |
| Reconciliação "Falhou: Datadog rate limit reached (429)" | cota da API esgotada | tentar de novo mais tarde; olhe o limite visto na tela; reduza a frequência |
| "a reconciliation is already running" | já há uma execução (ou uma travada, liberada em 30 min) | aguardar |

## 10. Referências

- `docs/integrations/datadog.md`: estudo da API do Datadog, equivalência de estados, limites de uso e o que **não** foi verificado.
- `docs/architecture.md`: arquitetura, auditoria e segurança (SSO, remediação).
- `README.md`: Docker, simulador, modo demonstração e reconciliação periódica.
- `PRODUCT.md`: escopo, premissas e pendências.
