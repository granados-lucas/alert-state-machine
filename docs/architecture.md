# Código e arquitetura

## Stack real

Next.js 16.4.3 (App Router, Turbopack), React 19.3.0, TypeScript 5.9 estrito, Tailwind 4.3, pnpm 12.11.2, Node 24. Persistência: Drizzle ORM 0.45 + PostgreSQL 17 (driver `pg` 8.23). Zod 4, Pino 10, `@xyflow/react` 12.12 (React Flow), Vitest 5. Versões exatas em `pnpm-lock.yaml`; evidências em `docs/setup.md`. Tudo roda em Docker (`compose.yaml`).

## Mapa do código

```text
src/
├── domain/
│   ├── alert-machine/        # estados, eventos, transition(), listEdges(): puro, sem I/O
│   ├── mute.ts               # regras do silêncio (prazo máximo, vigência)
│   └── application-status.ts # saúde: cor (pior estado com rebaixamento por prioridade) e índice ponderado pelo peso = prioridade
├── providers/                # PORTA para ferramentas de monitoramento (uma pasta por fonte)
│   ├── types.ts              # AlertProvider, NormalizedEvent
│   ├── catalog.ts            # ids, rótulos e tabelas de equivalência de TODAS as fontes (dados estáticos, sem ambiente)
│   ├── index.ts              # registro: id → adaptador, com o segredo `<ID>_WEBHOOK_SECRET` de cada fonte
│   ├── auth.ts, common.ts    # autenticação (cabeçalho / Basic) e utilitários compartilhados dos adaptadores
│   ├── datadog/              # webhook (index.ts), mute (api.ts), listagem (source.ts), equivalência de estados (states.ts)
│   ├── cloudwatch/           # alarmes via assinatura HTTPS do SNS (com confirmação da assinatura)
│   ├── appdynamics/          # ação de requisição HTTP de políticas
│   └── generic/              # JSON canônico para qualquer outra fonte
├── server/                   # casos de uso; recebem o banco por parâmetro (Db)
│   ├── ingest.ts             # webhook → transação idempotente e serializada por alerta
│   ├── alerts.ts             # criar/atualizar/arquivar alerta, remediações (com auditoria)
│   ├── remediation.ts        # validação, allowlist, execução, limite de concorrência
│   ├── muting.ts             # silenciar/reativar monitor no provedor: intenção → provedor → resultado, com recuperação
│   ├── reconcile.ts          # reconciliação: lê os monitores do provedor e corrige divergências (respeita limite de uso)
│   ├── journeys.ts           # criar/editar/trocar aplicações/remover jornada (com auditoria)
│   ├── queries.ts            # mapa de jornadas, listagem paginada, detalhes
│   └── http.ts, runtime.ts   # identidade do ator (cabeçalho do SSO), erros, `after()`
├── app/
│   ├── api/                  # webhooks/[provider], alerts, applications, health
│   └── páginas               # / (mapa de jornadas), /journeys/[id], /journeys/new, /alerts, /alerts/[id], /alerts/new, /applications/[name], /graph
├── components/               # journey-map (mapa), journey-form, alert-graph (máquina, React Flow), alert-form, ui
├── db/                       # schema (8 tabelas), pool pg
└── test/db.ts                # PGlite com as migrações reais, só para testes
drizzle/                      # 0000_init, 0001_audit_immutable (trigger), 0002_drop_dependencies, 0003_journeys, 0004_monitor_mute, 0005_provider_state, 0006_reconciliation, 0007_mute_operations
simulator/                    # APLICAÇÃO SEPARADA que simula o Datadog (ver abaixo)
Dockerfile, compose.yaml
```

## Fluxo do webhook

```text
POST /api/webhooks/<fonte>      (datadog | cloudwatch | appdynamics | generic)
  → provider.authenticate (segredo da fonte, tempo constante)          401 se falhar
  → readJson (limite 64 KB)                                            413 / 400
  → provider.handshake (opcional: confirmação de assinatura do SNS)    200 "handshake"
  → provider.parse → NormalizedEvent                                   400 se inválido
  → ingestEvent (1 transação):
       INSERT webhook_events ON CONFLICT DO NOTHING   → duplicata: responde 200 "duplicate"
       upsert application; insert alert (descoberta automática); SELECT ... FOR UPDATE do alerta
       evento mais antigo que o último aplicado        → outcome "stale" (sem mudar o estado)
       transition(estado, evento) (domínio puro)       → applied | unchanged | ignored
       audit_log: alert_created / state_changed; atualiza webhook_events.outcome
  → responde 200 com {status, alertId, state}
  → depois da resposta (`after()`): runRemediations das remediações ativas que reagem ao novo estado
```

- **Idempotência** pela chave única `(provider, external_event_id)`; **ordem** pelo `last_updated` do provedor; **serialização** pelo `FOR UPDATE` do alerta.
- Erro de banco vira 500 (o Datadog reenvia, até 5 vezes; o SNS, conforme a política de entrega). 4xx apenas quando reenviar não resolve.

## Fontes de alertas (Datadog, CloudWatch, AppDynamics, genérica)

O domínio só conhece `NormalizedEvent`; cada fonte é um adaptador em `src/providers/<id>/` que **autentica**, **interpreta** o payload e **traduz** o estado dela para os estados daqui (a tabela de equivalência é dado, mostrado na tela **Máquina de estados**). Cada fonte tem endpoint (`/api/webhooks/<id>`) e segredo próprios (`<ID>_WEBHOOK_SECRET`): vazar o de uma não permite enviar eventos como outra. A identidade de um alerta é `(fonte, ID externo)`: o mesmo número em duas fontes são alertas diferentes. Estudos e riscos: `docs/integrations/<fonte>.md`. **Nenhum adaptador foi validado contra o sistema real.**

| Fonte | Autenticação | ID do alerta | Estados | Ações no provedor |
|---|---|---|---|---|
| Datadog | `X-Webhook-Secret` | número do monitor | `overall_state` e transição | silenciar, reconciliar |
| CloudWatch | Basic (segredo = senha) na URL do SNS | ARN do alarme | `OK`, `ALARM`, `INSUFFICIENT_DATA` | nenhuma |
| AppDynamics | `X-Webhook-Secret` | `aplicação/regra de saúde` | `eventType` da política | nenhuma |
| Genérica | `X-Webhook-Secret` | `monitor_id` | `state` já canônico | nenhuma |

**Adicionar uma fonte** (o domínio, a auditoria, as remediações e as telas não mudam):

1. `src/providers/<id>/index.ts`: `create<Id>Provider(options)` devolvendo `AlertProvider` (`authenticate`, `parse`; `handshake` só se o protocolo tiver mensagens que não são eventos; `control`/`source` só se houver API de escrita/leitura). Reaproveite `auth.ts` e `common.ts`.
2. `src/providers/<id>/states.ts`: tabela de equivalência (fonte → estado ou `null` = manter). Entradas inferidas devem dizer isso no `reason`.
3. `src/providers/catalog.ts`: acrescente o id em `PROVIDER_IDS` e uma entrada em `PROVIDERS` (rótulo, variável do segredo, autenticação, linhas e notas).
4. `src/providers/index.ts`: uma linha em `BUILDERS`. O segredo é lido de `<ID>_WEBHOOK_SECRET`.
5. Testes do adaptador (fixtures no formato documentado), `.env.example`, `compose.yaml`, uma fonte em `simulator/src/sources.mjs` e `docs/integrations/<id>.md` (o que foi lido, o que **não** foi verificado).

## Dados

| Tabela | Papel |
|---|---|
| `applications` | A aplicação vem da tag `service:` do monitor |
| `journeys`, `journey_applications` | Jornada e sua relação N:N com aplicações (uma aplicação em várias jornadas). Definidas por tela/API, auditadas |
| `alerts` | Estado atual (`ok/warn/alert/no_data`), único por `(provider, external_id)`; `archived_at` em vez de exclusão |
| `webhook_events` | Todo evento recebido, com `outcome` e payload bruto (idempotência e prova) |
| `remediations`, `remediation_runs` | Configuração e execuções de remediação (webhook ou API) |
| `reconciliation_runs` | Cada execução da reconciliação: opções, resumo, últimos cabeçalhos de limite, erro. Índice parcial garante no máximo uma `running` por provedor |
| `alerts.provider_state*` | Último `overall_state` bruto lido da API (ex.: `Skipped`) e quando |
| `alerts.muted_*` | Silêncio aplicado no provedor por esta aplicação (até quando, escopo, motivo, quem) |
| `mute_operations` | Intenção de silenciar/reativar gravada **antes** de chamar o provedor (`pending` → `succeeded`/`failed`, `recovered` se concluída por reexecução). Índice parcial: no máximo uma `pending` por alerta |
| `audit_log` | Trilha **somente de inserção** (trigger bloqueia UPDATE/DELETE/TRUNCATE): criação, alterações com antes/depois, mudanças de estado, remediações, jornadas |

Chaves `bigint` por identidade, `timestamptz`, FKs indexadas, índice parcial `(application_id, state) WHERE archived_at IS NULL` para o mapa e paginação por cursor (`id` decrescente). Migrações: `pnpm db:generate`, revisão do SQL e `pnpm db:migrate`; no Docker o serviço `migrate` roda uma vez antes do app.

## Ações no provedor: silenciar monitor

`AlertProvider.control` (porta `MonitorControl`: `mute`/`unmute`) existe só quando há credenciais; o adaptador do Datadog usa `POST /api/v1/monitor/{id}/mute|unmute` (ver `docs/integrations/datadog.md`). Salvaguardas: prazo obrigatório (máx. 7 dias), motivo obrigatório, destino fixo `https://api.<site>` (lista fechada de sites), sem redirecionamento, timeout de 10 s, id do monitor numérico, chaves fora de logs/erros.

**Consistência (silenciar atômico).** Não existe transação entre o Datadog e o PostgreSQL; o desenho garante que a divergência nunca fica silenciosa. Fluxo de `muteAlert`/`unmuteAlert`:

1. Valida (alerta existe, não arquivado, provedor suportado e configurado) e, **numa transação que trava o alerta**, grava a intenção em `mute_operations` (`pending`). Se já há uma pendente com menos de 60 s, responde 409; se é mais antiga, conclui-a antes (passo de recuperação abaixo).
2. Chama o provedor.
3. **Numa única transação**: grava `muted_*` no alerta, fecha a operação (`succeeded`) e audita `monitor_muted`/`monitor_unmuted`. Se o provedor recusa: fecha como `failed` e audita `monitor_mute_failed` (o alerta não muda). Depois, aplica o estado devolvido como evento sintético (`ingestEvent`, que também aciona remediações).

Se o processo cair entre 2 e 3, o Datadog já aplicou, mas a operação continua `pending`. A **recuperação** (`recoverMuteOperations`, chamada a cada reconciliação e por `POST /api/mute-operations/recover`; `GET /api/mute-operations` lista as pendentes) repete a chamada ao provedor e conclui a gravação (`recovered = true` na operação e na auditoria). Um silêncio pendente cujo prazo já passou não é repetido: fecha como `failed`. A tela do alerta avisa quando há uma operação pendente. Premissa **não verificada**: repetir `mute` com o mesmo `end` (e `unmute`) no Datadog é idempotente; o código foi escrito assim, mas isso não foi confirmado numa conta real. Dois processos recuperando a mesma operação ao mesmo tempo repetem a chamada ao provedor (inofensivo se a premissa valer), mas só quem fecha a operação (`UPDATE … WHERE status = 'pending'`) grava o resultado e a auditoria.

## Reconciliação

`POST /api/reconciliation` cria o registro (409 se já há uma execução) e responde **202**; a leitura roda em segundo plano (`after()`), acompanhada por `GET /api/reconciliation/{id}`. Cada monitor listado vira, quando difere do estado local, um evento sintético pelo mesmo `ingestEvent` do webhook (idempotente, auditado, com remediações), com o **instante da leitura** como horário: um webhook mais novo vence. Detalhes de paginação, limite de uso e do que é só relatado em `docs/integrations/datadog.md`. Limitação: o processamento é do processo (não há fila durável); se ele cair, a execução fica `running` até ser considerada abandonada (30 min).

## Remediação (segurança)

Um alerta pode acionar outra ferramenta ao entrar em estados escolhidos (padrão: `alert`): **webhook** (POST com payload padrão) ou **API** (método, headers e corpo com modelo `{{alert.name}}`, `{{alert.state}}`…). Como é uma chamada de saída configurada por usuários, há salvaguardas:

- **Allowlist** `REMEDIATION_ALLOWED_HOSTS`: vazia = nenhuma chamada. Não protege contra um host permitido que passe a resolver para IP interno (DNS rebinding); mantenha a lista curta e controlada.
- **Segredos nunca no banco:** headers sensíveis (`authorization`, `*token*`, `*key*`…) só aceitam `env:NOME`, resolvido em tempo de execução a partir do ambiente.
- Sem credenciais na URL, só http(s), `redirect: manual`, timeout de 100 ms a 15 s, corpo da resposta descartado (só o status), erros registrados sem a URL.
- No máximo 4 chamadas simultâneas e fila de 500: um destino lento ou com DNS quebrado não pode esgotar as threads do libuv nem o pool do banco (problema real encontrado pelo simulador; a imagem também define `UV_THREADPOOL_SIZE=16`).
- Uma tentativa por disparo (sem retry automático); a falha fica em `remediation_runs` e na auditoria.

## Identidade e autorização

**A aplicação não autentica nem autoriza usuários** (decisão do MVP): o SSO corporativo fica na frente e é ele que decide quem entra. A aplicação só lê a identidade do cabeçalho `AUTH_USER_HEADER` (padrão `x-forwarded-email`, `actorOf` em `src/server/http.ts`) e a grava como ator na auditoria; sem o cabeçalho, o ator é `anonymous`. Consequências que o deploy precisa respeitar:

- **A aplicação só pode ser alcançada através do SSO.** Quem a alcança diretamente escolhe o próprio nome (o cabeçalho é confiável por convenção) e pode fazer tudo: criar alertas e jornadas, cadastrar remediações (chamadas de saída, limitadas pela allowlist) e **silenciar monitores no Datadog**. No compose as portas ficam em `127.0.0.1`; em outro ambiente, restrinja a rede para que só o proxy do SSO chegue.
- O proxy deve **sobrescrever** o cabeçalho de identidade em toda requisição (nunca repassar o do cliente).
- Os webhooks (`/api/webhooks/*`) têm autenticação própria, um segredo por fonte (`DATADOG_WEBHOOK_SECRET`, `CLOUDWATCH_WEBHOOK_SECRET`, `APPDYNAMICS_WEBHOOK_SECRET`, `GENERIC_WEBHOOK_SECRET`), e devem ficar fora do SSO, já que quem chama são as ferramentas. A única chamada de saída que um webhook provoca é a confirmação da assinatura do SNS, restrita a `https://sns.<região>.amazonaws.com`.
- Sem papéis: todo usuário autenticado pode operar. Papéis (leitura/operação) ficam para depois do MVP.

## Simulador do Datadog (`simulator/`)

Aplicação separada (próprio `package.json` e Dockerfile, sem dependências, sem importar código da principal). Só usa a API HTTP: registra alertas e jornadas, envia webhooks no formato do Datadog, expõe um receptor de remediação e um **Datadog simulado** (`/api/v1/monitor/{id}/mute|unmute`, com chaves, prazo e `overall_state`; monitores silenciados não geram webhooks). Gera 32 aplicações, 200 alertas e 8 jornadas (com aplicações compartilhadas e 2 sem jornada) de forma determinística (semente); envia 1500 eventos em rodadas concorrentes, incluindo duplicados simultâneos, fora de ordem, com segredo errado e malformados. Ao final compara o estado de cada alerta, a trilha de auditoria, o status de cada aplicação e de cada jornada, a composição das jornadas e a contagem exata de chamadas de remediação com um oráculo independente. Também exercita o silêncio: 6 monitores silenciados (1 com escopo), estado que muda no Datadog sem webhook, 3 reativados com sincronização do estado, 3 mantidos silenciados e 1 recusado com 403.

## Decisões

| Decisão | Motivo | Revisitar quando |
|---|---|---|
| Máquina de estados como tabela TypeScript pura | Uma só fonte para lógica e grafo; fácil de testar | Estados hierárquicos/paralelos (XState) |
| Provedor por porta/adaptador | Requisito central: trocar o Datadog sem tocar no domínio | Novo provedor = novo adaptador |
| Equivalência de estados do Datadog em um módulo só (`providers/datadog/states.ts`) | Webhook, silêncio e reconciliação precisam concordar; a tela e os testes leem a mesma tabela | Se `Unknown` precisar ser distinto de `No Data`: novo estado `unknown` |
| Alerta nasce em `no_data` | "Sem informação" até o primeiro evento; evita inventar `ok` | Se o provedor informar o estado inicial por API |
| Aplicação = tag `service:` (fallback `app:`/`application:`, senão `unassigned`) | Convenção de *unified service tagging* do Datadog | Se a empresa usar outra tag |
| Peso do alerta = prioridade (P1=16, P2=8, P3=4, P4=2, P5=1; sem prioridade = P3). Cor da aplicação/jornada = pior estado com rebaixamento (`alert` de P4/P5 vira âmbar) e índice de saúde ponderado | Pedido do solicitante; evita jornadas grandes sempre vermelhas por causa de alertas de baixa prioridade sem esconder alertas importantes | Mudar a escala ou o limite (`MAX_RED_PRIORITY`) em `application-status.ts`; limiar percentual se ainda ficar ruidoso |
| Jornada ligada à **aplicação**, não ao alerta | Pedido: "uma aplicação pode fazer parte de mais de uma jornada" | Se um alerta precisar pertencer só a uma jornada: tabela `journey_alerts` |
| Mapa de jornadas em cartões, não em grafo | Sem arestas, o grafo vira só nós soltos; cartões agrupam melhor 30+ aplicações e são legíveis e acessíveis | Voltar ao React Flow se surgirem relações a desenhar |
| `dependencies_updated` continua no enum `audit_kind` | PostgreSQL não remove valores de enum; fica marcado como legado | — |
| Eventos antigos descartados (`stale`) | Entregas sem garantia de ordem | — |
| Silêncio = API v1 do monitor (como pedido), não Downtimes v2 | Pedido explícito; endpoint sem aviso de descontinuação | Se o Datadog descontinuar: trocar o adaptador por Downtimes v2 |
| Alerta silenciado continua contando na saúde | A saúde deve refletir a realidade; o silêncio é só um aviso visual | Se o negócio quiser excluir silenciados do cálculo |
| Reconciliação em segundo plano no processo da aplicação, disparada por tela/API/script | Simples e sem novo serviço; o script externo só chama a API | Fila durável/worker dedicado se as execuções ficarem longas ou o processo reiniciar com frequência |
| "Ausentes" só relatados, nunca arquivados | Uma listagem parcial ou um filtro errado não pode apagar alertas | Opção explícita de arquivar, com confirmação |
| Auditoria única (`audit_log`) | Linha do tempo simples; trigger garante imutabilidade | Volume alto: particionar por mês |
| Remediação executada depois da resposta (`after()`) | O Datadog tem timeout de 15 s; remediação lenta não pode causar reenvio | Fila durável se perder execuções em queda do processo for inaceitável |
| PGlite nos testes + PostgreSQL real no Docker/simulador | Testes rápidos sem servidor; a concorrência real só aparece no PostgreSQL | — |
| React Flow só na máquina de estados | Escolha do solicitante para o grafo de estados | — |

## Manutenção

Atualizar este mapa quando diretórios, dependências, contratos ou fronteiras mudarem.
