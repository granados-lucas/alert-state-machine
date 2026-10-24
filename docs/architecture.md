# Código e arquitetura

## Stack real

Next.js 16.4.3 (App Router, Turbopack), React 19.3.0, TypeScript 5.9 estrito, Tailwind 4.3, pnpm 12.11.2, Node 24. Persistência: Drizzle ORM 0.45 + PostgreSQL 17 (driver `pg` 8.23). Zod 4, Pino 10, `@xyflow/react` 12.12 (React Flow), Vitest 5. Versões exatas em `pnpm-lock.yaml`; evidências em `docs/setup.md`. Tudo roda em Docker (`compose.yaml`).

## Mapa do código

```text
src/
├── domain/
│   ├── alert-machine/        # estados, eventos, transition(), listEdges(): puro, sem I/O
│   ├── mute.ts               # regras do silêncio (prazo máximo, vigência)
│   └── application-status.ts # pior estado (aplicação e jornada), soma de contagens
├── providers/                # PORTA para ferramentas de monitoramento
│   ├── types.ts              # AlertProvider, NormalizedEvent
│   ├── index.ts              # registro (id → adaptador)
│   └── datadog/              # único lugar que conhece o Datadog: payload do webhook (index.ts) e API v1 de mute (api.ts)
├── server/                   # casos de uso; recebem o banco por parâmetro (Db)
│   ├── ingest.ts             # webhook → transação idempotente e serializada por alerta
│   ├── alerts.ts             # criar/atualizar/arquivar alerta, remediações (com auditoria)
│   ├── remediation.ts        # validação, allowlist, execução, limite de concorrência
│   ├── muting.ts             # silenciar/reativar monitor no provedor (com auditoria e sincronização de estado)
│   ├── journeys.ts           # criar/editar/trocar aplicações/remover jornada (com auditoria)
│   ├── queries.ts            # mapa de jornadas, listagem paginada, detalhes
│   └── http.ts, runtime.ts   # identidade do ator (cabeçalho do SSO), erros, `after()`
├── app/
│   ├── api/                  # webhooks/[provider], alerts, applications, health
│   └── páginas               # / (mapa de jornadas), /journeys/[id], /journeys/new, /alerts, /alerts/[id], /alerts/new, /applications/[name], /graph
├── components/               # journey-map (mapa), journey-form, alert-graph (máquina, React Flow), alert-form, ui
├── db/                       # schema (8 tabelas), pool pg
└── test/db.ts                # PGlite com as migrações reais, só para testes
drizzle/                      # 0000_init, 0001_audit_immutable (trigger), 0002_drop_dependencies, 0003_journeys, 0004_monitor_mute
simulator/                    # APLICAÇÃO SEPARADA que simula o Datadog (ver abaixo)
Dockerfile, compose.yaml
```

## Fluxo do webhook

```text
POST /api/webhooks/datadog
  → provider.authenticate (header X-Webhook-Secret, tempo constante)   401 se falhar
  → readJson (limite 64 KB)                                            413 / 400
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
- Erro de banco vira 500 (o Datadog reenvia, até 5 vezes). 4xx apenas quando reenviar não resolve.

## Dados

| Tabela | Papel |
|---|---|
| `applications` | A aplicação vem da tag `service:` do monitor |
| `journeys`, `journey_applications` | Jornada e sua relação N:N com aplicações (uma aplicação em várias jornadas). Definidas por tela/API, auditadas |
| `alerts` | Estado atual (`ok/warn/alert/no_data`), único por `(provider, external_id)`; `archived_at` em vez de exclusão |
| `webhook_events` | Todo evento recebido, com `outcome` e payload bruto (idempotência e prova) |
| `remediations`, `remediation_runs` | Configuração e execuções de remediação (webhook ou API) |
| `alerts.provider_state*` | Último `overall_state` bruto lido da API (ex.: `Skipped`) e quando |
| `alerts.muted_*` | Silêncio aplicado no provedor por esta aplicação (até quando, escopo, motivo, quem) |
| `audit_log` | Trilha **somente de inserção** (trigger bloqueia UPDATE/DELETE/TRUNCATE): criação, alterações com antes/depois, mudanças de estado, remediações, jornadas |

Chaves `bigint` por identidade, `timestamptz`, FKs indexadas, índice parcial `(application_id, state) WHERE archived_at IS NULL` para o mapa e paginação por cursor (`id` decrescente). Migrações: `pnpm db:generate`, revisão do SQL e `pnpm db:migrate`; no Docker o serviço `migrate` roda uma vez antes do app.

## Ações no provedor: silenciar monitor

`AlertProvider.control` (porta `MonitorControl`: `mute`/`unmute`) existe só quando há credenciais; o adaptador do Datadog usa `POST /api/v1/monitor/{id}/mute|unmute` (ver `docs/integrations/datadog.md`). Fluxo de `muteAlert`: validar (alerta existe, não arquivado, provedor suportado e configurado) → **chamar o provedor** → gravar `muted_*` no alerta + auditoria `monitor_muted` → aplicar o estado devolvido pelo provedor como evento sintético (`ingestEvent`, que também aciona remediações). Falha do provedor: auditoria `monitor_mute_failed`, nada muda, erro 502/404. Salvaguardas: prazo obrigatório (máx. 7 dias), motivo obrigatório, destino fixo `https://api.<site>` (lista fechada de sites), sem redirecionamento, timeout de 10 s, id do monitor numérico, chaves fora de logs/erros. Limitação: chamada ao provedor e gravação local não são atômicas; se a gravação falhar depois de o Datadog aceitar, o silêncio existe lá e não aqui (o erro é registrado no log).

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
- O webhook do Datadog (`/api/webhooks/*`) tem autenticação própria (`DATADOG_WEBHOOK_SECRET`) e deve ficar fora do SSO, já que quem chama é o Datadog.
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
| Status da aplicação e da jornada = pior estado (`alert > warn > no_data > ok`) | Pedido: 1 alerta em alert deixa a aplicação e a jornada vermelhas; jornada = pior das aplicações = pior de todos os alertas dela | Limiar percentual ou peso por prioridade, se jornadas grandes ficarem sempre vermelhas |
| Jornada ligada à **aplicação**, não ao alerta | Pedido: "uma aplicação pode fazer parte de mais de uma jornada" | Se um alerta precisar pertencer só a uma jornada: tabela `journey_alerts` |
| Mapa de jornadas em cartões, não em grafo | Sem arestas, o grafo vira só nós soltos; cartões agrupam melhor 30+ aplicações e são legíveis e acessíveis | Voltar ao React Flow se surgirem relações a desenhar |
| `dependencies_updated` continua no enum `audit_kind` | PostgreSQL não remove valores de enum; fica marcado como legado | — |
| Eventos antigos descartados (`stale`) | Entregas sem garantia de ordem | — |
| Silêncio = API v1 do monitor (como pedido), não Downtimes v2 | Pedido explícito; endpoint sem aviso de descontinuação | Se o Datadog descontinuar: trocar o adaptador por Downtimes v2 |
| Alerta silenciado continua contando na saúde | A saúde deve refletir a realidade; o silêncio é só um aviso visual | Se o negócio quiser excluir silenciados do cálculo |
| Auditoria única (`audit_log`) | Linha do tempo simples; trigger garante imutabilidade | Volume alto: particionar por mês |
| Remediação executada depois da resposta (`after()`) | O Datadog tem timeout de 15 s; remediação lenta não pode causar reenvio | Fila durável se perder execuções em queda do processo for inaceitável |
| PGlite nos testes + PostgreSQL real no Docker/simulador | Testes rápidos sem servidor; a concorrência real só aparece no PostgreSQL | — |
| React Flow só na máquina de estados | Escolha do solicitante para o grafo de estados | — |

## Manutenção

Atualizar este mapa quando diretórios, dependências, contratos ou fronteiras mudarem.
