# Combinações de alertas — desenho

Rascunho para aprovação. Nada foi construído.

## Intenção

Um alerta sozinho diz pouco. Um alerta de comportamento de usuário (queda de conversão entre os pontos A e B) junto com um alerta de métrica da aplicação (por exemplo, latência alta) indica causa e consequência de uma indisponibilidade, e permite rodar uma automação específica para esse caso.

Uma **combinação** observa 1 ou mais alertas já existentes, avalia uma regra sobre os estados deles e tem **estado próprio**. A mudança de estado da combinação dispara uma **automação** (chamada ou webhook), no mesmo padrão da remediação do alerta comum.

## Objetivos

- Cadastrar combinações de 1 ou mais alertas, com uma regra e uma duração opcional.
- Regras: **E** (todos), **OU** (pelo menos um) e **PELO MENOS N**.
- Duração: a regra precisa ficar verdadeira por X minutos seguidos ("os 2 alertando por 2 minutos").
- Automação ao entrar em `alert` e/ou ao normalizar.
- Um **menu novo** com o mapa das combinações: quais estão alarmando, quais estão armando e quais estão normais.
- Auditoria e histórico, como nos alertas.

## Não objetivos e antiobjetivos

- **Não mexe na tela inicial, nas jornadas nem no índice de saúde.** Combinações não entram em nenhum cálculo de saúde (evita contar causa e consequência em dobro).
- Sem combinação de combinações.
- Sem regra "exatamente um" (decidido: UM DOS e QUALQUER UM saem; OU cobre o caso).
- Sem duração para a normalização (histerese). Uma combinação que oscila pode disparar a automação várias vezes; fica como limite conhecido.
- Não substitui a remediação do alerta comum.
- Antiobjetivo: a combinação nunca pode disparar por dado velho. Se a duração não puder ser medida (avaliador parado), isso precisa ficar visível, e não parecer "tudo normal".

## Decisões do usuário

| Tema | Decisão |
|---|---|
| Regras | E, OU, PELO MENOS N (N entre 1 e o número de componentes) |
| Duração | Regra verdadeira por X minutos seguidos; se deixar de ser verdadeira, a contagem zera |
| Alerta "alertando" | Somente `alert`. `warn`, `ok` e `no_data` não contam |
| Tela inicial | Não muda. Menu novo para o mapa das combinações |
| Automação | Na entrada em `alert` e/ou na normalização; mesmo padrão da remediação comum (chamada ou webhook) |
| Atraso | Aceito: até ~30 s além da duração configurada, com um segundo processo junto da aplicação |

## Decisões minhas (marcadas para conferência)

1. **Estados da combinação**: `ok`, `pendente` e `alert`. `pendente` = regra verdadeira, duração ainda não cumprida; aparece no mapa e não dispara nada. Duração 0 vai direto de `ok` para `alert`. Nasce `ok`.
2. **Componente silenciado** (`mutedUntil` no futuro) **não conta** como alertando. **Componente arquivado** também não conta, e a combinação é marcada como "com componente arquivado" (com E, ela não consegue mais disparar).
3. **Gatilhos da automação**: `alert` (entrada em `alert`) e `ok` (volta de `alert` para `ok`). `pendente` nunca dispara. Voltar de `pendente` para `ok` não dispara, porque nunca houve alerta.
4. **Nomes**: no menu "Combinações"; no código `combination` (tabelas `combinations`, `combination_alerts`, `combination_remediations`, `combination_remediation_runs`).
5. **Tabelas próprias de automação** em vez de tornar `remediations.alert_id` opcional: não toca o comportamento existente. Reaproveita a validação (`remediationInputSchema`), a lista de destinos, `env:NOME`, o limite de concorrência e a função de execução.
6. **Auditoria**: coluna nova `audit_log.combination_id` (nula) e tipos novos de auditoria (`combination_created`, `combination_updated`, `combination_archived`, `combination_state_changed`, `combination_remediation_*`). A auditoria continua só de inserção.
7. **Criação com a regra já verdadeira** avalia na hora (vai para `pendente` ou `alert` e pode disparar).
8. **Ao editar** regra, N, duração ou componentes: reavalia na hora com a regra nova e audita antes/depois.

## Como funciona

### Avaliação (função pura, mais um passo que lê o banco)

`regra(alertando, total, regra, n)`:

- E: `total ≥ 1` e `alertando = total`
- OU: `alertando ≥ 1`
- PELO MENOS N: `alertando ≥ n`

Um componente está `alertando` se `state = alert` e não está arquivado e não está silenciado. Transições:

| De | Condição | Para | Efeito |
|---|---|---|---|
| `ok` | regra verdadeira, duração 0 | `alert` | automação `alert` |
| `ok` | regra verdadeira, duração > 0 | `pendente` | guarda `satisfied_since` |
| `pendente` | regra falsa | `ok` | zera `satisfied_since` |
| `pendente` | `agora − satisfied_since ≥ duração` | `alert` | automação `alert` |
| `alert` | regra falsa | `ok` | automação `ok` |

### Quando avaliar

1. **Após cada mudança de estado de um alerta**: webhook, reconciliação e sincronização do silêncio (não só `ingestEvent`). Avalia as combinações que contêm aquele alerta.
2. **Por um avaliador periódico** (~30 s): reavalia todas as combinações não arquivadas. É ele que completa a duração sem evento novo e que percebe o fim de um silêncio.

A avaliação lê o estado atual do banco e é idempotente, então chamá-la a mais não faz mal.

### Concorrência

Cada avaliação roda numa transação que trava a linha da combinação (`FOR UPDATE`) e atualiza o estado só se ele ainda for o que foi lido. Dois avaliadores ao mesmo tempo (ou duas instâncias) geram uma única transição, uma única auditoria e uma única automação. A automação roda depois do commit, como hoje (`runAfterResponse`); se o processo cair nesse intervalo, a execução se perde, igual ao alerta comum (limite conhecido, documentado).

### Automação

Mesmo cadastro da remediação (nome, modo `webhook` ou `api`, URL, método, cabeçalhos com `env:NOME`, modelo de corpo, tempo limite, ativa/inativa), com `triggerStates` em `{alert, ok}`. Segurança inalterada: lista de destinos, sem credenciais na URL, sem redirecionamento, limite de concorrência, segredo só por `env:NOME`.

Payload padrão:

```json
{
  "source": "global-alerts",
  "combination": {
    "id": 7, "name": "Checkout fora", "state": "alert", "previous_state": "pending",
    "rule": "and", "min_count": null, "duration_seconds": 120, "since": "2026-11-06T10:00:00Z",
    "components": [
      { "id": 12, "name": "Conversão A→B", "application": "checkout", "state": "alert", "since": "...", "priority": 2 }
    ]
  },
  "firedAt": "2026-11-06T10:02:05Z"
}
```

Variáveis de modelo: `{{combination.id}}`, `.name`, `.state`, `.previous_state`, `.rule`, `.components` (nomes separados por vírgula).

### Modelo de dados (resumo)

- `combinations`: id, nome (único), descrição, `rule` (`and` | `or` | `at_least`), `min_count` (só com `at_least`; check), `duration_seconds` (0 a 86400), `state` (`ok` | `pending` | `alert`), `state_changed_at`, `satisfied_since`, `archived_at`, timestamps.
- `combination_alerts`: (combination_id, alert_id), 1 a 20 componentes por combinação.
- `combination_remediations` e `combination_remediation_runs`: espelham `remediations` e `remediation_runs`, com `combination_id`.
- Migração nova, gerada pelo Drizzle e revisada antes de aplicar (sem `db:push`).

### Interface (menu novo "Combinações", `/combinations`)

- **Mapa**: cartões agrupados por estado (`alert` primeiro, depois `pendente`, depois `ok`). Cada cartão mostra nome, regra em texto ("E · 2 min", "Pelo menos 2 de 3 · 5 min"), os componentes com o estado de cada um (destacando quem está alertando) e, em `pendente`, o tempo que falta. Combinações com componente arquivado ou silenciado ganham um aviso.
- **Detalhe**: regra, componentes, histórico de transições, automações e execuções.
- **Nova e editar**: escolher alertas existentes, regra, N, duração, descrição.
- Ao lado do mapa, um indicador "avaliador em dia / parado" (ver observabilidade).
- Segue `docs/design.md`; verificar com a skill `web-design-guidelines`, inclusive em 390 px.

### API (sem token, identidade do SSO na auditoria)

- `GET/POST /api/combinations`, `GET/PATCH/DELETE (arquivar) /api/combinations/[id]`
- `GET/POST /api/combinations/[id]/remediations`, `PATCH /api/combinations/[id]/remediations/[remediationId]`
- `POST /api/combinations/evaluate`: chamada pelo avaliador periódico; reavalia tudo, devolve um resumo e executa as automações depois da resposta.

### Avaliador periódico

`scripts/evaluate-combinations.mjs --every 30` (mesmo estilo do `scripts/reconcile.mjs`: só chama a API). No Docker, um serviço novo no `compose.yaml` que **sobe por padrão**, porque sem ele a duração nunca completa. Segurança contra duplicidade: as travas de linha acima.

### Observabilidade

- Medidas: `combinations{state}`, `combination_evaluator_last_run_timestamp_seconds`.
- Contadores: `combination_evaluations_total{result}`, `combination_transitions_total{to}`, e a remediação existente ganha o rótulo da origem (ou métrica própria; decisão do construtor).
- Alerta sugerido: `time() - global_alerts_combination_evaluator_last_run_timestamp_seconds > 120`. É o mais importante, porque um avaliador parado faz as combinações com duração nunca dispararem sem erro visível.
- Tela `/status` mostra o último ciclo do avaliador.

### Documentação e teste

- Atualizar: `PRODUCT.md`, `docs/architecture.md`, `docs/guia-de-uso.md`, `docs/observability.md`, `docs/setup.md`, `README.md`, a lista de `src/server/docs.ts` (se houver página nova), e a pasta `reconstrucao/` (04 banco, 05 API, 02 regras, 08 telas, 10 observabilidade, 11 cenários, 12 plano).
- Testes: regra pura (tabela de casos), avaliação com relógio injetado (`agora` por parâmetro), concorrência de avaliações (PGlite para a lógica; concorrência real no Docker), integração com ingestão, silêncio e reconciliação, API, automação (reuso dos testes de segurança da remediação).
- Simulador: um cenário com duas fontes (comportamental + métrica), fora e dentro da duração, e verificação no oráculo.

## O que fica para o construtor

- Nomes exatos de rotas, colunas e arquivos, seguindo as convenções do código (`src/server/combinations.ts`, `src/domain/combination-rule.ts`, etc.; arquivos ≤ 350 linhas).
- Se o contador de remediação ganha rótulo ou métrica separada.
- Cores e composição visual do cartão, dentro de `docs/design.md`.

## Riscos e limites conhecidos

- Se o avaliador periódico parar, combinações com duração ficam presas em `pendente`. Mitigação: métrica, alerta e indicador na tela.
- Sem histerese de saída: oscilação dispara a automação várias vezes.
- Automação "depois da resposta" pode se perder se o processo cair (mesmo comportamento do alerta comum).
- Estado do componente depende do que a ferramenta enviou; alerta sem evento recente fica no último estado (ver reconciliação). Não validado com as ferramentas reais, como o resto do sistema.
- O estado `warn` não conta. Se isso se mostrar restritivo, é uma opção futura, não desta versão.
