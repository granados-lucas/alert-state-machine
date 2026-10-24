# Global Alerts

Sistema interno que abstrai os Monitors do Datadog: cada alerta é uma máquina de estados alimentada por webhooks, independente do provedor, com mapa de jornadas (saúde por fluxo de negócio), histórico de auditoria e remediação automática. Escopo completo em [PRODUCT.md](PRODUCT.md).

## Subir tudo com Docker

```bash
docker compose up --build            # banco + migrações + aplicação em http://localhost:3000
```

Para validar com 32 aplicações e 200 alertas simulando o Datadog (aplicação separada em [simulator/](simulator/)):

```bash
docker compose --profile simulator up --build --abort-on-container-exit --exit-code-from simulator simulator
```

O simulador registra os alertas, envia webhooks no formato do Datadog (inclusive duplicados, fora de ordem, com segredo errado e malformados) e compara o resultado da aplicação com um oráculo próprio. Termina com código 0 se tudo bater. Abra http://localhost:3000 para ver o mapa. Para zerar os dados: `docker compose down -v`.

Para **acompanhar a interface com dados mudando sozinhos** (modo demonstração: poucos alertas degradam por vez e se recuperam sozinhos, ~0,6 mudança por segundo):

```bash
docker compose --profile demo up --build -d     # sobe tudo + o simulador contínuo
docker compose --profile demo stop demo         # pausa as mudanças
docker compose --profile demo down -v           # desliga e apaga os dados
```

As telas de mapa e alertas atualizam a cada 5 s (caixa "Atualizar" no topo); aplicações cujo estado mudou piscam por 3 s.

Os valores padrão do `compose.yaml` (senhas e tokens) são só para desenvolvimento local; as portas ficam ligadas a `127.0.0.1`. Por padrão a aplicação fala com o **Datadog simulado** do simulador (`DD_API_BASE_URL`); para o Datadog real, deixe `DD_API_BASE_URL` vazio e defina `DD_SITE`, `DD_API_KEY` e `DD_APP_KEY` em `.env`. Para outro ambiente, copie `.env.docker.example` para `.env` e defina segredos próprios.

## Desenvolvimento local

Requer Node 24 e pnpm.

```bash
pnpm install
pnpm dev          # precisa de DATABASE_URL (veja docs/onboarding.md)
pnpm check        # lint, tipos, regras, testes com cobertura, testes do simulador e build (sem banco real)
```

## Uso

| O quê | Onde |
|---|---|
| Mapa de jornadas: jornada e aplicações coloridas pelo pior estado dos alertas | `/` |
| Jornadas (detalhe, criar, editar) | `/journeys/[id]`, `/journeys/new`, `/journeys/[id]/edit` |
| Alertas, filtros e detalhe com remediações, execuções e auditoria | `/alerts`, `/alerts/[id]` |
| Criar alerta com remediação opcional | `/alerts/new` |
| Máquina de estados | `/graph` |
| Silenciar/reativar o monitor no Datadog | botão na página do alerta; `POST /api/alerts/[id]/mute` e `/unmute` ([detalhes](docs/integrations/datadog.md#silenciar-monitores-pela-api-ação-da-aplicação-no-datadog)) |
| Reconciliação com o Datadog (tela, API e script) | `/reconciliation`; `POST /api/reconciliation`; `scripts/reconcile.mjs` ([detalhes](docs/integrations/datadog.md#reconciliação-listar-monitores-e-respeitar-o-limite-de-uso)) |
| Webhook do Datadog | `POST /api/webhooks/datadog` ([como configurar](docs/integrations/datadog.md)) |
| API de gestão (sem token: a autenticação é do SSO na frente; identidade em `AUTH_USER_HEADER`) | `/api/alerts`, `/api/alerts/[id]`, `/api/alerts/[id]/remediations`, `/api/applications`, `/api/journeys`, `/api/journeys/[id]`, `/api/journeys/[id]/applications` |

## Documentação

- [Produto e escopo](PRODUCT.md)
- [Integração com o Datadog](docs/integrations/datadog.md)
- [Preparação local](docs/onboarding.md)
- [Estrutura e decisões técnicas](docs/architecture.md)
- [Design e acessibilidade](docs/design.md)
- [Verificações de qualidade](docs/quality.md)
- [Instruções para agentes](AGENTS.md)
- [Setup e evidências](docs/setup.md)

## Reconciliação periódica

A tela **Reconciliação** roda sob demanda. Para repetir sozinha, use o script (sem dependências, Node 18+), que chama a API da aplicação e espera o resultado:

```bash
node scripts/reconcile.mjs --url http://localhost:3000 --dry-run     # só simula
node scripts/reconcile.mjs --url http://localhost:3000               # uma execução
node scripts/reconcile.mjs --url http://app:3000 --every 300         # repete a cada 5 min
node scripts/reconcile.mjs --help
```

Códigos de saída (uma execução): `0` concluída, `1` falhou, `2` uso incorreto, `3` parcial, `4` aplicação inacessível, `5` já havia uma execução. Duas execuções nunca rodam ao mesmo tempo.

- **Docker Compose:** `docker compose --profile reconcile up -d reconciler` (intervalo em `RECONCILE_EVERY`, padrão 300 s).
- **cron:** `*/5 * * * * node /opt/app/scripts/reconcile.mjs --url http://app:3000`.
- **Kubernetes:** um `CronJob` (`schedule: "*/5 * * * *"`, `concurrencyPolicy: Forbid`) com a imagem `node:24-alpine` e o script montado de um ConfigMap, comando `node /job/reconcile.mjs --url http://app:3000`.
- O script se identifica no cabeçalho de identidade (`--identity`, padrão `reconciler@job`); em produção rode-o **dentro da rede**, sem passar pelo SSO.
