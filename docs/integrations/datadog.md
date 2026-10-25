# Integração com o Datadog

Estudo das APIs do Datadog feito em 2026-10-23 e como o Global Alerts as usa. Fontes: [Webhooks](https://docs.datadoghq.com/integrations/webhooks/) e [Monitors API](https://docs.datadoghq.com/api/latest/monitors/get-all-monitors.md). Itens marcados **não verificado** não constam na documentação lida e devem ser confirmados com um webhook real antes de produção.

## O que o Datadog oferece

| Recurso | Fato documentado | Uso aqui |
|---|---|---|
| Webhooks (integração) | POST para a URL configurada; **payload JSON personalizável**; **headers personalizados** em JSON; variáveis como `$ID`, `$ALERT_ID`, `$ALERT_TITLE`, `$ALERT_TRANSITION`, `$ALERT_TYPE`, `$ALERT_PRIORITY`, `$TAGS`, `$LAST_UPDATED` (epoch ms), `$LINK`, `$ORG_ID` | Entrada de eventos (`POST /api/webhooks/datadog`) |
| Disparo | Citar `@webhook-<nome>` na mensagem do monitor | Configuração em cada monitor (ou em template) |
| Autenticação | Basic na URL (`https://user:pass@host`), **custom headers**, OAuth 2.0 | **Header `X-Webhook-Secret`** com segredo compartilhado, comparado em tempo constante |
| Reentrega | Só em **erro interno ou resposta 5xx**; **timeout de 15 s**; **5 tentativas** | Responder rápido; 2xx para duplicata; 4xx só quando reenviar não adianta; 5xx só em falha transitória |
| Estados do monitor (API) | `overall_state`: `Alert, Ignored, No Data, OK, Skipped, Unknown, Warn` | Mapeamento para os 4 estados internos (abaixo) |
| Monitors API | `GET /api/v1/monitor` (filtros `monitor_tags`, `name`; paginação `page`/`page_size` ou `id_offset`), exige permissão `monitors_read` | **Não usada ainda** (reconciliação futura) |
| Sites | `api.datadoghq.com`, `api.datadoghq.eu`, `api.us3…`, `api.us5…`, `api.ap1…` etc. | Relevante só para a reconciliação |

## Configurar o webhook no Datadog

Em **Integrations → Webhooks → New**:

- **Name:** `global-alerts` (os monitores citam `@webhook-global-alerts`).
- **URL:** `https://<host-do-global-alerts>/api/webhooks/datadog`.
- **Custom Headers:** `{"X-Webhook-Secret": "<valor de DATADOG_WEBHOOK_SECRET>"}`. Marque a variável como oculta (custom variables → *hide from view*).
- **Payload:**

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

Em cada monitor, inclua `@webhook-global-alerts` na mensagem **e** use a tag `service:<aplicação>` (ou `app:` / `application:`): é dela que vem a aplicação do mapa. Monitores sem essas tags caem na aplicação `unassigned`.

## Como o Global Alerts interpreta o evento

- **Identidade e idempotência:** `event_id` (`$ID`, id do evento do Datadog) é a chave única; reentregas respondem 200 `duplicate` sem duplicar a transição.
- **Ordem:** `last_updated` (`$LAST_UPDATED`) é comparado ao último evento aplicado do monitor; evento mais antigo é gravado como `stale` e não altera o estado (as entregas não têm garantia de ordem).
- **Transição → evento interno** (`mapTransition`): contém `recover` → `recovered`; `no data` → `data_missing`; `warn` → `warned`; `trigger` (inclui `Re-Triggered`) → `triggered`. Sem transição reconhecida, usa `alert_type`: `success`→`recovered`, `warning`→`warned`, `error`→`triggered`. Sem nada reconhecível, o evento é gravado como `ignored`.
- **Prioridade:** `P1`..`P5` ou `1`..`5`; qualquer outro valor vira "sem prioridade".
- **Link:** só `http(s)` é aceito (vira `href` na interface).

## Riscos e pontos a validar

1. **Valores exatos de `$ALERT_TRANSITION` — não verificado.** A documentação lista `Recovered` e `Triggered`/`Re-Triggered`; os textos para aviso e sem dados (`Warn`, `No Data`) foram inferidos e o mapeamento tem fallback por `$ALERT_TYPE`. Confirme com um monitor de teste em cada estado.
2. **Escape de JSON — não verificado.** A documentação não diz se o Datadog escapa aspas e barras nas variáveis. Um `$ALERT_TITLE` com aspas pode gerar JSON inválido: o Global Alerts responde **400** (o Datadog não reenvia 4xx) e o evento se perde. Mitigações: evitar aspas em nomes de monitor; não incluir `$EVENT_MSG`/`$TEXT_ONLY_MSG` no payload; e implementar a reconciliação abaixo.
3. **Sem reconciliação.** Se o Global Alerts ficar fora do ar por mais que as 5 tentativas, ou um evento for descartado (item 2), o estado diverge do Datadog. Próxima entrega sugerida: job que lê `GET /api/v1/monitor?monitor_tags=...` (permissão `monitors_read`, chaves `DD-API-KEY`/`DD-APPLICATION-KEY` ou token de serviço — **método de autenticação não verificado nas páginas lidas**) e converte `overall_state` em eventos sintéticos. `Unknown` vira `no_data` e `Ignored`/`Skipped` mantêm o estado (ver Equivalência de estados).
4. **Faixa de IPs de origem — não verificado.** Não use IP como autenticação; o segredo no header é a barreira. Se a empresa restringir por IP, consulte a lista oficial do Datadog (`ip-ranges`).
5. **Segredo em trânsito:** exigir HTTPS fora do ambiente local.
6. **Monitores multi-alerta (por grupo) — comportamento não verificado nas páginas lidas.** Se um monitor com `group by` enviar eventos por grupo com o mesmo `$ALERT_ID`, hoje eles colapsam em um alerta só (o último evento vence). Tratar grupos como alertas separados exigiria incluir `$ALERT_CYCLE_KEY`/escopo na identidade — decisão pendente.

## Silenciar monitores pela API (ação da aplicação no Datadog)

A aplicação passou a **escrever** no Datadog: silenciar e reativar um monitor. Estudo feito em 2026-10-24 nas páginas oficiais [Monitors](https://docs.datadoghq.com/api/latest/monitors/), [Mute a monitor](https://docs.datadoghq.com/api/latest/monitors/mute-a-monitor.md), [Unmute a monitor](https://docs.datadoghq.com/api/latest/monitors/unmute-a-monitor.md) e [Downtimes](https://docs.datadoghq.com/api/latest/downtimes/).

| Item | Documentado | Uso aqui |
|---|---|---|
| Silenciar | `POST /api/v1/monitor/{monitor_id}/mute`; query `scope` (opcional) e `end` (POSIX, em segundos); permissão `monitors_write`; responde **200 com o objeto do monitor** | `createDatadogControl().mute`; `end` **sempre enviado** (prazo obrigatório de 1 min a 7 dias) |
| Reativar | `POST /api/v1/monitor/{monitor_id}/unmute`; query `scope` e `all_scopes` (padrão `false`); `monitors_write` | `unmute`; usa o escopo guardado, ou `all_scopes=true` se pedido |
| Estado do monitor | `overall_state`: `Alert, Ignored, No Data, OK, Skipped, Unknown, Warn` | A resposta do silenciar/reativar informa o estado atual; a aplicação o aplica como evento (ver a tabela de Equivalência de estados abaixo) |
| Alternativa | Downtimes v2: `POST /api/v2/downtime` (corpo `data.type=downtime`, `attributes.scope`, `monitor_identifier.monitor_id`, `schedule.start/end` em UTC), `DELETE /api/v2/downtime/{id}`; permissão **`monitors_downtime`**. Os downtimes v1 estão marcados como obsoletos | **Não usada.** O pedido foi o mute do monitor; downtimes são o caminho moderno (agenda, mensagem, cancelar por id) e ficam como evolução |

**Configuração:** `DD_API_KEY` e `DD_APP_KEY` (cabeçalhos `DD-API-KEY` e `DD-APPLICATION-KEY`), `DD_SITE` (padrão `datadoghq.com`; lista fechada de sites) e, só para testes, `DD_API_BASE_URL`. Sem as duas chaves o recurso fica desligado (503 na API e aviso na tela). O destino é sempre `https://api.<site>`; as chaves nunca aparecem em logs, erros ou auditoria.

**Comportamento da aplicação:** exige **motivo** e **prazo** (a identidade vem do SSO); grava a intenção (`mute_operations`), chama o Datadog e só então grava o resultado numa transação (se o Datadog recusar, nada muda e a tentativa fica na auditoria como `monitor_mute_failed`; se o processo cair no meio, a operação é reexecutada pela reconciliação ou por `POST /api/mute-operations/recover`, ver `docs/architecture.md`); registra `monitor_muted`/`monitor_unmuted` com ator, motivo, prazo, escopo e estado informado. Erros do Datadog: 404 vira 404; qualquer outro (403, 429, rede) vira 502 com a mensagem curta do Datadog. O alerta **continua contando** na saúde da jornada e aparece com a etiqueta "Silenciado".

### Riscos e pontos não verificados

1. **Durante um silêncio o Datadog não envia notificações**, logo nem webhooks (comportamento esperado, não confirmado nas páginas lidas): o estado local pode ficar desatualizado. Mitigação implementada: ao silenciar e ao reativar, o estado devolvido pelo Datadog é aplicado. Não há leitura periódica; a reconciliação com `GET /api/v1/monitor` segue recomendada.
2. **Cabeçalhos de autenticação:** as páginas lidas não os mostram; a documentação geral cita também token `Bearer`. `DD-API-KEY`/`DD-APPLICATION-KEY` é o esquema usual, **não verificado** aqui.
3. **Obsolescência:** o campo `silenced` do modelo de monitor está marcado como obsoleto; os endpoints `mute`/`unmute` do monitor constam sem aviso de descontinuação. Se forem descontinuados, a troca é só no adaptador (`src/providers/datadog/api.ts`) para Downtimes v2.
4. **Sem `end`:** não verificado o que o Datadog faz sem `end`; por isso a aplicação nunca silencia sem prazo.
5. **Respostas de erro 400/403/404/429:** formato não detalhado nas páginas lidas; a aplicação lê `errors[0]` se existir.
6. **Idempotência do mute/unmute não verificada:** a recuperação repete a chamada com os mesmos parâmetros e assume que o resultado é o mesmo.
   **Nunca testado contra o Datadog real.** Todos os testes usam o Datadog simulado (`simulator/`) e mocks. Valide com um monitor de teste e chaves de uma conta de homologação antes de usar em produção.
7. **Permissões:** a chave de aplicação precisa de `monitors_write`. Use uma chave de serviço com o menor escopo possível; qualquer usuário que passe pelo SSO passa a poder silenciar qualquer monitor ligado a essa chave (a aplicação não restringe por papel).

## Equivalência de estados (Datadog -> aplicação)

Fonte única no código: `src/providers/datadog/states.ts` (também exibida na tela **Máquina de estados**). Usada pelo webhook, pelo silêncio e pela reconciliação.

### Estado informado pela API (`overall_state`)

| Datadog | Aqui | Origem da decisão |
|---|---|---|
| `OK` | `ok` | direta |
| `Warn` | `warn` | direta |
| `Alert` | `alert` | direta |
| `No Data` | `no_data` | direta (o monitor existe mas não recebe dados) |
| `Unknown` | `no_data` | **decisão de produto**: monitor ainda não avaliado = saúde desconhecida, o mesmo significado de "sem dados" aqui (todo alerta novo nasce em `no_data`) |
| `Skipped` | *mantém o atual* | **decisão de produto**: avaliação pulada não informa saúde |
| `Ignored` | *mantém o atual* | **decisão de produto**: ignorado pelo Datadog não informa saúde |
| qualquer outro valor | *mantém o atual* | defensivo: o enum pode crescer |

O enum `Alert, Ignored, No Data, OK, Skipped, Unknown, Warn` vem da documentação; **o significado de Skipped, Ignored e Unknown não está nas páginas lidas** e as três linhas acima precisam ser confirmadas com quem opera os monitores. "Mantém o atual" significa que o estado local não muda, mas o valor bruto é guardado (`alerts.provider_state` / `provider_state_at`) e aparece na tela do alerta, para a divergência ficar visível.

Pontos de atenção:

- **`no_data` tem dois significados**: "o Datadog diz que não há dados" (`No Data`) e "ainda não sabemos" (`Unknown`, alerta recém-criado). Aqui os dois aparecem como "Sem dados". Se a operação precisar separá-los, o caminho é um quinto estado `unknown`.
- Um monitor que fique em `Skipped`/`Ignored` por muito tempo continua com o último estado conhecido: o estado local pode ficar obsoleto sem que nada acuse. A tela do alerta mostra o valor bruto e a data da leitura para isso.

### Webhook (`$ALERT_TRANSITION` / `$ALERT_TYPE`)

| Texto da transição contém | Evento |
|---|---|
| `recover` | `recovered` -> `ok` |
| `no data` / `no_data` | `data_missing` -> `no_data` |
| `warn` | `warned` -> `warn` |
| `trigger` (inclui `Re-Triggered`) | `triggered` -> `alert` |

A primeira regra que combina vence (por isso "Recovered from No Data" vira `ok`). Sem transição reconhecida vale `$ALERT_TYPE`: `success`->`recovered`, `warning`->`warned`, `error`->`triggered`; sem nada reconhecível o evento é gravado como `ignored`. Os textos de `Warn` e `No Data` são **inferidos** (a documentação lista só `Triggered`, `Recovered` e `Re-Triggered`).

## Reconciliação: listar monitores e respeitar o limite de uso

Estudo de 2026-10-24: [Get all monitors](https://docs.datadoghq.com/api/latest/monitors/get-all-monitors.md) e [Rate Limits](https://docs.datadoghq.com/api/latest/rate-limits/).

| Item | Documentado | Uso aqui |
|---|---|---|
| Listar | `GET /api/v1/monitor`; permissão `monitors_read`; filtros `monitor_tags` (ex.: `service:my-app`), `name`, `tags`; paginação por `page` + `page_size` (padrão 100 quando há `page`; **sem `page` devolve tudo, sem limite**) ou por `id_offset` (começa em 0, usa o último id, repete até vir vazio) | `page`/`page_size`, páginas **a partir de 0** (suposição: a documentação não diz a base) e **sempre paginado** para nunca pedir "tudo" de uma vez |
| Estado | cada monitor traz `overall_state` (enum de 7 valores) | passa pela [equivalência de estados](#equivalência-de-estados-datadog---aplicação) |
| Limites de uso | **A documentação não publica números por endpoint** ("variam e vêm nos cabeçalhos"). Cada resposta traz `X-RateLimit-Limit` (requisições por janela), `-Period` (segundos da janela), `-Remaining`, `-Reset` (segundos até zerar) e `-Name` (nome do limite; endpoints com o mesmo nome compartilham a cota). Estourar devolve **429**; a orientação é esperar o período ou andar um pouco abaixo do limite. Os limites valem por organização/usuário/chave de API (não detalhado por endpoint). Aumentos só pelo suporte | A aplicação **não fixa números**: lê os cabeçalhos a cada resposta |

**Como a reconciliação se comporta com o limite (`src/server/reconcile.ts`):**

1. Lê **uma página por vez** (sequencial), nunca em paralelo.
2. Se `X-RateLimit-Remaining` ≤ 1 e há `X-RateLimit-Reset`, **espera o reset (+1 s) antes da próxima página**, em vez de provocar um 429.
3. Se mesmo assim receber **429**, espera `X-RateLimit-Reset` (ou `Period` se faltar; no mínimo 1 s, no máximo 120 s) **+ 1 s** e repete a mesma página, até **5 vezes**; depois disso a execução falha com a mensagem do 429.
4. Para depois de **10 minutos** ou de **200 páginas** (configurável até 500) e marca a execução como *parcial*; nesse caso **não calcula "ausentes"** (a listagem está incompleta).
5. Guarda os últimos cabeçalhos vistos na execução (aparecem na tela), para você ver a cota real da sua conta.
6. Só **uma execução por vez** por provedor; uma execução que morreu com o processo é liberada após 30 min.

Custo: com 100 por página, 1.000 monitores = 10 requisições por execução; rodar a cada 5 min = ~120 requisições/hora. **Confirme a cota real** da sua conta olhando os cabeçalhos da primeira execução. O silêncio (mute/unmute) pode dividir a mesma cota se tiver o mesmo `X-RateLimit-Name` (não verificado).

**O que a reconciliação faz por monitor:** sem alerta correspondente → cria (desligável); alerta arquivado → ignora; estado do Datadog sem equivalente (Skipped, Ignored) → mantém o estado e guarda o valor bruto; estado equivalente diferente do local → aplica como evento sintético (`reconcile:<execução>:<monitor>`, ator `system:reconciliation`, auditado, dispara remediações). O evento carrega o **instante em que a página foi lida**: se um webhook mais novo chegou durante a leitura, o dado lido é descartado (`stale`) em vez de sobrescrever o webhook. Alertas que o Datadog deixou de listar são **apenas relatados** ("ausentes"), nunca arquivados automaticamente.

**Não verificado:** teto de `page_size`; base 0 de `page`; o nome do limite e a cota de `GET /api/v1/monitor` na sua conta; se `id_offset` combina com `page_size`. Nunca executado contra o Datadog real.
