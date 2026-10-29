# 08 — Telas

Descrição **funcional**: o que cada tela mostra, quais ações oferece e quais regras de interface valem. Layout, cores, tipografia e componentes ficam a cargo do **design system da empresa**. Idioma da interface na versão original: **português do Brasil**.

## Regras de interface comuns

- **Estados** são sempre mostrados por **texto e ícone, não só por cor**: `OK`, `Aviso`, `Alerta`, `Sem dados`. Cada estado tem uma cor semântica (verde/âmbar/vermelho/cinza no original), usada como reforço.
- **Acessibilidade**: tabelas com legenda e cabeçalhos de coluna com escopo; campos com rótulo; foco visível; erros anunciados (`role="alert"`) e mensagens de status (`role="status"`); respeitar a preferência de movimento reduzido; navegação por teclado; funcionar em tela de celular sem rolagem horizontal da página (tabelas largas rolam dentro do próprio quadro).
- **Atualização automática**: as telas operacionais (mapa, alertas, detalhe de jornada, reconciliação, status) têm uma opção "Atualizar a cada N s" (5 s nas telas de dados, 3 s com reconciliação em andamento, 15 s em repouso e no status). O usuário pode desligar.
- **Horários** em UTC, formato `AAAA-MM-DD HH:MM:SS UTC`.
- Aplicações cujo estado mudou desde a última leitura podem **piscar por alguns segundos** (opcional).
- **Silenciado**: alerta com `mutedUntil` no futuro mostra a etiqueta "Silenciado" (e continua contando na saúde).
- **Prioridade** exibida como `P1`..`P5`; ausente como "—" (ou "sem prioridade (conta como P3)" no detalhe).
- Nenhuma tela chama o banco diretamente: use os serviços (03).
- Telas sem dados mostram um estado vazio com o caminho para resolver ("Nada por aqui ainda… crie um alerta ou aguarde o primeiro webhook").
- Menu principal: Mapa de jornadas · Alertas · Novo alerta · Nova jornada · Reconciliação · Máquina de estados · Status · Documentação.

## Mapa de jornadas (`/`)

- Quatro indicadores: **Jornadas** (quantidade; "N aplicações · M sem jornada"), **Em alerta** (jornadas vermelhas), **Em aviso**, **Saudáveis** ("K sem dados").
- Painel principal: **uma jornada por cartão**, ordenadas pior primeiro. Cada cartão: nome, estado (cor), **índice de saúde em %**, "(N de baixa prioridade)" quando há rebaixados, e as **aplicações dela** como blocos coloridos pelo estado, com o índice no texto/dica. Clique em uma jornada → detalhe; em uma aplicação → detalhe da aplicação.
- Bloco **Aplicações sem jornada**: as aplicações que não estão em nenhuma jornada.
- Coluna **Mudanças recentes**: as últimas 8 mudanças de estado do sistema (aplicação, alerta, de → para, hora), com link para o alerta, e "Ver todos os alertas".
- Ação: **Nova jornada**.

## Detalhe da jornada (`/journeys/{id}`)

- Cabeçalho: nome, estado, índice, descrição, aviso de rebaixados; ações: **Editar jornada**, atualização automática.
- Quatro contadores por estado (somando todos os alertas das aplicações).
- **Aplicações da jornada**: bloco por aplicação com estado, total de alertas, quantos em alerta/aviso e índice.
- **Alertas da jornada** (mais graves primeiro, até 300): tabela Estado · Alerta (com "Silenciado") · Aplicação · Prioridade · Desde.

## Nova / editar jornada (`/journeys/new`, `/journeys/{id}/edit`)

- Campos: **nome** (1–100), **descrição** (≤500), **aplicações**: seleção entre as existentes **e** campo para digitar aplicações ainda não vistas (separadas por vírgula; são criadas). Na versão original, **remover jornada** existe só pela API (`DELETE /api/journeys/{id}`); a tela de edição não tem esse botão (um botão com confirmação é uma melhoria simples).
- Erros (nome repetido = 409) aparecem no formulário.

## Detalhe da aplicação (`/applications/{nome}`)

- Estado, índice, contagens por estado, as **jornadas de que participa** (links) e a lista de alertas (até 200). 404 se a aplicação não existe.

## Alertas (`/alerts`)

- Filtros (formulário GET, estado na URL): **Estado**, **Aplicação** (igual), **Nome contém**.
- Tabela Estado · Alerta (link + "Silenciado") · Aplicação (link) · Prioridade · Desde. Ordem do mais recente para o mais antigo; **50 por página** com botão "Carregar mais" (cursor, mantendo os filtros). Ação: **Novo alerta**.

## Novo alerta (`/alerts/new`)

Campos: **Fonte** (Datadog, Amazon CloudWatch, AppDynamics, Genérico), **ID do monitor na fonte** (dica por fonte: Datadog = número; CloudWatch = ARN do alarme; AppDynamics = `aplicação/regra`; Genérico = o `monitor_id` do webhook), **Nome**, **Aplicação**, **Prioridade** (sem prioridade, P1..P5), **Tags** (vírgula), **Link** (url).
Seção **Remediação automática** (opcional): nome, tipo (webhook com payload padrão | API com método, cabeçalhos em JSON e corpo-modelo), URL (aviso: o host precisa estar na lista de destinos permitidos), estados que disparam (caixas; padrão Alerta), timeout (ms). Dicas: "Segredos só como `env:NOME`"; variáveis do modelo `{{alert.name}}`, `{{alert.state}}`, `{{alert.application}}`…
Ao salvar → detalhe do alerta. Aviso: este formulário **não cria o monitor na fonte**. 409 se já existe (descoberto por webhook): mensagem clara.

## Detalhe do alerta (`/alerts/{id}`)

- Cabeçalho: nome, estado, "Silenciado", "Arquivado".
- Ficha: **Aplicação** (link), **Jornadas** (links), **Origem** (fonte + ID + "abrir na fonte" se há link), **Estado no Datadog** (só quando há estado bruto lido: valor bruto, a que estado equivale ou "não altera o estado", aviso "diferente do estado aqui: rode a reconciliação", quando foi lido, motivo da equivalência), **Prioridade** ("P2 · peso 8 na saúde"; aviso se está em Alerta mas de baixa prioridade e por isso não deixa a aplicação vermelha), **Estado desde / último evento**, **Tags**.
- Cartão **Silêncio na fonte** (só funciona para Datadog com credenciais; senão mostra indisponível e o motivo): formulário com **duração** (15 min, 1 h, 4 h, 24 h, 3 dias, 7 dias [máximo]), **motivo** (obrigatório, 3–300), **escopo** opcional; botão **Silenciar**. Se silenciado: quem, quando, até quando, motivo, escopo e botões **Remover silêncio** (opção "limpar todos os escopos"). Se o silêncio expirou: aviso. Se há **operação pendente**: aviso "operação sem desfecho gravado desde …; será reexecutada na próxima reconciliação ou em `POST /api/mute-operations/recover`; novas operações neste alerta aguardam".
- **Remediações**: lista (nome, tipo, URL, estados, timeout, ativa/inativa) e **execuções** recentes (status Sucesso/Falhou/Pulada, HTTP, duração, erro). A tela só **mostra** "Ativa"/"Desativada"; ativar/desativar, mudar estados e timeout é pela API (`PATCH /api/alerts/{id}/remediations/{rid}`).
- **Auditoria** completa do alerta (até 200 linhas): quem, quando, tipo legível ("Mudança de estado", "Monitor silenciado no provedor"…) e antes/depois.
- 404 se não existe.

## Reconciliação (`/reconciliation`)

- Cartão **Nova execução**: opções (**simular** [marcado por padrão], criar alertas de monitores novos, executar remediações, filtro por tags da fonte) e botão **Reconciliar**. Desabilitado, com o motivo, se a API do Datadog não está configurada ou se já há uma execução em andamento.
- Texto sobre limites de uso: números por endpoint não são publicados; a aplicação lê os cabeçalhos de limite.
- **Histórico** das últimas 15 execuções: status (Em andamento, Concluída, Parcial, Falhou), quando, simulação ou real, resumo (lidos, em sincronia, corrigidos, criados, mantidos, descartados por estarem velhos, arquivados, ausentes, requisições, esperas por limite) e os **detalhes** (até 100): ação (corrigido, criado, mantido, ausente, dado antigo descartado), alerta, de → para e estado bruto. Mostra os limites de uso vistos.

## Máquina de estados (`/graph`)

- Diagrama dos 4 estados e das transições (setas), mais uma **lista textual das saídas de cada estado** ("recuperado → OK", "disparado → Alerta"…). Um diagrama interativo é opcional; a lista textual é suficiente e mais acessível.
- **Equivalência de estados por fonte**: para cada fonte, uma tabela (estado/valor da fonte · estado aqui ou "mantém o atual" · motivo), o campo de origem, e notas (ex.: como o Datadog interpreta `$ALERT_TRANSITION`; o CloudWatch não tem aviso). Dados vêm do catálogo de fontes (um só lugar).

## Status (`/status`)

- Indicadores: **Banco de dados** (conectado + latência, ou indisponível), **Silêncios pendentes** (quantidade e idade do mais antigo), **Remediações** (falhas e puladas entre as últimas 50), **Versão e tempo no ar**.
- **Fontes de alertas**: webhook único habilitado ou **desligado** (sem `WEBHOOK_SECRET` válido; avisar com destaque), e por fonte: API configurada ou não, **último evento aplicado** (data e "há X"). Nota: só o operador conhece o ritmo normal de cada fonte; para alertar "fonte parada" use a métrica no Prometheus.
- **Alertas ativos por estado** (contadores) e **última reconciliação**.

## Documentação (`/docs`) — opcional

Página de entrada com o resumo da integração (secret, URL, campo `source`, como trocar de ferramenta, exemplo `curl`) e cartões para os manuais; cada manual em sua página com índice "Nesta página". Alternativa mais simples: servir estes arquivos Markdown em um portal interno de documentação da empresa e omitir a tela.
