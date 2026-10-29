# 09 — Configuração e implantação

## Variáveis de ambiente

Valores **só** no ambiente de execução ou em um arquivo local ignorado pelo controle de versão. Nunca no código, em imagens ou em logs. Nenhuma variável é pública para o navegador.

| Variável | Obrigatória | Padrão | Descrição |
|---|---|---|---|
| `DATABASE_URL` | sim | — | `postgresql://usuario:senha@host:porta/banco` (esquemas `postgres:` ou `postgresql:`) |
| `WEBHOOK_SECRET` | para receber eventos | — | Segredo do **webhook único**, ≥ 16 caracteres, para qualquer ferramenta. Sem ele o webhook responde 401 a tudo. Se for usar CloudWatch (vai numa URL): só letras, números, `-` e `_` |
| `AUTH_USER_HEADER` | recomendada | `x-forwarded-email` | Cabeçalho que o SSO preenche com a identidade (auditoria). Nome de cabeçalho HTTP válido (`[A-Za-z0-9-]`, até 100) |
| `REMEDIATION_ALLOWED_HOSTS` | só com remediação | vazio | Destinos permitidos: `host` ou `host:porta`, separados por vírgula, minúsculas. **Vazio = nenhuma chamada de saída** |
| `LOG_LEVEL` | não | `info` | `trace`, `debug`, `info`, `warn`, `error`, `fatal` ou `silent` |
| `DD_API_KEY`, `DD_APP_KEY` | só para silenciar/reconciliar | — | Chaves da API do Datadog (8 a 200 caracteres). **As duas** precisam existir; sem elas o recurso fica desligado |
| `DD_SITE` | não | `datadoghq.com` | Um de: `datadoghq.com`, `us3.datadoghq.com`, `us5.datadoghq.com`, `datadoghq.eu`, `ap1.datadoghq.com`, `ap2.datadoghq.com`, `uk1.datadoghq.com`, `ddog-gov.com`, `us2.ddog-gov.com` |
| `DD_API_BASE_URL` | não | vazio | **Só para testes**: substitui o destino da API. Deve ficar **vazio** em uso real |
| `CLOUDWATCH_TOPIC_ARNS` | não | vazio | ARNs de tópico do SNS aceitos (separados por vírgula). Vazio = qualquer tópico que conheça o segredo |
| `<NOME>` referenciado por remediações | só com remediação | — | Cada cabeçalho sensível de uma remediação é `env:NOME`; o valor real é uma variável de ambiente `NOME` (maiúsculas, dígitos e `_`) |
| `PORT`, `HOSTNAME` | conforme a plataforma | 3000 / 0.0.0.0 | Onde o servidor escuta |
| `APP_VERSION` | não | `dev` | Versão mostrada no status e na métrica `build_info` |

Validação: toda variável é validada ao ser lida; erro mostra **só o nome** da variável, nunca o valor.

## Execução sem contêiner

Requisitos: runtime da aplicação (na versão original, Node 24) e um PostgreSQL acessível.

1. Instale as dependências (com o gerenciador da empresa: npm, pnpm ou outro).
2. Crie o banco e aplique o SQL do **04** (uma vez). Use um usuário com permissão de criar tipos, tabelas, funções e gatilhos.
3. Defina as variáveis acima.
4. Gere o build de produção e inicie o servidor. Na versão original (Next.js com saída `standalone`): `build` e depois `node server.js` com `PORT` e `HOSTNAME`.
5. Confira `GET /api/health/live` (200) e `GET /api/health` (200 = banco ok).

Migrações: **nunca** aplicar durante o build nem a cada requisição; aplique como etapa explícita da implantação, antes de subir a nova versão, e **revise o SQL**. Não use sincronização automática de esquema.

## Contêiner (opcional)

Se a empresa usa contêineres: uma imagem de build com a aplicação, uma etapa separada que aplica as migrações **uma vez** antes do app iniciar, e a aplicação com verificação de saúde em `/api/health`. Para a variável `UV_THREADPOOL_SIZE` (ou equivalente de pool de threads), a versão original usa 16, porque chamadas de saída lentas dividem threads com o driver do banco. O script de reconciliação periódica pode rodar como um segundo serviço/cron que só chama a API da aplicação.

## Rede e SSO (o ponto de segurança mais importante)

```text
usuário ──▶ SSO / proxy reverso da empresa ──▶ aplicação          (identidade no cabeçalho AUTH_USER_HEADER)
ferramenta de monitoramento ─────────────────▶ /api/webhooks      (FORA do SSO; segredo próprio)
coletor de métricas (Prometheus) ────────────▶ /api/metrics       (rede interna; sem login)
```

- A aplicação **não autentica usuários**. Ela só é segura **atrás do SSO**, e a rede deve impedir acesso direto (só o proxy do SSO alcança a porta da aplicação).
- O SSO deve **sobrescrever** o cabeçalho de identidade (nunca aceitar o que o cliente enviar) e deixar `/api/webhooks` **sem exigir login** (as ferramentas não fazem SSO).
- O Datadog e o SNS precisam **alcançar** `/api/webhooks` (internet pública ou uma rota permitida), sempre por **HTTPS**. O SNS não suporta endpoints privados.
- `/api/metrics` não deve ser público: exponha só ao coletor (ou libere no SSO e restrinja por rede).
- Se a empresa restringir por IP de origem, não use IP como autenticação (o segredo é a barreira).
- Troca de segredo: atualizar `WEBHOOK_SECRET` na aplicação **e** em todas as ferramentas; no CloudWatch, recriar a assinatura com a URL nova.

## Chamadas de saída (lista do que a aplicação pode acessar)

| Destino | Para quê | Controle |
|---|---|---|
| Hosts de remediação | Remediação | Lista `REMEDIATION_ALLOWED_HOSTS`; sem redirecionamento; timeout |
| `https://api.<DD_SITE>` | Silenciar e reconciliar | Sites fixos; sem redirecionamento; timeouts 10 s e 30 s |
| `https://sns.<região>.amazonaws.com` | Confirmar assinatura do SNS | Host validado; sem redirecionamento; 10 s |
| PostgreSQL | Dados | Pool pequeno |

Libere no firewall de saída só esses destinos.

## Operação

- **Backups** do PostgreSQL (a auditoria é a prova do que aconteceu).
- **Retenção** das tabelas de histórico (ver 04).
- **Concorrência**: mais de uma instância da aplicação é possível (travas de linha no banco), mas as tarefas "depois da resposta" rodam no processo que respondeu; contadores de métricas são por processo.
- **Reconciliação periódica** (opcional): agende o script a cada 5 minutos (`--every 300`) ou use um cron. Comece em modo simulação.
- **Upgrade de versão**: migrações revisadas e aplicadas antes; testes de aceite (11) depois.
