# 11 — Testes e critérios de aceite

## Estratégia

| Nível | O quê | Onde rodar |
|---|---|---|
| Unidade (sem banco) | Máquina de estados, cálculo de saúde, regras do silêncio, adaptadores de fonte (`parse`, tabelas de equivalência), validações, autenticação, métricas, modelo de remediação | Qualquer ambiente |
| Integração (com banco) | Ingestão, alertas, jornadas, remediação, silêncio atômico, reconciliação, consultas, telemetria | PostgreSQL de teste (ou um banco em memória compatível). **Travas de linha e concorrência só se provam em PostgreSQL de verdade** |
| API | Cada rota: códigos, validações, corpo | Mesmo banco de teste, chamando os handlers |
| Aceite ponta a ponta | Cenários abaixo, com a aplicação rodando | Ambiente de homologação |

Meta usada na versão original: cobertura de **90% de linhas** e **80% de ramos**. Testes verificam o que importa (regras, regressões); não precisam espelhar código trivial.

## Cenários de aceite (dado / quando / então)

### Máquina de estados e ingestão

1. **Alerta novo** — dado nenhum alerta; quando chega `triggered` do monitor 42; então o alerta é criado (auditoria `alert_created`), vai de `no_data` para `alert` (auditoria `state_changed`), resposta `{status:"applied", state:"alert"}`.
2. **Repetição de estado** — dado alerta em `alert`; quando chega outro `triggered` (id de evento novo); então outcome `unchanged`, sem nova linha `state_changed`.
3. **Duplicata** — quando o mesmo `(fonte, event_id)` chega duas vezes; então a segunda responde `{status:"duplicate"}`, **uma** só transição e uma só linha em `webhook_events`.
4. **Concorrência** — quando o mesmo evento chega ao mesmo tempo duas vezes; então um `applied` e um `duplicate`.
5. **Evento antigo** — dado `lastEventAt = 10:00`; quando chega evento com `occurredAt = 09:59`; então `stale`, estado inalterado. Com `occurredAt = 10:00` (igual), **não** é stale.
6. **Alerta arquivado** — quando chega evento; então gravado como `ignored`, nada muda.
7. **Sem efeito** — evento com `event` nulo atualiza metadados e `lastEventAt`, outcome `ignored`.
8. **Mudança de aplicação** — quando a fonte envia o mesmo monitor com outra aplicação; então o alerta muda de aplicação e há auditoria `alert_updated`.
9. **Fonte e ID** — o mesmo ID de monitor em fontes diferentes são **alertas diferentes**.

### Prioridade e saúde (use os números do 02, seção 3)

10. ok P1 + alert P5 → cor `warn`, índice 94, 1 rebaixado. alert P1 + ok P5 → `alert`, 6. no_data P2 ×2 → `no_data`, 75. warn sem prioridade → `warn`, 50. Sem alertas → cor e índice nulos.
11. Um alerta P2 em `alert` deixa a aplicação e **todas** as jornadas dela vermelhas; trocar a prioridade para P5 muda a cor para âmbar na leitura seguinte.
12. A jornada **soma** os alertas das aplicações (não faz média de médias).
13. Alertas arquivados não contam.

### Webhook (rota)

14. Sem segredo / segredo errado / `WEBHOOK_SECRET` não configurado → 401. Basic com a senha correta → aceito (usuário qualquer). `source` desconhecido → 400 `unknown source`. JSON inválido → 400. Corpo > 64 KB → 413. Resposta traz `X-Request-Id` (reaproveita um id simples; troca um id estranho).
15. Datadog, AppDynamics, genérica e CloudWatch pelo **mesmo** endpoint e segredo; trocar `source` não exige mudar URL nem segredo.
16. CloudWatch: `SubscriptionConfirmation` com `SubscribeURL` do SNS → a aplicação a visita (GET, sem redirecionamento) e responde `handshake`. `SubscribeURL` fora de `sns.<região>.amazonaws.com` (http, outro host, com usuário/senha, `169.254.169.254`) → 400 e **nenhuma chamada**. `UnsubscribeConfirmation` ignorada. Reentrega do mesmo `MessageId` → `duplicate`.

### Adaptadores (use fixtures no formato documentado)

17. **Datadog**: tabela de transição (Triggered, Re-Triggered, Recovered, Warn, No Data, e só `alert_type` success/warning/error, "Renotify"+info → nulo); prioridade `P2`/`2`/`""`; link `javascript:` → nulo; aplicação por tag; `last_updated` inválido → agora.
18. **AppDynamics**: cada `event_type` da tabela; tipo desconhecido → evento nulo; variável não preenchida (`${...}`) → vazia; sem aplicação ou sem regra/política → 400.
19. **CloudWatch**: `ALARM`→alert, `OK`→ok, `INSUFFICIENT_DATA`→no_data, valor estranho→nulo; descrição com `service:`/`priority:`; horário com `+0000`; sem `StateChangeTime` usa o `Timestamp`; tópico fora da lista → 400.
20. **Genérica**: payload canônico; `state` inválido → 400; aplicação pela tag quando ausente.

### Remediação

21. Alerta com remediação em `alert`; quando entra em `alert`; então a chamada acontece **depois** da resposta, com o payload padrão; execução gravada (`success`) e auditada.
22. Host fora de `REMEDIATION_ALLOWED_HOSTS` → `skipped`, sem chamada. Lista vazia → nada sai.
23. Cabeçalho `Authorization` literal → 400 ao cadastrar; `env:MEU_TOKEN` aceito e resolvido na hora; variável ausente → execução `failed` com mensagem sobre a variável.
24. Modelo de corpo: `{{alert.name}}` com aspas/quebra de linha no nome produz JSON válido. URL com usuário/senha → 400. `webhook` com método diferente de POST ou com `bodyTemplate` → 400.
25. Resposta 500 do destino → `failed` (HTTP 500). Timeout → `failed` ("timeout"). Fila cheia → `skipped`.

### Silêncio atômico

26. **Sucesso** — mute 60 min com motivo; então o provedor é chamado com `end` correto; o alerta guarda `mutedUntil`, escopo, motivo, autor e o estado bruto; operação `succeeded`; auditoria `monitor_muted`; o estado informado pela fonte é aplicado (com remediações).
27. **Falha da fonte** — 403/500 → alerta intacto, operação `failed`, auditoria `monitor_mute_failed`, erro 502 (404 se a fonte disse 404).
28. **Queda no meio** (falha injetada na gravação) — operação fica `pending` e o alerta intacto; antes de 60 s outra tentativa recebe 409 **sem** chamar a fonte; depois de 60 s a recuperação repete a chamada e conclui com `recovered=true`.
29. **Silêncio expirado pendente** — fecha como `failed`, sem repetir.
30. **Recuperações concorrentes** — gravam resultado e auditoria **uma** só vez.
31. Validações: prazo 0 ou > 10080 → 400; motivo curto/ausente → 400; alerta arquivado → 400; fonte sem credenciais → 503; fonte sem suporte → 501.
32. Reativar usa o escopo guardado; com `allScopes` ignora o escopo e limpa tudo.

### Reconciliação

33. Simulação: relata sem alterar nada. Real: corrige divergências, cria alertas de monitores novos (com a aplicação pela tag), mantém `Skipped`/`Ignored`, relata ausentes **só** em listagem completa e sem filtro.
34. 429: espera o reset e continua; esgotadas as tentativas → `failed`. Limite de tempo ou páginas → `partial`.
35. Duas execuções ao mesmo tempo → a segunda recebe 409. Uma execução `running` há mais de 30 min é marcada `failed` ao iniciar outra.
36. Um webhook mais novo que a leitura vence (o dado lido vira `stale`). Reexecutar logo depois não corrige nada (idempotente).
37. Recupera silêncios pendentes antes de comparar (exceto em simulação).

### Alertas e jornadas (API)

38. Criar alerta duplicado → 409; atualizar sem mudanças não grava auditoria; arquivar remove de listagens e do mapa mas mantém o histórico; listagem com cursor percorre tudo sem repetir.
39. Criar jornada com aplicações novas as cria; nome repetido → 409; trocar aplicações audita antes/depois; remover jornada mantém aplicações e alertas; `unassigned` lista aplicações sem jornada.
40. **Auditoria imutável**: `UPDATE`, `DELETE` e `TRUNCATE` em `audit_log` falham no banco.

### Observabilidade

41. `/api/health/live` 200 sem banco; `/api/health` 503 com o banco fora; `/api/metrics` 200 mesmo com o banco fora (`database_up 0`), com `HELP`/`TYPE` sempre presentes e rótulos sem cardinalidade livre.

### Combinações de alertas

42. **Regras** — com 3 alertas, `and`: 2 em `alert` não vale, 3 vale; `or`: 1 vale, 0 não; `at_least 2`: 1 não vale, 2 vale. `and` sem componentes nunca vale. `warn`, `no_data` e `ok` não contam.
43. **Duração** — regra `and` com 120 s: ao valer vira `pending` (sem automação); aos 119 s continua `pending`; aos 120 s vira `alert` e devolve a automação. Se um alerta sai de `alert` antes, volta a `ok` sem automação e, ao reentrar, a contagem recomeça do zero. Uma combinação de um alerta com duração 300 s também passa por `pending`. Duração 0 vai direto para `alert`.
44. **Silenciado e arquivado** — um alerta silenciado ou arquivado não conta. Alerta em `alert` silenciado por 1 min **sem nenhum evento novo**: depois de 2 min, o avaliador periódico passa a contá-lo. Com `and`, um componente arquivado impede o disparo e a tela avisa.
45. **Gatilhos** — a automação com gatilho só `alert` roda na entrada em `alert` e não na volta a `ok`; com `alert` e `ok` roda nas duas; **nunca** em `pending`, e voltar de `pending` para `ok` não roda nada. Automação desativada não é chamada.
46. **Automação (saída)** — payload padrão com `combination` e a lista de `components` (estado, aplicação, prioridade, desde); modelo de corpo `{{combination.name}}` com aspas ou quebra de linha gera JSON válido; host fora da lista → `skipped` sem chamada; cabeçalho `Authorization` literal → 400 ao cadastrar; `env:NOME` ausente → execução `failed`; resposta 500 → `failed`; execução e auditoria gravadas.
47. **Edição das automações** — qualquer campo pode ser alterado (URL, método, cabeçalhos, corpo, gatilhos, timeout, nome, `enabled`); o resultado é revalidado (webhook com corpo, URL com credenciais, cabeçalho secreto literal → erro); a auditoria guarda antes/depois (de cabeçalhos, só os nomes); sem mudança real nada é gravado; automação de outra combinação → 404.
48. **Cadastro** — nome repetido 409; alerta inexistente ou arquivado 400; 21 alertas ou repetidos 400; `at_least` sem N, N maior que a lista ou N em `and`/`or` 400; atualizar a lista de 3 para 2 alertas com `at_least 3` → erro; trocar `at_least` por `and` sem limpar N → erro; editar reavalia na hora; arquivar tira da listagem e mantém a leitura por id; auditoria de criar, alterar (com a lista de alertas antes/depois) e arquivar.
49. **Concorrência** — duas avaliações ao mesmo tempo da mesma combinação geram **uma** transição, **uma** auditoria e **uma** automação (prove em PostgreSQL de verdade).
50. **Ligação com a ingestão** — o evento que muda o estado do componente avalia a combinação logo depois do commit (webhook, reconciliação e sincronização do silêncio); evento repetido ou antigo não avalia; se a avaliação falhar, o evento continua gravado e a resposta à fonte não muda.
51. **Avaliador periódico** — `POST /api/combinations/evaluate` completa as durações vencidas, executa as automações depois da resposta, grava o heartbeat (linha única) e devolve `{evaluated, changed}`; o script sai com 0, 1 (erro da aplicação), 2 (uso) ou 4 (inacessível) e não para por falha de rede; as métricas e a tela de status mostram "parado" depois de 2 minutos sem ciclo.
52. **Isolamento** — criar, alterar ou disparar combinações não muda o mapa de jornadas nem o índice de saúde de nenhuma aplicação ou jornada.

## Como validar sem simulador

Com a aplicação e o banco no ar, use `curl`:

```bash
# evento genérico (cria o alerta e muda para "alert")
curl -i -X POST https://<app>/api/webhooks \
  -H "x-webhook-secret: $WEBHOOK_SECRET" -H "content-type: application/json" \
  -d '{"source":"generic","event_id":"t1","monitor_id":"m1","monitor_name":"Teste","state":"alert","application":"demo","priority":"P2"}'
# repetir o mesmo comando → {"status":"duplicate"}
# recuperar
curl -X POST https://<app>/api/webhooks -H "x-webhook-secret: $WEBHOOK_SECRET" -H "content-type: application/json" \
  -d '{"source":"generic","event_id":"t2","monitor_id":"m1","monitor_name":"Teste","state":"ok","application":"demo"}'
# segredo errado → 401
curl -i -X POST https://<app>/api/webhooks -H "x-webhook-secret: errado" -d '{}'
```

Depois confira nas telas: o alerta na lista, a aplicação `demo` no mapa (sem jornada, em "Aplicações sem jornada"), a auditoria no detalhe do alerta.

Para cada ferramenta real: configure um monitor de teste e provoque **cada estado** (alerta, aviso, sem dados, recuperação), conferindo o resultado e os pontos ⚠ de 06 e 07. Para o Datadog, valide também: silenciar e reativar com um monitor de teste e chaves de homologação, e uma reconciliação em simulação lendo os cabeçalhos de limite.

## Simulador (opcional)

Se quiserem um teste de carga/regressão, o simulador original era uma aplicação separada, sem dependências, que só usava a API HTTP: gerava ~32 aplicações e 200 monitores de forma determinística (semente); enviava ~1500 eventos em rodadas concorrentes (incluindo duplicados simultâneos, fora de ordem, segredo errado e JSON malformado); expunha um receptor de remediação e um **Datadog simulado** (`mute`/`unmute`/listagem paginada com `overall_state`, chaves, prazo, erros 403 e 429 com cabeçalhos de limite); e ao final comparava o estado de cada alerta, a trilha de auditoria, a saúde das aplicações/jornadas e as chamadas de remediação com um **oráculo independente**. O que ele já provou útil: expor, sob carga, que um destino de remediação que não resolve DNS esgotava as threads e o pool do banco (daí o limite de concorrência de 4).
