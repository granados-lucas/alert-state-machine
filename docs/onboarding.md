# Preparação local

## Pré-requisitos

- Node.js 24 (validado com 24.22.0; `@types/node` na linha 24) e pnpm 12 (`packageManager` em `package.json`).
- No Windows, o Node aqui é gerenciado por `fnm`. Se `node` não aparecer no PATH, rode `fnm env --shell power-shell | Out-String | Invoke-Expression` na sessão.
- Docker (Compose v2) para a stack completa; ou PostgreSQL local/autorizado para rodar fora do Docker.
- Para Claude Code: plugins Ponytail, Caveman, Superpowers e Context7 já instalados no usuário; ver `docs/setup.md`.

## Com Docker (recomendado)

```bash
docker compose up --build        # db + migrate + app em http://localhost:3000
docker compose --profile simulator up --build --abort-on-container-exit --exit-code-from simulator simulator
docker compose down -v           # apaga os dados
```

Os segredos padrão do `compose.yaml` são só para desenvolvimento local (portas em `127.0.0.1`); defina os seus em `.env` (veja `.env.docker.example`). A aplicação **não tem login**: o SSO corporativo fica na frente e preenche o cabeçalho `AUTH_USER_HEADER` (padrão `x-forwarded-email`) com a identidade, usada na auditoria; sem ele a ação é registrada como `anonymous`. O webhook único usa `WEBHOOK_SECRET` (header `X-Webhook-Secret`). Para chamar remediações, o destino precisa estar em `REMEDIATION_ALLOWED_HOSTS`.

## Primeira execução sem Docker

```bash
pnpm install
pnpm dev          # http://localhost:3000
```

Variáveis (nomes em `.env.example`; valores só em `.env.local`, que é ignorado pelo Git): `DATABASE_URL`, opcional `DATABASE_URL_UNPOOLED` (preferida para migrações), `AUTH_USER_HEADER`, `WEBHOOK_SECRET`, `REMEDIATION_ALLOWED_HOSTS` e `LOG_LEVEL`. Nada disso é necessário para `pnpm check`. As páginas consultam o banco: `pnpm dev` exige PostgreSQL (use `docker compose up db migrate`, porta 5433 no host).

## Banco de dados

Aponte `DATABASE_URL` para o PostgreSQL do compose (`postgresql://alerts:alerts-dev-password@localhost:5433/alerts`) ou outro local/autorizado, rode `pnpm db:generate`, revise o SQL em `drizzle/` e aplique com `pnpm db:migrate` apenas no destino correto. Nunca use produção como ambiente de teste.

## Verificar

`pnpm check` roda lint, tipos, lint tipado, auto-verificação das regras, testes com cobertura, testes do simulador e build, sem credenciais nem banco real. Resultado esperado: todos os passos com saída 0.

## Agentes

Leia [AGENTS.md](../AGENTS.md); [CLAUDE.md](../CLAUDE.md) importa o mesmo conteúdo. Skills e integrações configuradas estão em [setup.md](setup.md).

## Problemas conhecidos

- `pnpm audit` (completo) reporta 1 advisory moderado de desenvolvimento, `esbuild` via `drizzle-kit` (GHSA-67mh-4wv8-2f99). O caminho vem de uma dependência transitiva do `drizzle-kit` 0.31.11 (`@esbuild-kit/*`, já marcada como obsoleta); a versão corrigida do esbuild exigiria um override forçado, que não foi aplicado. O audit de produção não tem vulnerabilidades. Revisar ao atualizar o `drizzle-kit`.
- pnpm 12 bloqueia scripts de instalação por padrão; `esbuild`, `sharp` e `unrs-resolver` estão com `allowBuilds: false` em `pnpm-workspace.yaml`. Build, testes e geração de SQL funcionam assim.
