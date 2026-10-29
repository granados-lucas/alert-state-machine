# 13 — Guia de uso (para quem opera a aplicação)

Este guia explica o que é cada coisa, como criar alertas e como ligá-los às ferramentas de monitoramento. As configurações detalhadas de cada ferramenta estão em 06 (Datadog) e 07 (CloudWatch, AppDynamics, genérica).

> **Estado da validação:** tudo foi testado contra simulações e documentação, não contra as ferramentas reais. Os pontos marcados ⚠ dependem disso. Valide com um monitor de teste antes de usar em produção.

## 1. Como as peças se encaixam

| Conceito | O que é |
|---|---|
| **Monitor** | O monitor ou alarme na ferramenta de origem (Datadog: ID numérico; CloudWatch: ARN do alarme; AppDynamics: `aplicação/regra de saúde`) |
| **Alerta** | O monitor dentro do Global Alerts: uma máquina de estados (`ok`, `warn`, `alert`, `no_data`) com histórico. Chave: **fonte + ID do monitor** |
| **Aplicação** | O sistema a que o alerta pertence (vem da tag `service:` no Datadog, da descrição do alarme no CloudWatch, do nome da aplicação no AppDynamics) |
| **Jornada** | Um fluxo de negócio (ex.: "Compra") formado por aplicações. Uma aplicação pode estar em várias jornadas |
| **Remediação** | Uma chamada (webhook ou API) que a aplicação faz quando o alerta entra em certos estados |

```text
Monitor (Datadog, CloudWatch, AppDynamics…) ──(webhook único: muda de estado)──▶ Global Alerts ──▶ alerta, aplicação, jornada, histórico
        ▲                                                                              │
        └──(só Datadog, pela API: silenciar, listar para reconciliar)───────────────────┘
```

Todo alerta **nasce em "Sem dados"** e só muda quando chega o primeiro evento (ou uma reconciliação). Um alerta recém-cadastrado, sem evento, aparece em "Sem dados": é esperado.

## 2. Colocar no ar (resumo)

Defina as variáveis do 09 (no mínimo `DATABASE_URL` e `WEBHOOK_SECRET`), aplique o SQL do 04 e inicie a aplicação. A aplicação **não tem login**: o SSO da empresa fica na frente, preenche o cabeçalho de identidade, e **só ele** pode alcançá-la. O caminho `/api/webhooks` fica **fora** do SSO e é protegido pelo `WEBHOOK_SECRET`.

## 3. Criar alertas

**3.1 Descoberta automática (o mais simples).** Depois de ligar o webhook, **o primeiro evento de cada monitor cria o alerta sozinho**, com nome, tags, prioridade e aplicação que a ferramenta enviou. Desvantagem: só aparece depois que o monitor mudar de estado uma vez. Para importar todos os monitores do Datadog de uma vez, use a **reconciliação** (seção 7).

**3.2 Pela tela (Novo alerta).** Para registrar o monitor **antes** do primeiro evento ou configurar remediação.

| Campo | O que preencher |
|---|---|
| Fonte | Datadog, Amazon CloudWatch, AppDynamics ou Genérico |
| ID do monitor na fonte | O ID **real** (é por ele que os eventos encontram o alerta): Datadog = número da URL do monitor; CloudWatch = ARN do alarme; AppDynamics = `aplicação/regra`; Genérico = o `monitor_id` do webhook |
| Nome | Qualquer nome; a ferramenta o atualiza nos eventos |
| Aplicação | O mesmo valor que a fonte informa (no Datadog, a tag `service:`) |
| Prioridade (opcional) | P1 a P5 |
| Tags, Link (opcionais) | Tags separadas por vírgula; URL http(s) do monitor |
| Remediação (opcional) | Ver seção 6 |

Se o monitor já foi descoberto por webhook, a tela responde **409** ("alert already exists"): o alerta já existe; use a tela dele ou adicione a remediação pela API.

**3.3 Pela API.** `POST /api/alerts` com `{provider, externalId, name, application, priority, tags, link}` (05). Respostas: 201 criado, 400 entrada inválida, 409 já existe. Outras operações (todas auditadas): listar, ver, alterar (nome, prioridade, tags, link, arquivar), arquivar (`DELETE`), adicionar remediação.

## 4. Ligar uma ferramenta ao Global Alerts

Há **um webhook só**: `POST /api/webhooks`, com **um segredo só** (`WEBHOOK_SECRET`). Quem informa a fonte é o campo `source` do corpo:

| Fonte | `source` | Como a ferramenta chama | Guia |
|---|---|---|---|
| Datadog | `datadog` | Integração Webhooks com o payload do 06 | 06 |
| AppDynamics | `appdynamics` | Ação de requisição HTTP com o modelo do 07 | 07 |
| CloudWatch | dispensado | Assinatura HTTPS do SNS com `https://sns:<segredo>@host/api/webhooks` | 07 |
| Qualquer outra | `generic` (ou omitido) | JSON canônico: você informa o estado (`ok`, `warn`, `alert`, `no_data`) | 07 |

**Trocar de ferramenta** (ou ligar uma segunda): a URL e o segredo continuam os mesmos; só muda o modelo de payload da ferramenta nova. Atenção: como o ID é por fonte, trocar de ferramenta cria **alertas novos**; os da ferramenta antiga ficam parados até serem arquivados.

**Testar a ligação sem a ferramenta:**

```bash
curl -i -X POST https://<endereço>/api/webhooks \
  -H "content-type: application/json" -H "x-webhook-secret: <WEBHOOK_SECRET>" \
  -d '{"source":"datadog","event_id":"teste-1","monitor_id":"1234567","monitor_name":"Teste","transition":"Triggered","alert_type":"error","priority":"P2","tags":"service:checkout","last_updated":"1767225600000","link":""}'
```

Resposta esperada: `200 {"status":"applied","alertId":…,"state":"alert"}`. Repetir o comando devolve `{"status":"duplicate"}`.

**Respostas do webhook**

| Resposta | Significado | Ação |
|---|---|---|
| `200` `applied`/`unchanged`/`stale`/`ignored`/`duplicate` | processado (mudou / igual / evento antigo / sem efeito / repetido) | nada |
| `401` | segredo ausente ou errado (ou `WEBHOOK_SECRET` não configurado) | conferir o cabeçalho `X-Webhook-Secret` e a variável |
| `400 invalid payload` | JSON com campos faltando ou fora do formato | conferir o payload da ferramenta |
| `400 unknown source` | `source` com valor inexistente | usar `datadog`, `appdynamics` ou `generic` |
| `413` | corpo maior que 64 KB | não deve ocorrer |
| `500` | falha interna (ex.: banco fora) | a ferramenta reenvia sozinha |

⚠ **Aspas no nome do monitor (Datadog):** a documentação não diz se ele escapa aspas nos valores do payload. Um nome com `"` pode gerar JSON inválido: a aplicação responde 400, o Datadog **não** reenvia e o evento se perde. Evite aspas em nomes de monitores e use a reconciliação como rede de segurança.

## 5. Organizar: aplicações e jornadas

- Uma **aplicação** aparece sozinha quando chega o primeiro evento (ou ao ser citada numa jornada).
- Crie **jornadas** em **Nova jornada**: nome, descrição e as aplicações (escolha entre as existentes ou digite novas, separadas por vírgula). Uma aplicação pode estar em **várias** jornadas, e se um alerta P1–P3 dela entrar em Alerta, ela e todas as jornadas dela ficam vermelhas.
- Em **Editar jornada** você troca as aplicações. Aplicações que ainda não estão em nenhuma jornada aparecem no bloco "Aplicações sem jornada" do mapa.

### Prioridade e saúde (o peso do alerta)

A **prioridade** (P1 a P5; 1 é a mais alta) é o **peso**: P1=16, P2=8, P3=4, P4=2, P5=1; sem prioridade conta como P3. Ela define:

- **Cor**: o pior estado dos alertas, com **rebaixamento**: um alerta em Alerta só deixa o item **vermelho** se for P1, P2, P3 ou sem prioridade; P4 e P5 em Alerta deixam **âmbar**. A tela mostra quantos foram rebaixados.
- **Índice de saúde (0 a 100%)**: média ponderada pelo peso (ok 0, sem dados 25%, aviso 50%, alerta 100% de desconto). Um P1 em Alerta derruba o índice muito mais que um P5.

A prioridade vem do campo no cadastro, do `priority` do evento ou de `PATCH /api/alerts/{id}`. Defina a prioridade nos monitores para o mapa refletir a importância de cada um.

## 6. Remediação: acionar outra ferramenta quando o alerta mudar de estado

Configure no cadastro do alerta ou por `POST /api/alerts/{id}/remediations`.

| Campo | Detalhe |
|---|---|
| Tipo | `webhook` (POST com o payload padrão) ou `api` (método, cabeçalhos e corpo próprios) |
| URL | `http(s)`, **sem usuário/senha**; o host **tem que estar em `REMEDIATION_ALLOWED_HOSTS`**, senão a execução fica "pulada" |
| Dispara ao entrar em | um ou mais estados (padrão: Alerta) |
| Timeout | 100 ms a 15 s (padrão 5 s) |
| Cabeçalhos (tipo `api`) | JSON. **Segredos nunca em texto**: use `env:NOME` (a aplicação lê a variável `NOME` do ambiente na hora de chamar). Um cabeçalho sensível (`authorization`, `*token*`, `*key*`, `*secret*`, `cookie`, `password`) com valor literal é recusado |
| Corpo (tipo `api`) | Modelo com `{{alert.id}}`, `{{alert.name}}`, `{{alert.application}}`, `{{alert.state}}`, `{{alert.previous_state}}`, `{{alert.priority}}`, `{{alert.link}}`, `{{alert.tags}}` (valores já escapados para JSON; você escreve as aspas) |

Payload padrão do tipo `webhook`:

```json
{ "source": "global-alerts", "alert": { "id": 1, "name": "…", "application": "checkout", "state": "alert", "previous_state": "ok", "priority": 2, "tags": ["…"], "link": "…" }, "firedAt": "2026-…" }
```

Cada execução (sucesso, falha ou pulada, com status HTTP e duração) aparece no detalhe do alerta e na auditoria. Uma tentativa por disparo, sem retry automático.

## 7. Silenciar monitores e reconciliar (só Datadog)

Pré-requisito: `DD_API_KEY`, `DD_APP_KEY` (e `DD_SITE`) configurados e `DD_API_BASE_URL` **vazio**. Chaves de preferência de uma conta de serviço, com o menor escopo: `monitors_write` para silenciar e `monitors_read` para listar. Sem as chaves, esses recursos ficam desligados (a tela avisa).

- **Silenciar** (cartão "Silêncio" na página do alerta): escolha a duração (15 min a 7 dias, **obrigatória**), o **motivo** (**obrigatório**; fica na auditoria) e, se quiser, um escopo (ex.: `host:app1`). Durante o silêncio o Datadog não envia notificações, então o estado aqui pode ficar desatualizado; ao silenciar e ao remover, a aplicação aplica o estado que o Datadog informa. O alerta continua contando na saúde, com a etiqueta "Silenciado".
- **Operação pendente**: se a aplicação cair depois de o Datadog aceitar o silêncio e antes de gravá-lo, a página do alerta mostra "operação sem desfecho gravado". Ela é concluída sozinha na próxima reconciliação (ou por `POST /api/mute-operations/recover`); enquanto isso, novos silêncios nesse alerta respondem 409 por até 1 minuto.
- **Reconciliar** (tela Reconciliação ou o script periódico): compara todos os alertas com o estado real dos monitores, corrige divergências (webhook perdido, monitor silenciado), **cria alertas dos monitores novos** (a forma mais rápida de importar tudo) e aponta os que sumiram. Comece **simulando** (a opção vem marcada). Respeita o limite de uso da API do Datadog. Para rodar periodicamente, agende o script (05) a cada 5 minutos.

## 8. Conferir o resultado

| Onde | O que ver |
|---|---|
| Mapa de jornadas (`/`) | Cor e índice de cada jornada e aplicação; "Mudanças recentes" |
| Alertas (`/alerts`) | Lista com filtros por estado, aplicação e nome |
| Detalhe do alerta | Estado, estado bruto lido no Datadog (e aviso se divergir), jornadas, remediações e execuções, silêncio e a **auditoria completa** (quem, quando, antes/depois) |
| Máquina de estados (`/graph`) | Transições e, para cada fonte, a tabela de equivalência de estados |
| Reconciliação (`/reconciliation`) | Histórico de execuções, resumo e limites de uso vistos |
| Status (`/status`) | Saúde da própria aplicação (banco, último evento por fonte, silêncios pendentes, remediações) |

## 9. Problemas comuns

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| Webhook devolve 401 | segredo diferente ou não configurado | igualar o cabeçalho `X-Webhook-Secret` e `WEBHOOK_SECRET` |
| O alerta existe mas fica em "Sem dados" | nenhum evento chegou: o webhook não está na mensagem do monitor, ou o ID do cadastro não é o do monitor | conferir a mensagem do monitor e o ID; rodar uma reconciliação |
| O alerta nunca sai de "Alerta" | a ferramenta não envia a recuperação (ex.: Datadog com o webhook só dentro de um bloco `{{#is_alert}}`; AppDynamics sem o tipo de encerramento) | enviar o webhook também na recuperação; conferir os tipos (07) |
| Alerta criado em `unassigned` | o monitor não tem a tag/identificação da aplicação | incluir `service:<aplicação>` (Datadog) ou o equivalente da fonte |
| Remediação "pulada" | host fora de `REMEDIATION_ALLOWED_HOSTS` | acrescentar o host à lista |
| Remediação falhou "environment variable X is not set" | o cabeçalho `env:X` não tem a variável no ambiente | definir a variável `X` |
| Estado diferente do Datadog | webhook perdido ou monitor silenciado | reconciliar; o detalhe do alerta mostra o estado bruto lido |
| Silenciar responde 503 | chaves do Datadog não configuradas | definir `DD_API_KEY` e `DD_APP_KEY` |
| Silenciar responde 502 | o Datadog recusou (403 sem permissão, 429 limite de uso, rede) | ver a mensagem; a tentativa fica na auditoria como falha |
| Silenciar responde 404 | o monitor não existe no Datadog (ID errado) | corrigir o ID |
| Silenciar responde 409 | há uma operação de silêncio em andamento ou pendente | aguardar 1 minuto ou `POST /api/mute-operations/recover` |
| Reconciliação "rate limit reached (429)" | cota da API esgotada | tentar de novo mais tarde; reduzir a frequência |
| "a reconciliation is already running" | já há uma execução (ou uma travada, liberada em 30 min) | aguardar |
