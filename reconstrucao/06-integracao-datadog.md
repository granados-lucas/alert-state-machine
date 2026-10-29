# 06 — Integração com o Datadog

Estudo feito nas páginas oficiais (Webhooks, API de Monitors, Mute/Unmute, Downtimes). Itens marcados **⚠ não verificado** não constam na documentação lida e devem ser confirmados com um monitor de teste antes de produção. **Nunca foi executado contra o Datadog real.**

## O que o Datadog oferece (e o que usamos)

| Recurso | Fato documentado | Uso |
|---|---|---|
| Webhooks (integração) | POST para uma URL; **payload JSON personalizável**; **cabeçalhos personalizados** (JSON); variáveis `$ID`, `$ALERT_ID`, `$ALERT_TITLE`, `$ALERT_TRANSITION`, `$ALERT_TYPE`, `$ALERT_PRIORITY`, `$TAGS`, `$LAST_UPDATED` (epoch em ms), `$LINK` | Entrada de eventos |
| Disparo | Citar `@webhook-<nome>` na mensagem do monitor | Configuração em cada monitor |
| Reentrega | Só em erro interno ou resposta 5xx; timeout 15 s; 5 tentativas | Responder rápido; 2xx para duplicata |
| Estado do monitor (API) | `overall_state`: `Alert, Ignored, No Data, OK, Skipped, Unknown, Warn` | Silêncio e reconciliação |
| Silenciar | `POST /api/v1/monitor/{id}/mute`; query `scope`, `end` (epoch em **segundos**); permissão `monitors_write`; responde 200 com o objeto do monitor | Ação de silêncio |
| Reativar | `POST /api/v1/monitor/{id}/unmute`; query `scope`, `all_scopes` (padrão false); `monitors_write` | Ação de silêncio |
| Listar | `GET /api/v1/monitor` com `page`, `page_size`, `monitor_tags`; permissão `monitors_read` | Reconciliação |
| Autenticação da API | Cabeçalhos `DD-API-KEY` e `DD-APPLICATION-KEY` ⚠ (esquema usual; não estava nas páginas lidas) | Todas as chamadas |
| Limites de uso | Cabeçalhos `X-RateLimit-Limit`, `-Period` (s), `-Remaining`, `-Reset` (s até zerar), `-Name`; resposta 429. **A documentação não publica números por endpoint** | Esperar o reset |
| Sites | `datadoghq.com`, `us3.datadoghq.com`, `us5.datadoghq.com`, `datadoghq.eu`, `ap1.datadoghq.com`, `ap2.datadoghq.com`, `uk1.datadoghq.com`, `ddog-gov.com`, `us2.ddog-gov.com`; a API fica em `https://api.<site>` | Destino fixo por lista |
| Alternativa moderna | Downtimes v2 (`POST /api/v2/downtime`, permissão `monitors_downtime`); downtimes v1 e o campo `silenced` estão obsoletos | **Não usada**; evolução |

## 1. Webhook de entrada

Em **Integrations → Webhooks → New** no Datadog:

- **Name**: `global-alerts` (os monitores citam `@webhook-global-alerts`).
- **URL**: `https://<endereço-da-aplicação>/api/webhooks` (a mesma de todas as ferramentas).
- **Custom Headers**: `{"X-Webhook-Secret": "<valor de WEBHOOK_SECRET>"}` (marque como variável oculta).
- **Payload** (cole exatamente; **o campo `source` é obrigatório aqui**):

```json
{
  "source": "datadog",
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

- **Encode as form**: desmarcado. A aplicação precisa ser alcançável **pelo Datadog** (HTTPS).

Em **cada monitor**: citar `@webhook-global-alerts` na mensagem **e** usar a tag `service:<aplicação>` (ou `app:` / `application:`). Sem essas tags a aplicação do alerta é `unassigned`.

> ⚠ Cuidado com condicionais na mensagem do monitor: se o `@webhook-...` estiver só dentro de `{{#is_alert}}`, a recuperação nunca chega e o alerta fica em "Alerta" para sempre. Cite o webhook fora de condicionais ou dentro de todos os blocos (alerta, aviso, recuperação, sem dados). Para emitir "Sem dados", a opção de notificar quando faltam dados precisa estar ligada.

### Interpretação do payload

Entrada (todos os valores chegam como texto; números são aceitos):

| Campo | Obrigatório | Uso |
|---|---|---|
| `event_id` | sim (não vazio) | `externalEventId` (idempotência) |
| `monitor_id` | sim | `externalAlertId` |
| `monitor_name` | sim | nome do alerta |
| `transition` | não (padrão vazio) | decide o evento |
| `alert_type` | não | decide o evento se a transição não for reconhecida |
| `priority` | não | `P1`..`P5` ou `1`..`5` (regex `^P?([1-5])$`, sem diferenciar maiúsculas); outro valor = sem prioridade |
| `tags` | não | texto com tags separadas por vírgula; cada uma com espaços removidos |
| `last_updated` | não | epoch em ms → `occurredAt`; ausente/inválido/zero = agora |
| `link` | não | só `http`/`https` é aceito (vira link na tela); senão nulo |

**Aplicação**: tag `service:` (ou `app:`, depois `application:`, nessa ordem, sem diferenciar maiúsculas); sem nenhuma, `unassigned`.

**Transição → evento** (texto em minúsculas, **a primeira regra que casar com "contém" vence**):

| Contém | Evento |
|---|---|
| `recover` | `recovered` |
| `no data` ou `no_data` | `data_missing` |
| `warn` | `warned` |
| `trigger` (inclui "Re-Triggered") | `triggered` |

Se nada casar, usa `alert_type` (minúsculas): `success`→`recovered`, `warning`→`warned`, `error`→`triggered`. Se também não casar: evento nulo (outcome `ignored`; metadados ainda são atualizados).

⚠ Os textos exatos de `$ALERT_TRANSITION` para aviso e sem dados foram **inferidos** (a documentação só lista Triggered/Recovered/Re-Triggered); o `alert_type` serve de contingência. Confirme com um monitor de teste em cada estado.

## 2. Equivalência de estados da API (`overall_state` → estado daqui)

Usada ao silenciar/reativar (o Datadog devolve o estado do monitor) e na reconciliação.

| `overall_state` | Estado aqui | Motivo |
|---|---|---|
| `OK` | `ok` | saudável |
| `Warn` | `warn` | limiar de aviso ultrapassado |
| `Alert` | `alert` | limiar crítico ultrapassado |
| `No Data` | `no_data` | monitor sem dados |
| `Unknown` | `no_data` | sem avaliação ainda: saúde desconhecida |
| `Skipped` | **mantém o atual** | avaliação pulada, não informa saúde |
| `Ignored` | **mantém o atual** | ignorado, não informa saúde |
| qualquer outro valor | **mantém o atual** | desconhecido |

⚠ O **significado** de `Unknown`, `Skipped` e `Ignored` não está nas páginas lidas: as linhas acima são decisão de produto a confirmar com quem opera os monitores. A tabela deve ser **um dado único** usado pelo webhook, pelo silêncio, pela reconciliação e pela tela.

## 3. Silenciar e reativar (API de escrita)

- Pré-requisito: `DD_API_KEY` e `DD_APP_KEY` (de preferência de uma conta de serviço, com o menor escopo: `monitors_write`). Sem as duas, o recurso fica **desligado** (503; a tela avisa).
- Destino **sempre** `https://api.<DD_SITE>` (lista fechada de sites). Um substituto (`DD_API_BASE_URL`) existe **só para testes** e deve ficar vazio em uso real.
- Chamadas: `POST {base}/api/v1/monitor/{id}/mute?end=<segundos>&scope=<escopo?>` e `POST {base}/api/v1/monitor/{id}/unmute?scope=<?>&all_scopes=true?`. O ID do monitor precisa ser **numérico** (até 15 dígitos), senão erro antes de chamar.
- Cabeçalhos `DD-API-KEY`, `DD-APPLICATION-KEY`, `accept: application/json`. **Sem seguir redirecionamentos**, timeout de **10 s**.
- Resposta: o objeto do monitor; usar `overall_state` (texto) como estado bruto e traduzir pela tabela acima.
- Erros: mensagem curta `Datadog responded <status>[: <errors[0] até 200 caracteres>]`; falha de rede/timeout: `Datadog request failed (timeout|network error)`. Nunca incluir chaves nem URL em mensagens, logs ou auditoria.
- O `end` é **sempre** enviado (prazo obrigatório). ⚠ Não se sabe o que o Datadog faz sem `end`.
- Durante um silêncio o Datadog não envia notificações (⚠ comportamento esperado, não confirmado): por isso a aplicação aplica o estado devolvido ao silenciar e ao reativar.
- ⚠ Qualquer usuário que passe pelo SSO pode silenciar qualquer monitor ligado à chave (não há papéis).

## 4. Reconciliação (API de leitura)

- `GET {base}/api/v1/monitor?page=<n>&page_size=<tamanho>[&monitor_tags=a,b]`, timeout de **30 s**, sem redirecionamento, permissão `monitors_read`.
- ⚠ A paginação **começa em 0** (suposição). Fim da listagem: página com menos itens que `page_size`. O teto de `page_size` não está documentado; a aplicação limita a 1000 (padrão 100).
- Cada monitor: `id` (número ou texto → texto), `name` (vazio vira `monitor <id>`), `overall_state`, `tags` (lista), `priority` (inteiro 1–5 ou nulo). Aplicação pela tag `service:`.
- **Limite de uso**: ler os cabeçalhos `X-RateLimit-*` de cada resposta; 429 → esperar `reset` (ou `period`, ou 10 s; no mínimo 1 s, no máximo 120 s, +1 s de folga) e tentar de novo, até 5 vezes. Se `remaining ≤ 1` e há `reset`, esperar o reset **antes** da próxima página. Mostrar na tela os limites vistos.
- Custo: 1000 monitores com páginas de 100 = 10 requisições por execução; a cada 5 min ≈ 120 requisições/hora. ⚠ Confirme a cota real olhando os cabeçalhos da primeira execução. ⚠ O silêncio pode dividir a mesma cota.
- Resposta com formato inesperado → erro `Datadog returned an unexpected monitor list`.

## 5. Riscos e pontos a validar com um monitor de teste

1. Valores exatos de `$ALERT_TRANSITION` (aviso e sem dados).
2. **Escape de JSON**: a documentação não diz se o Datadog escapa aspas/barras nas variáveis. Um `$ALERT_TITLE` com `"` pode gerar JSON inválido: a aplicação responde 400, o Datadog não reenvia (4xx) e o evento se perde. Evite aspas em nomes; use a reconciliação como rede de segurança; não inclua `$EVENT_MSG`/`$TEXT_ONLY_MSG` no payload.
3. Cabeçalhos de autenticação da API (`DD-API-KEY`/`DD-APPLICATION-KEY`).
4. Obsolescência: se `mute`/`unmute` do monitor forem descontinuados, a troca é só no adaptador (para Downtimes v2).
5. Formato das respostas de erro 400/403/404/429.
6. **Faixa de IPs de origem não verificada**: não use IP como autenticação; o segredo é a barreira.
7. Monitores multi-alerta (com `group by`) que enviam eventos por grupo com o mesmo `$ALERT_ID` colapsam em um alerta só (o último evento vence).
8. Idempotência de `mute`/`unmute` repetidos (a recuperação do silêncio assume que são).
