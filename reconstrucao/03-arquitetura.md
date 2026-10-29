# 03 — Arquitetura

## Camadas (a regra de dependência é o que importa)

```text
apresentação  (páginas, componentes, rotas HTTP)
      │ chama
casos de uso  (serviços: ingestão, alertas, remediação, silêncio, reconciliação, jornadas, consultas, telemetria)
      │ usa                         │ usa
domínio (puro, sem I/O)       adaptadores de fonte (um por ferramenta)
estados, transições, saúde,         autenticação do webhook, interpretação do payload,
regras do silêncio                  tradução de estado, chamadas à API da fonte
      │
banco (um único ponto de conexão)
```

Regras:

1. **Domínio puro**: máquina de estados, cálculo de saúde e regras do silêncio não conhecem banco, HTTP nem fontes. São testáveis sem nada ligado.
2. **Só o adaptador de uma fonte conhece o formato dela.** O resto do sistema só enxerga o `NormalizedEvent` (02, seção 2). Adicionar ou trocar uma ferramenta = escrever um adaptador.
3. **Serviços recebem o banco por parâmetro** (injeção de dependência). Isso permite testar com um banco em memória compatível ou com um PostgreSQL de teste.
4. **A apresentação não acessa o banco diretamente**: chama os serviços. Uma regra automática (lint) impede isso na versão original; reproduza essa disciplina.
5. **Um único ponto de conexão** ao banco (pool pequeno, criado sob demanda).
6. A tabela de estados e transições é **um dado único** consumido pela lógica e pela tela da máquina de estados. Não duplique.

## Módulos (nomes de referência)

| Módulo | Responsabilidade |
|---|---|
| `domain/alert-machine` | Estados, eventos, `transicao()`, lista de arestas (para a tela) |
| `domain/application-status` | Pesos, cor, índice de saúde, soma de grupos, ordenações |
| `domain/mute` | Limites do silêncio (1 min a 7 dias), `muteUntil()`, `isMuted()` |
| `providers/types` | Contrato `AlertProvider` e `NormalizedEvent` |
| `providers/catalog` | Lista de fontes, rótulos, tabelas de equivalência (dado estático), `sourceOf(corpo)` |
| `providers/auth` | Autenticação única do webhook (cabeçalho ou Basic) |
| `providers/<fonte>/` | Adaptador de cada fonte (ver 06 e 07) |
| `server/ingest` | Ingestão idempotente de um evento (02, seção 2) |
| `server/alerts`, `journeys`, `remediation` | Casos de uso com auditoria |
| `server/muting` | Silêncio atômico e recuperação (02, seção 4) |
| `server/reconcile` | Reconciliação (02, seção 9) |
| `server/queries` | Mapas, listagens, detalhes (somente leitura) |
| `server/telemetry` | Estado da própria aplicação lido do banco |
| `lib/metrics` | Registro mínimo de métricas em formato Prometheus |

### Contrato do adaptador de fonte

```text
AlertProvider {
  id
  parse(corpo) → NormalizedEvent        # lança erro de payload se inválido (vira 400)
  handshake?(corpo) → {message} | nulo  # mensagens de protocolo que não são eventos (confirmação do SNS)
  control?  { mute(idExterno, {ate, escopo?}), unmute(idExterno, {escopo?, todosEscopos?}) } → snapshot
  source?   { listMonitors({pagina, tamanho, tags?}) → {monitores[], limites} }
}
snapshot = { estadoBruto, evento | nulo }   # estado atual que a fonte informa, já traduzido para evento
```

`control` e `source` só existem quando há credenciais de API da fonte (hoje só Datadog).

## Fluxos

### Webhook (caminho crítico)

```text
POST /api/webhooks
  → autenticar (segredo)                                  401 se falhar
  → ler corpo (limite 64 KB)                              413 / 400 (JSON inválido)
  → identificar a fonte (campo "source", envelope SNS ou genérico)   400 "unknown source"
  → handshake (se a fonte tem e o corpo é de protocolo)   200 {status:"handshake"}
  → parse → NormalizedEvent                               400 "invalid payload"
  → ingestão (uma transação)                              200 {status, alertId, state} | 200 duplicate
  → DEPOIS DA RESPOSTA: executar remediações pendentes
```

- O Datadog reenvia em erro 5xx (até 5 vezes, timeout de 15 s) e o SNS em 5xx e 429. Por isso: responder **rápido**; 2xx para duplicatas; 4xx **só** quando reenviar não resolve (origem inválida, payload malformado); 5xx só em falha transitória (ex.: banco fora).
- O identificador de correlação (`X-Request-Id`, aceito se for simples: letras, números, `.`, `_`, `-`, até 64 caracteres; senão gera um UUID) vai em todos os logs da requisição e na resposta.

### Silêncio, reconciliação, remediação

Descritos em 02 (seções 4, 9 e 5). Pontos de arquitetura:

- A reconciliação **responde 202** ao ser pedida e roda em segundo plano (pode levar minutos por causa do limite de uso da fonte); o cliente acompanha por `GET /api/reconciliation/{id}`. Sem fila durável: se o processo cair, a execução fica "running" até ser considerada abandonada (30 min).
- Tarefas "depois da resposta" (remediação, reconciliação) rodam no mesmo processo. Em um ambiente onde o processo pode ser encerrado logo após responder (funções serverless), use uma fila/worker.

## Concorrência

- Dois eventos do mesmo alerta ao mesmo tempo: o segundo espera a trava de linha; a idempotência e o `lastEventAt` garantem resultado correto.
- Chamadas de saída (remediação) têm limite de concorrência (4 em andamento, 500 na fila): chamadas lentas ocupam recursos do processo que o driver do banco também usa. Se a sua plataforma tiver pool de threads/conexões compartilhado, aplique a mesma proteção.
- Concorrência real (duas instâncias da aplicação) deve ser testada contra PostgreSQL de verdade; bancos em memória não reproduzem travas de linha.

## Segurança

- **Sem login na aplicação.** O SSO da empresa fica na frente e preenche um cabeçalho (`AUTH_USER_HEADER`, padrão `x-forwarded-email`) com a identidade, usada na auditoria (até 100 caracteres; ausente = `anonymous`). **A aplicação só pode ser alcançada através do SSO.** Quem a alcançar direto escolhe o próprio nome e pode criar alertas, cadastrar remediações (chamadas de saída) e silenciar monitores. Restrinja a rede para que só o proxy do SSO chegue.
- **O webhook fica fora do SSO** (quem chama são as ferramentas) e tem autenticação própria: `WEBHOOK_SECRET`, comparado em tempo constante, mínimo 16 caracteres. Sem o segredo configurado, o webhook responde 401 a tudo.
- `/api/metrics` não tem login nem token; o acesso é decidido pela rede (coletor interno). Só tem agregados, sem segredos.
- **Segredos só em variáveis de ambiente.** Nunca no código, no banco, em logs ou na auditoria. Os logs removem campos sensíveis (`password`, `token`, `secret`, `authorization`, `cookie`, chaves de API).
- **Chamadas de saída restritas**: remediação (lista de hosts), API da fonte (sites fixos, sem redirecionamento, com timeout), confirmação de assinatura do SNS (só `https://sns.<região>.amazonaws.com`).
- **Entrada validada** em toda borda (rotas, variáveis de ambiente) com esquema declarativo; consultas parametrizadas; projeções explícitas de colunas; listagens sempre limitadas.
- Erros inesperados viram `500 {"error":"internal error"}` **sem detalhes**; o detalhe curto (nome do erro, código do banco) vai para o log.
- Anti-padrões a evitar: reintroduzir um token de administração compartilhado; guardar segredo de remediação no banco; seguir redirecionamentos em chamadas de saída.

## Decisões e alternativas

| Decisão | Motivo | Alternativa / quando rever |
|---|---|---|
| Um webhook e um segredo para todas as fontes, fonte no corpo | Simplicidade; trocar de ferramenta é mudar só o modelo de payload | Um segredo por fonte, se o risco de um segredo único não for aceitável |
| Estado do alerta guardado + auditoria como evento | Leitura rápida do mapa e trilha completa | Event sourcing completo, se for preciso reconstruir estado a qualquer instante |
| Idempotência por `(fonte, id do evento)` e ordem por horário da fonte | Entregas repetidas e fora de ordem são normais | — |
| Peso = prioridade, com rebaixamento P4/P5 | Jornadas grandes ficariam sempre vermelhas por alertas de baixa prioridade | Mudar a escala ou o limite do rebaixamento (são constantes no domínio) |
| Alerta silenciado continua contando na saúde | A saúde deve refletir a realidade | Excluir silenciados do cálculo, se o negócio preferir |
| Silêncio atômico por intenção + recuperação | Não há transação entre fonte e banco | Downtimes da fonte (agendamento), como evolução |
| Jornadas manuais | Nenhuma fonte informa jornadas | Derivar de uma tag `journey:` ou de um catálogo de serviços |
| Reconciliação em segundo plano sem fila durável | Simplicidade do MVP | Worker/fila se o ambiente matar o processo após a resposta |
| Auditoria somente de inserção por gatilho | Garantia no banco, não só no código | — |
| Mapa de jornadas como painel de cartões (a tela da máquina de estados é o único gráfico) | Legibilidade com muitas aplicações | — |
