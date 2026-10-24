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
3. **Sem reconciliação.** Se o Global Alerts ficar fora do ar por mais que as 5 tentativas, ou um evento for descartado (item 2), o estado diverge do Datadog. Próxima entrega sugerida: job que lê `GET /api/v1/monitor?monitor_tags=...` (permissão `monitors_read`, chaves `DD-API-KEY`/`DD-APPLICATION-KEY` ou token de serviço — **método de autenticação não verificado nas páginas lidas**) e converte `overall_state` em eventos sintéticos. `Ignored`, `Skipped` e `Unknown` não têm estado interno hoje.
4. **Faixa de IPs de origem — não verificado.** Não use IP como autenticação; o segredo no header é a barreira. Se a empresa restringir por IP, consulte a lista oficial do Datadog (`ip-ranges`).
5. **Segredo em trânsito:** exigir HTTPS fora do ambiente local.
6. **Monitores multi-alerta (por grupo) — comportamento não verificado nas páginas lidas.** Se um monitor com `group by` enviar eventos por grupo com o mesmo `$ALERT_ID`, hoje eles colapsam em um alerta só (o último evento vence). Tratar grupos como alertas separados exigiria incluir `$ALERT_CYCLE_KEY`/escopo na identidade — decisão pendente.

## Silenciar monitores pela API (ação da aplicação no Datadog)

A aplicação passou a **escrever** no Datadog: silenciar e reativar um monitor. Estudo feito em 2026-10-24 nas páginas oficiais [Monitors](https://docs.datadoghq.com/api/latest/monitors/), [Mute a monitor](https://docs.datadoghq.com/api/latest/monitors/mute-a-monitor.md), [Unmute a monitor](https://docs.datadoghq.com/api/latest/monitors/unmute-a-monitor.md) e [Downtimes](https://docs.datadoghq.com/api/latest/downtimes/).

| Item | Documentado | Uso aqui |
|---|---|---|
| Silenciar | `POST /api/v1/monitor/{monitor_id}/mute`; query `scope` (opcional) e `end` (POSIX, em segundos); permissão `monitors_write`; responde **200 com o objeto do monitor** | `createDatadogControl().mute`; `end` **sempre enviado** (prazo obrigatório de 1 min a 7 dias) |
| Reativar | `POST /api/v1/monitor/{monitor_id}/unmute`; query `scope` e `all_scopes` (padrão `false`); `monitors_write` | `unmute`; usa o escopo guardado, ou `all_scopes=true` se pedido |
| Estado do monitor | `overall_state`: `Alert, Ignored, No Data, OK, Skipped, Unknown, Warn` | A resposta do silenciar/reativar informa o estado atual; a aplicação o aplica como evento (`OK→recovered`, `Warn→warned`, `Alert→triggered`, `No Data→data_missing`; os demais são ignorados) |
| Alternativa | Downtimes v2: `POST /api/v2/downtime` (corpo `data.type=downtime`, `attributes.scope`, `monitor_identifier.monitor_id`, `schedule.start/end` em UTC), `DELETE /api/v2/downtime/{id}`; permissão **`monitors_downtime`**. Os downtimes v1 estão marcados como obsoletos | **Não usada.** O pedido foi o mute do monitor; downtimes são o caminho moderno (agenda, mensagem, cancelar por id) e ficam como evolução |

**Configuração:** `DD_API_KEY` e `DD_APP_KEY` (cabeçalhos `DD-API-KEY` e `DD-APPLICATION-KEY`), `DD_SITE` (padrão `datadoghq.com`; lista fechada de sites) e, só para testes, `DD_API_BASE_URL`. Sem as duas chaves o recurso fica desligado (503 na API e aviso na tela). O destino é sempre `https://api.<site>`; as chaves nunca aparecem em logs, erros ou auditoria.

**Comportamento da aplicação:** exige **motivo** e **prazo** (a identidade vem do SSO); chama o Datadog **antes** de gravar localmente (se o Datadog recusar, nada muda e a tentativa fica na auditoria como `monitor_mute_failed`); registra `monitor_muted`/`monitor_unmuted` com ator, motivo, prazo, escopo e estado informado. Erros do Datadog: 404 vira 404; qualquer outro (403, 429, rede) vira 502 com a mensagem curta do Datadog. O alerta **continua contando** na saúde da jornada e aparece com a etiqueta "Silenciado".

### Riscos e pontos não verificados

1. **Durante um silêncio o Datadog não envia notificações**, logo nem webhooks (comportamento esperado, não confirmado nas páginas lidas): o estado local pode ficar desatualizado. Mitigação implementada: ao silenciar e ao reativar, o estado devolvido pelo Datadog é aplicado. Não há leitura periódica; a reconciliação com `GET /api/v1/monitor` segue recomendada.
2. **Cabeçalhos de autenticação:** as páginas lidas não os mostram; a documentação geral cita também token `Bearer`. `DD-API-KEY`/`DD-APPLICATION-KEY` é o esquema usual, **não verificado** aqui.
3. **Obsolescência:** o campo `silenced` do modelo de monitor está marcado como obsoleto; os endpoints `mute`/`unmute` do monitor constam sem aviso de descontinuação. Se forem descontinuados, a troca é só no adaptador (`src/providers/datadog/api.ts`) para Downtimes v2.
4. **Sem `end`:** não verificado o que o Datadog faz sem `end`; por isso a aplicação nunca silencia sem prazo.
5. **Respostas de erro 400/403/404/429:** formato não detalhado nas páginas lidas; a aplicação lê `errors[0]` se existir.
6. **Nunca testado contra o Datadog real.** Todos os testes usam o Datadog simulado (`simulator/`) e mocks. Valide com um monitor de teste e chaves de uma conta de homologação antes de usar em produção.
7. **Permissões:** a chave de aplicação precisa de `monitors_write`. Use uma chave de serviço com o menor escopo possível; qualquer usuário que passe pelo SSO passa a poder silenciar qualquer monitor ligado a essa chave (a aplicação não restringe por papel).
