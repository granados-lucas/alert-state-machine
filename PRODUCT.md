# Global Alerts

## Problema e objetivo

Hoje os alertas da empresa vivem nos Monitors do Datadog. Isso acopla o processo de alertas a uma ferramenta que pode ser trocada. O Global Alerts modela cada alerta como uma **máquina de estados** estimulada por **webhooks**, de forma independente do provedor. Trocar o Datadog por outra ferramenta deve exigir apenas um novo adaptador de entrada, sem mudar estados, transições, auditoria, remediação ou visualização.

O comportamento é visível em **mapas**: o **mapa de jornadas** (a saúde do negócio: jornada e aplicações coloridas pelo pior estado dos alertas, ponderado pela prioridade deles) e o grafo da máquina de estados.

## Público e papéis

Sistema interno da empresa. Usuários: pessoas de engenharia/operação que acompanham alertas e quem cadastra alertas e remediações. Não há diferença de papéis confirmada (ver pendências sobre autenticação).

## Fluxos (implementados)

1. **Receber o webhook único** (`POST /api/webhooks`, um segredo para qualquer ferramenta; a fonte vem no campo `source`: Datadog, Amazon CloudWatch via SNS, AppDynamics ou genérica): autentica a origem, normaliza o payload, ignora duplicatas, descarta eventos antigos, aplica a transição, grava histórico e responde rápido.
2. **Mapa de jornadas** (`/`): uma **jornada** é um fluxo de negócio (ex.: "Compra") formado por várias aplicações; **uma aplicação pode fazer parte de mais de uma jornada**. Cada aplicação assume o pior estado entre seus alertas ativos e cada jornada assume o pior estado entre as aplicações dela: se um alerta de prioridade P1 a P3 (ou sem prioridade) de uma aplicação da jornada estiver em Alerta, a aplicação e a jornada ficam vermelhas, e a mesma aplicação aparece vermelha em todas as jornadas de que participa. **O peso do alerta é a sua prioridade**: um alerta de P4 ou P5 em Alerta deixa o item só âmbar (rebaixamento) e todo item exibe um **índice de saúde** de 0 a 100%, ponderado pela prioridade (P1 pesa mais que vários P5). Aplicações que ainda não estão em nenhuma jornada aparecem num grupo "Sem jornada" (nada some do mapa). Passar o cursor numa aplicação destaca a mesma aplicação nas outras jornadas. Há também a lista equivalente e o filtro "só jornadas com alerta ou aviso".
3. **Jornadas** (`/journeys/[id]`, `/journeys/new`, `/journeys/[id]/edit`, `/api/journeys`): criar, editar nome/descrição, trocar as aplicações e remover; o detalhe mostra as aplicações e os alertas da jornada, dos mais graves para os menos graves. Toda alteração é auditada.
4. **Alertas** (`/alerts`, `/alerts/[id]`): lista filtrável com paginação; detalhe com estado, remediações, execuções e a linha do tempo de auditoria.
5. **Criar alerta** (`/alerts/new`, `POST /api/alerts`): registra o monitor antes do primeiro webhook, com remediação opcional. Monitores desconhecidos também são descobertos automaticamente no primeiro evento.
6. **Remediação automática:** ao entrar em estados escolhidos (padrão: Alerta), o sistema aciona outra ferramenta por **webhook** (payload padrão) ou **API** (método, headers e corpo próprios), registra o resultado e audita.
7. **Silenciar monitor no Datadog** (`POST /api/alerts/{id}/mute|unmute`, botão na página do alerta): a aplicação chama a API do Datadog para silenciar (com prazo de 1 min a 7 dias e motivo obrigatórios, escopo opcional) ou reativar o monitor. O estado informado pelo Datadog na resposta é aplicado ao alerta; o silêncio fica visível ("Silenciado") e auditado, mas o alerta continua contando na saúde da jornada.
8. **Reconciliação com o Datadog** (`/reconciliation`, `POST /api/reconciliation`, `scripts/reconcile.mjs`): compara o estado de cada alerta com o `overall_state` dos monitores no Datadog e corrige divergências (webhook perdido, monitor silenciado, estado inicial), cria alertas de monitores novos e aponta os que sumiram. Tem modo de simulação, respeita o limite de uso da API (cabeçalhos `X-RateLimit-*`, 429) e roda manualmente pela tela ou periodicamente pelo script.
9. **Auditoria:** todo evento recebido, mudança de estado, criação/alteração/arquivamento de alerta, mudança de remediação, execução de remediação e mudanças em jornadas ficam em uma trilha só de inserção.
10. **Máquina de estados** (`/graph`): estados e transições permitidas.

## Fora do escopo

- Criar, editar ou excluir monitores no Datadog (o cadastro daqui não cria o monitor lá). Único acesso de escrita ao Datadog: silenciar e reativar.
- Notificações (e-mail, Slack, pager) e escalonamento.
- Reconhecer alertas (acknowledge) e agendar silêncios futuros ou recorrentes (Downtimes v2).
- Silenciar e reconciliar fora do Datadog: as outras fontes (CloudWatch, AppDynamics, genérica) só enviam eventos por webhook, e a verificação da assinatura das mensagens do SNS não existe (ver `docs/integrations/`).
- Dependências entre aplicações (substituídas por jornadas, decisão do solicitante em 2026-10-24).
- Jornada por alerta: a jornada é definida por aplicação; um alerta pertence às jornadas da sua aplicação.

## Requisitos

- Interface em português do Brasil, desktop como prioridade.
- Webhooks autenticados por segredo; segredos fora do repositório, dos logs e do banco (remediações referenciam `env:NOME`).
- **Autenticação e autorização de usuários ficam fora da aplicação (SSO corporativo na frente).** A aplicação só lê a identidade do cabeçalho `AUTH_USER_HEADER` (padrão `x-forwarded-email`) para a auditoria; sem o cabeçalho, registra `anonymous`.
- Processamento idempotente, tolerante a ordem e a concorrência.
- Auditoria imutável.
- Acessibilidade: o mapa de jornadas e o grafo têm alternativa textual navegável por teclado; estado nunca só por cor.
- Tudo roda em Docker (`docker compose up`).
- Restrições declaradas pelo solicitante: nenhuma.

## Restrições e decisões técnicas

Ver `docs/architecture.md`. Resumo: Next.js (App Router) + TypeScript, PostgreSQL com Drizzle, React Flow só para a máquina de estados (o mapa de jornadas é um painel de cartões), máquina de estados em TypeScript puro, adaptadores de provedor em `src/providers`.

## Premissas e pendências

Premissas reversíveis (mudar exige ajuste pequeno e localizado):

- Estados: `ok`, `warn`, `alert`, `no_data`; qualquer estado alcança qualquer outro. Alerta novo nasce em `no_data`.
- A aplicação de um alerta é a tag `service:` do monitor (fallback `app:`/`application:`, senão `unassigned`).
- **Peso = prioridade do alerta** (decisão do solicitante, 2026-10-25). Pesos exponenciais P1=16, P2=8, P3=4, P4=2, P5=1; alerta sem prioridade conta como P3. **Cor** = pior estado (`alert > warn > no_data > ok`) com **rebaixamento**: `alert` de P4/P5 conta como `warn`. **Índice** = 100 × (1 − Σ peso×desconto ÷ Σ peso), com desconto ok 0, no_data 0,25, warn 0,5, alert 1. Os pesos e o limite P3 estão em `src/domain/application-status.ts`.
- As jornadas são definidas manualmente (tela ou API); o Datadog não informa jornadas.
- Uma tentativa de remediação por disparo, sem retry automático.

Pendências (decisão externa ou validação com ambiente real):

| Decisão | Impacto | Próximo passo |
|---|---|---|
| Valores reais de `$ALERT_TRANSITION` (Warn/No Data) e escape de JSON no payload do Datadog | Mapeamento de estados e perda de eventos com aspas no nome | Configurar o webhook num monitor de teste em cada estado (ver `docs/integrations/datadog.md`) |
| Chave do Datadog com `monitors_read` e frequência da reconciliação em produção | A reconciliação só foi testada contra o Datadog simulado; a cota real da conta é desconhecida | Rodar uma simulação (dry-run) e ler os cabeçalhos de limite na tela |
| Equivalência de `Unknown`, `Skipped` e `Ignored` do Datadog (hoje: `Unknown`→Sem dados; `Skipped` e `Ignored` mantêm o estado) e monitores multi-alerta por grupo | Fidelidade do estado | Confirmar com quem opera os monitores; tabela em `docs/integrations/datadog.md` |
| Chaves reais do Datadog (`monitors_write`) e validação do silêncio com um monitor de teste | O silêncio só foi testado contra o Datadog simulado | Criar chave de serviço e testar em homologação (ver `docs/integrations/datadog.md`) |
| Origem das jornadas (manual hoje) | Manter o mapa atualizado sem trabalho manual | Avaliar derivar de uma tag `journey:` nos monitores ou do Service Catalog do Datadog (não verificado) |
| SSO corporativo na frente da aplicação (provedor, cabeçalho de identidade, papéis) | **A aplicação não autentica nem autoriza nada** (decisão do MVP, 2026-10-24): todas as telas e a API de gestão confiam no SSO. Sem ele, qualquer pessoa que alcance o servidor pode silenciar monitores e cadastrar remediações | Colocar a aplicação atrás do SSO e configurar `AUTH_USER_HEADER`; avaliar papéis (leitura/operação) depois do MVP |
| Hospedagem, PostgreSQL gerenciado, segredos e HTTPS | Deploy | Definir destino autorizado |
| Retenção/volume de `webhook_events` e `audit_log` | Crescimento do banco | Definir política (ex.: particionar por mês) |

## Critérios de aceitação

- Um webhook válido atualiza o estado do alerta e cria exatamente uma transição auditada; reenviado, não cria outra.
- Webhook com segredo errado é rejeitado (401) e não altera dados; payload malformado, 400.
- Evento mais antigo que o último aplicado não altera o estado.
- A aplicação aparece vermelha no mapa quando ao menos um alerta ativo dela de prioridade P1 a P3 (ou sem prioridade) está em Alerta, e toda jornada que contém essa aplicação também; um alerta de P4/P5 em Alerta deixa só âmbar. O índice de saúde reflete os pesos.
- Uma aplicação em duas jornadas aparece nas duas; trocar as aplicações de uma jornada muda a saúde dela imediatamente e fica na auditoria.
- Remediação configurada é acionada uma vez por entrada no estado escolhido; destino fora da allowlist é pulado e registrado.
- Silenciar um monitor chama o Datadog com o prazo pedido, grava ator e motivo na auditoria e mostra "Silenciado"; se o Datadog recusar, nada muda e a falha é auditada.
- Toda criação/alteração de alerta, remediação, jornada e silêncio aparece na auditoria com ator e antes/depois; a auditoria não aceita UPDATE/DELETE.
- O simulador (32 aplicações, 200 alertas, 1500 eventos) termina com código 0 contra a stack Docker.

## Próxima entrega

Validar webhook, silêncio e reconciliação com um monitor real do Datadog em ambiente de teste (transições, escape de JSON, base de `page`, cota de `GET /api/v1/monitor`) e confirmar com a operação a equivalência de `Unknown`, `Skipped` e `Ignored`. Depois, agendar a reconciliação em produção (`scripts/reconcile.mjs --every 300`).

## Manutenção

Atualizar este documento quando objetivo, escopo, restrições ou critérios mudarem. Detalhes técnicos em `docs/architecture.md`; evidências em `docs/setup.md`.
