# 02 — Regras de negócio

Este arquivo é a fonte da verdade do comportamento. Os pseudocódigos são a especificação; a linguagem é livre.

## 1. Máquina de estados

Estados: `ok`, `warn`, `alert`, `no_data`.
Eventos: `recovered` (→ ok), `warned` (→ warn), `triggered` (→ alert), `data_missing` (→ no_data).

```text
transicao(estado, evento):
  alvo = ALVO[evento]                      # recovered→ok, warned→warn, triggered→alert, data_missing→no_data
  se alvo != estado          → { tipo: "changed", de: estado, para: alvo }
  senão                      → { tipo: "unchanged" }   # repetir o estado atual não é transição
```

Qualquer estado alcança qualquer outro (premissa). Se um dia for preciso restringir transições, a restrição entra **na tabela de transições**, que é dado, e não em código espalhado. A tabela é a mesma que a tela da máquina de estados exibe.

Estado inicial de todo alerta novo: **`no_data`**.

## 2. Ingestão de um evento (webhook)

Entrada: um evento **normalizado** (a fonte já foi traduzida; ver 06 e 07):

```text
NormalizedEvent {
  provider        texto   (datadog | cloudwatch | appdynamics | generic)
  externalEventId texto   (chave de idempotência dentro da fonte)
  externalAlertId texto   (ID do monitor na fonte)
  alertName       texto
  application     texto   ("unassigned" se a fonte não informa)
  event           um dos eventos acima, ou nulo (sem efeito na máquina)
  occurredAt      data/hora
  priority        1..5 ou nulo
  tags            lista de textos
  link            url http(s) ou nulo
  raw             o payload original (guardado como prova)
}
```

Algoritmo, **tudo em uma única transação de banco**:

```text
1. Inserir em webhook_events (provider, externalEventId, outcome="ignored", occurredAt, payload).
   Se já existir (chave única provider+externalEventId) → responder 200 {status:"duplicate"} e parar.
2. Criar a aplicação se não existir (nome único).
3. Inserir o alerta (provider, externalAlertId) se não existir (estado no_data, prioridade/tags/link do evento).
   Se criou: gravar auditoria "alert_created" (origem "webhook").
4. Ler o alerta com trava de linha (SELECT ... FOR UPDATE). Isso serializa eventos concorrentes do mesmo alerta.
5. stale = alerta.lastEventAt existe E evento.occurredAt < alerta.lastEventAt
   resultado = (evento.event existe E não stale E alerta não arquivado) ? transicao(alerta.estado, evento.event) : nenhum
   outcome  = stale ? "stale"
            : resultado == changed ? "applied"
            : resultado == unchanged ? "unchanged"
            : "ignored"
6. Se NÃO stale e alerta NÃO arquivado: atualizar o alerta com
     estado (novo, se changed), stateChangedAt (agora, só se changed), lastEventAt = occurredAt,
     applicationId, name, priority, tags, link, updatedAt.
   Se a aplicação do evento é diferente da do alerta: auditoria "alert_updated" (antes/depois do applicationId).
7. Se changed: auditoria "state_changed" (de, para, evento, occurredAt, ligada ao webhook_events.id).
8. Atualizar webhook_events com o outcome e o alertId.
9. Se changed: buscar as remediações ATIVAS do alerta cujo triggerStates contém o novo estado.
   Elas são executadas DEPOIS do commit e depois da resposta (ver 5).
```

Resposta: `200 {status: <outcome>, alertId, state}`. Duplicata: `200 {status:"duplicate"}`.

Pontos importantes:
- A ordem é pelo **horário do evento na fonte** (`occurredAt`), não pelo recebimento. Entregas fora de ordem são esperadas. Igualdade (`occurredAt == lastEventAt`) **não** é stale.
- Evento de alerta **arquivado** é gravado (outcome `ignored`), mas não altera nada.
- Cada evento não stale atualiza nome, prioridade, tags, link e aplicação do alerta com o que a fonte enviou (a fonte é a verdade dos metadados).
- Evento com `event = nulo` (ex.: renotificação sem estado) atualiza metadados e `lastEventAt`, mas o outcome é `ignored`.

## 3. Prioridade e saúde (o peso do alerta)

A prioridade P1..P5 (1 = mais alta) é o **peso** do alerta. Pesos exponenciais: um P1 pesa mais que vários P5 juntos.

| Prioridade | P1 | P2 | P3 | P4 | P5 | sem prioridade |
|---|---|---|---|---|---|---|
| Peso | 16 | 8 | 4 | 2 | 1 | conta como **P3** (4) |

Cada aplicação e cada jornada tem dois resultados, calculados dos alertas **ativos** (não arquivados):

**Cor (`status`)** = o pior estado, com **rebaixamento**: um alerta em `alert` só conta como `alert` se a prioridade (ou P3 se não houver) for ≤ 3. P4 e P5 em `alert` contam como `warn`. Gravidade para escolher o pior: `ok(0) < no_data(1) < warn(2) < alert(3)`. Sem alertas: cor nula (neutra).

**Índice (`health`, 0 a 100)** = `arredondar( 100 × (1 − Σ peso·desconto·n ÷ Σ peso·n) )`, onde o desconto depende do estado **real** (sem rebaixar):

| Estado | ok | no_data | warn | alert |
|---|---|---|---|---|
| Desconto | 0 | 0,25 | 0,5 | 1 |

Sem alertas: índice nulo.

**Rebaixados (`downgraded`)** = quantidade de alertas em `alert` que não deixaram vermelho por serem P4/P5. A tela mostra "(N de baixa prioridade)".

Agrupamento: os cálculos usam **grupos** `{estado, prioridade, quantidade}`. A jornada **soma os grupos** das aplicações dela (não faz média de médias) e aplica a mesma regra.

Exemplos para conferir a implementação:

| Alertas | Resultado |
|---|---|
| ok P1 + alert P5 | cor `warn`, índice 94 (rebaixado: 1) |
| alert P1 + ok P5 | cor `alert`, índice 6 |
| no_data P2 × 2 | cor `no_data`, índice 75 |
| warn sem prioridade × 1 | cor `warn`, índice 50 |
| só ok | cor `ok`, índice 100 |
| nenhum | cor nula, índice nulo |

Ordenação do mapa: pior cor primeiro (alert > warn > no_data > ok > nula), depois menor índice, depois nome.

## 4. Silenciar monitor na fonte (só Datadog)

Regras de entrada: prazo **obrigatório** de 1 a 10080 minutos (7 dias); motivo **obrigatório** (3 a 300 caracteres); escopo opcional (até 200). Reativar: motivo opcional; `allScopes` (padrão falso) limpa todos os escopos. Alerta arquivado não pode ser silenciado. A fonte precisa suportar a ação e estar configurada (senão 501 / 503).

Não existe transação entre a fonte e o banco. O desenho garante que a divergência **nunca fica silenciosa**:

```text
execute(alerta, pedido):
  1. [transação, trava o alerta] Se existe operação "pending" do alerta:
        - criada há menos de 60 s → erro 409 (outra requisição está em andamento)
        - mais antiga → concluir primeiro essa operação (passo "recuperar" abaixo), depois seguir
     Gravar a INTENÇÃO em mute_operations (status "pending", ator, motivo, prazo, escopo...).
     (índice único parcial: no máximo 1 pendente por alerta)
  2. Chamar a fonte (mute ou unmute). Falhou → [transação] operação "failed" + auditoria "monitor_mute_failed";
     o alerta não muda; repassar o erro.
  3. [UMA transação] gravar no alerta (mutedUntil, mutedScope, muteReason, mutedBy, mutedAt, e o estado bruto lido)
     + operação "succeeded" + auditoria "monitor_muted"/"monitor_unmuted".
     Só fecha a operação quem consegue marcar "pending"→"succeeded"/"failed" (UPDATE ... WHERE status='pending');
     duas recuperações concorrentes não duplicam gravação nem auditoria.
  4. Aplicar o estado devolvido pela fonte como um evento sintético (mesma ingestão do webhook), pois durante um
     silêncio a fonte não envia webhooks e o estado local pode estar atrasado.

recuperar(operação pendente): repetir a chamada à fonte com os mesmos parâmetros (assume-se idempotente ⚠),
     gravar como no passo 3 com recovered=true. Silêncio cujo prazo já passou NÃO é repetido: fecha como "failed".
recuperarTodas(): repete as pendentes criadas há mais de 60 s. Chamada a cada reconciliação e pela rota
     POST /api/mute-operations/recover.
```

O silêncio vale até `mutedUntil` (a fonte o encerra sozinha). "Silenciado agora" = `mutedUntil` no futuro.

## 5. Remediação

Uma remediação pertence a um alerta e define: nome, tipo (`webhook` ou `api`), URL, método, cabeçalhos, modelo de corpo, estados que disparam (padrão `alert`), timeout (100 a 15000 ms, padrão 5000) e se está ativa.

- **Tipo `webhook`**: sempre `POST` com o payload padrão `{ source:"global-alerts", alert:{id,name,application,state,previous_state,priority,tags,link}, firedAt }`.
- **Tipo `api`**: método, cabeçalhos e corpo próprios. O corpo é um modelo com `{{alert.id}}`, `{{alert.name}}`, `{{alert.application}}`, `{{alert.state}}`, `{{alert.previous_state}}`, `{{alert.priority}}`, `{{alert.link}}`, `{{alert.tags}}` (tags separadas por vírgula). Os valores são **escapados para JSON** (o autor do modelo escreve as aspas).
- Corpo só em métodos que aceitam (não em GET/DELETE).

Segurança (obrigatória; é uma chamada de saída configurada por usuários):

- **Lista de destinos permitidos** (`REMEDIATION_ALLOWED_HOSTS`, host ou host:porta, minúsculas). **Vazia = nenhuma chamada sai**. Destino fora da lista: execução registrada como `skipped`.
- URL só `http`/`https`, **sem usuário/senha na URL**.
- **Segredos nunca no banco**: cabeçalho cujo nome casa `authorization|token|secret|key|cookie|password` só aceita referência `env:NOME` (maiúsculas, dígitos e `_`); o valor real é lido do ambiente na hora da chamada. Variável ausente = falha da execução.
- Não seguir redirecionamentos; timeout por chamada; resposta lida só pelo status (corpo descartado).
- Mensagens de erro registram só o tipo (`timeout`, nome do erro), nunca a URL ou credenciais.
- **Concorrência limitada**: no máximo 4 chamadas em andamento e 500 na fila; além disso a execução é registrada como `skipped` ("remediation queue full"). Sem isso, um destino lento esgota as conexões do processo e derruba o acesso ao banco.
- Uma tentativa por disparo, sem retry automático.
- Cada execução grava `remediation_runs` (status `success`/`failed`/`skipped`, status HTTP, duração, erro) e auditoria `remediation_run`.
- Executam **depois** do commit da ingestão e depois da resposta ao webhook (a resposta não espera o destino).
- Sucesso = HTTP 2xx.

## 6. Jornadas e aplicações

- Aplicação: nome único (até 100 caracteres). Criada automaticamente por eventos ou ao ser citada em uma jornada.
- Jornada: nome único (até 100), descrição opcional (até 500), conjunto de aplicações (até 200). Criar uma jornada com aplicações ainda desconhecidas cria as aplicações.
- Trocar as aplicações de uma jornada **substitui o conjunto** e audita antes/depois.
- Remover uma jornada **não remove** aplicações nem alertas.
- "Aplicações sem jornada" (`unassigned`) = aplicações que não estão em nenhuma jornada.

## 7. Alertas

- Cadastro manual: fonte (padrão `datadog`), ID externo (até 200), nome (até 200), aplicação (até 100), prioridade 1–5 ou nula, tags (até 50, 200 caracteres cada), link http(s), até 10 remediações. Se o par (fonte, ID) já existe: **409**.
- Atualizar: nome, prioridade, tags, link, `archived`. Auditoria com antes/depois só do que mudou. Sem mudança, nada é gravado.
- **Excluir = arquivar** (`archivedAt`). Arquivado sai das listagens, do mapa e das contas de saúde; o histórico permanece. Arquivar de novo/restaurar é por `archived: false`.

## 8. Auditoria

Toda mutação grava uma linha em `audit_log` **na mesma transação** da mutação, com ator. A tabela é **somente de inserção**: um gatilho do banco impede UPDATE, DELETE e TRUNCATE (ver 04). Ator: a identidade do SSO; eventos de fonte usam `system:<fonte>`; remediações `system:remediation`; reconciliação `system:reconciliation`; sem identidade: `anonymous`.

Tipos de auditoria: `alert_created`, `alert_updated`, `alert_archived`, `state_changed`, `remediation_created`, `remediation_updated`, `remediation_run`, `journey_created`, `journey_updated`, `journey_applications_updated`, `journey_deleted`, `monitor_muted`, `monitor_unmuted`, `monitor_mute_failed`, `reconciliation_run` (mais `dependencies_updated`, legado: existe só porque valores de enum do PostgreSQL não podem ser removidos; uma reconstrução nova pode omiti-lo).

Tipos de auditoria das combinações (seção 10): `combination_created`, `combination_updated`, `combination_archived`, `combination_state_changed`, `combination_automation_created`, `combination_automation_updated`, `combination_automation_run`.

## 9. Reconciliação (só Datadog)

Objetivo: corrigir divergências causadas por webhook perdido, monitor silenciado ou alerta novo. Detalhes de API e limites em 06.

```text
iniciar(opções):  criar registro reconciliation_runs "running"; se já existe um "running" do provedor → 409.
                  Um "running" com mais de 30 min é considerado abandonado e marcado "failed".
executar:
  se não for simulação: recuperar silêncios pendentes primeiro.
  para cada página (até maxPages, dentro de um orçamento de 10 min):
     ler a página; 429 → esperar o reset do provedor (limitado a 120 s, até 5 tentativas), tentar de novo
     para cada monitor ainda não visto:
        alerta arquivado → contar "archived", ignorar
        alerta desconhecido e createMissing=false → contar "skipped"
        estado do provedor sem equivalente (Skipped/Ignored) → manter (kept)
        estado equivalente já igual ao local → inSync
        simulação → contar o que mudaria (corrected/created)
        senão → ingerir um evento sintético (id "reconcile:<run>:<monitor>", occurredAt = instante da leitura,
                ator system:reconciliation) pela MESMA ingestão do webhook (idempotente, auditada, com remediações);
                resultado stale → contar "stale" (um webhook mais novo venceu)
     gravar o estado bruto lido (providerState/providerStateAt)
     se a página veio com menos itens que o tamanho de página → fim da listagem
  só se a listagem terminou E não houve filtro de tags: alertas ativos da fonte que não vieram = "missing" (só relatados)
  status final: succeeded | partial (limite de tempo/páginas) | failed (erro); gravar resumo, últimos cabeçalhos de limite e auditoria "reconciliation_run".
```

Opções: `dryRun` (padrão falso), `createMissing` (padrão verdadeiro), `remediate` (padrão verdadeiro), `tags` (até 10), `pageSize` (10–1000, padrão 100), `maxPages` (1–500, padrão 200).

## 10. Combinações de alertas

Uma **combinação** observa de **1 a 20 alertas existentes** (não arquivados, sem repetição) e tem estado próprio. Ela existe para juntar sinais (causa e consequência) e disparar uma automação mais precisa que a de cada alerta isolado. **Não entra** no cálculo de saúde nem no mapa de jornadas (evita contar o mesmo problema em dobro).

**Campos:** nome único (1–100), descrição opcional (≤500), regra, `minCount`, duração em segundos (0 a 86400, padrão 0), lista de alertas, arquivamento (`archivedAt`).

**Regras** (valores `and`, `or`, `at_least`). Seja `alertando` o número de componentes que contam e `total` o número de componentes (inclusive os que não contam):

| Regra | Vale quando |
|---|---|
| `and` (E) | `total ≥ 1` e `alertando = total` |
| `or` (OU) | `alertando ≥ 1` |
| `at_least` (pelo menos N) | `alertando ≥ minCount` (`minCount` entre 1 e o número de alertas; obrigatório só nesta regra e proibido nas outras) |

**Um componente conta como "alertando"** somente se o estado dele é `alert` **e** não está arquivado **e** não está silenciado (`mutedUntil` no futuro). `warn`, `no_data` e `ok` não contam. Com a regra E, um componente arquivado ou silenciado impede a combinação de valer.

**Estados:** `ok` (normal; estado inicial), `pending` (armando: a regra vale, mas a duração ainda não se cumpriu) e `alert`.

```text
passo(estado, valendoDesde, regraVale, duração, agora):
  se regra NÃO vale  → estado = ok,  valendoDesde = nulo           (de pending ou alert: houve mudança)
  se estado = alert  → nada muda
  início = (estado = pending ? valendoDesde : agora)
  se agora - início >= duração → estado = alert, valendoDesde = início   (duração 0: direto de ok para alert)
  senão                        → estado = pending, valendoDesde = início
```

A contagem da duração **zera** se a regra deixar de valer. Uma combinação de um único alerta com duração também passa por `pending`.

**Avaliação** (por combinação, numa transação que **trava a linha** da combinação; só atualiza se houver mudança):

1. lê os componentes e conta os que estão alertando;
2. aplica a regra e o passo acima;
3. se o estado mudou: grava estado, instante da mudança, `valendoDesde` e a auditoria `combination_state_changed` (`from`, `to`, ids dos componentes alertando, regra, N, duração); se só o `valendoDesde` mudou, grava só ele;
4. **depois do commit**, devolve as automações que devem rodar: ao entrar em `alert` (gatilho `alert`) ou ao voltar de `alert` para `ok` (gatilho `ok`). **`pending` nunca dispara**, e voltar de `pending` para `ok` também não (nunca houve alerta).

Duas avaliações ao mesmo tempo da mesma combinação geram **uma** transição, **uma** auditoria e **uma** automação.

**Quando avaliar:**

1. **Após cada evento que muda o estado de um alerta** (webhook, reconciliação e sincronização do silêncio), as combinações que contêm aquele alerta, depois do commit do evento. Se a avaliação falhar, o evento continua válido (não devolva erro à fonte, que reenviaria um duplicado); registre a falha numa métrica.
2. **Por um avaliador periódico** (a cada ~30 s) que reavalia **todas** as combinações não arquivadas. Sem ele, a duração nunca completa sozinha e o fim de um silêncio não é percebido. O atraso aceito é de até ~30 s além da duração.
3. Ao **criar** e ao **editar** uma combinação (a regra pode já valer).

Arquivar um alerta não dispara avaliação própria; o ciclo periódico cobre.

**Automação da combinação:** mesmo cadastro e mesma segurança da remediação (seção 5): `webhook` ou `api`, URL, método, cabeçalhos (`env:NOME` para segredos), modelo de corpo, timeout 100–15000 ms, ativa/inativa, lista de destinos permitidos, limite de concorrência. Diferenças: pertence a uma combinação e os gatilhos são só `alert` e `ok` (pelo menos um). Pode ser **criada, editada (qualquer campo) e desativada** depois. Payload padrão do tipo `webhook`:

```json
{ "source": "global-alerts",
  "combination": { "id": 7, "name": "Checkout fora", "state": "alert", "previous_state": "pending",
                   "rule": "and", "min_count": null, "duration_seconds": 120, "since": "2026-11-06T10:00:00.000Z",
                   "components": [ { "id": 12, "name": "Conversão A→B", "application": "checkout", "state": "alert",
                                     "since": "2026-11-06T09:58:10.000Z", "priority": 2 } ] },
  "firedAt": "2026-11-06T10:02:05.000Z" }
```

`since` da combinação = `valendoDesde` (ou o instante da última mudança); `since` de cada componente = quando o alerta mudou de estado pela última vez. Variáveis do modelo de corpo (tipo `api`): `{{combination.id}}`, `{{combination.name}}`, `{{combination.state}}`, `{{combination.previous_state}}`, `{{combination.rule}}`, `{{combination.components}}` (nomes separados por vírgula), escapadas para JSON. Cada execução grava um registro (`success`/`failed`/`skipped`, HTTP, duração, erro) e a auditoria `combination_automation_run` (ator `system:combination`).

**Validações de cadastro:** nome repetido → conflito (409); alerta inexistente ou arquivado → 400; mais de 20 alertas ou repetidos → 400; `at_least` sem N, N maior que o número de alertas, ou N nas outras regras → 400. Na edição a regra é validada sobre o **resultado** (lista de alertas nova + N + regra): trocar `at_least` por E exige limpar o N no mesmo pedido. Sem mudança real nada é gravado. **Arquivar** tira a combinação das listagens e da avaliação, mantém o histórico (e pode ser desfeito).

**Heartbeat:** a cada ciclo do avaliador periódico grava-se o instante numa tabela de **uma linha** (vale entre instâncias e reinícios); as métricas (10) e a tela de status usam esse valor.

**Auditoria:** `combination_created`, `combination_updated` (`changes` antes/depois, inclusive a lista de alertas), `combination_archived`, `combination_state_changed`, `combination_automation_created`, `combination_automation_updated` (`changes`; de cabeçalhos só os nomes), `combination_automation_run`.
