# 12 — Plano de construção

Construa em fases curtas. Cada fase termina com um **critério de aceite** que pode ser conferido (cenários numerados do 11). Não passe para a seguinte sem conferir. Uma boa regra: cada fase vira um pedido de mudança (pull request) pequeno, com testes.

## Antes de começar

1. Resolva as **perguntas do 00** (SSO, rede, fontes da primeira versão, destinos de remediação).
2. Crie o repositório, o projeto na stack escolhida e o PostgreSQL de desenvolvimento/teste.
3. Defina o esqueleto de camadas (03) e a regra "apresentação não acessa o banco".

## Fase 1 — Domínio puro

- Máquina de estados (`transicao`, tabela de estados e eventos) — 02, seção 1.
- Cálculo de saúde (pesos, rebaixamento, índice, soma de grupos, ordenações) — 02, seção 3.
- Regras do silêncio (limites 1 min–7 dias, `muteUntil`, `isMuted`) — 02, seção 4.
- **Aceite**: cenário 10 (e testes de unidade de transição).

## Fase 2 — Banco e ingestão

- Aplicar o SQL do 04 (uma etapa de migração explícita) e criar o ponto único de conexão.
- Ingestão idempotente de um evento normalizado (02, seção 2), com auditoria.
- Serviços de alertas (criar, atualizar, arquivar) com auditoria e validação.
- **Aceite**: cenários 1–9, 38 (alertas) e 40 (auditoria imutável), contra PostgreSQL de teste.

## Fase 3 — Webhook único e a primeira fonte

- Autenticação do webhook (cabeçalho e Basic), `sourceOf`, leitura limitada do corpo, `X-Request-Id`, respostas (05).
- Adaptador **genérico** primeiro (é o mais simples e serve de referência), depois o da fonte que a empresa usa (Datadog: 06).
- **Aceite**: cenários 14, 15, 17/20; e a validação com `curl` do 11.

## Fase 4 — Jornadas, mapa e telas principais

- Serviços de jornadas e consultas (mapa de aplicações e jornadas, detalhes, listagem por cursor, mudanças recentes).
- Telas: Mapa (`/`), detalhe da jornada, nova/editar jornada, Alertas, detalhe do alerta, novo alerta, detalhe da aplicação (08), usando o design system da empresa.
- API de gestão (05) sem token, com identidade do SSO na auditoria.
- **Aceite**: cenários 11–13, 39; e as telas navegáveis com dados de teste.

## Fase 5 — Remediação

- Validação (lista de destinos, `env:NOME`, URL sem credenciais), execução depois da resposta, limite de concorrência, registro de execuções e auditoria (02, seção 5).
- **Aceite**: cenários 21–25.

## Fase 6 — Outras fontes

- CloudWatch (incluindo a confirmação da assinatura do SNS), AppDynamics (07), tabela de equivalência por fonte e tela da máquina de estados (08).
- **Aceite**: cenários 16, 18, 19; teste com um alarme/política reais de teste.

## Fase 7 — Silêncio atômico e reconciliação (Datadog)

- Cliente da API do Datadog (silenciar/reativar/listar), tabela de equivalência de `overall_state` (06).
- Silêncio por intenção → fonte → resultado, com recuperação (02, seção 4) e a tela do alerta.
- Reconciliação em segundo plano, tela, script periódico (02, seção 9; 05).
- **Aceite**: cenários 26–37, **mais** a validação com um monitor real de teste (pontos ⚠ de 06).

## Fase 8 — Observabilidade

- Health, métricas, tela de status, logs com correlação (10).
- **Aceite**: cenário 41; um coletor Prometheus lendo `/api/metrics` e os alertas sugeridos configurados.

## Fase 9 — Endurecimento e entrada em produção

- Revisão de segurança: SSO na frente e porta fechada ao resto; webhook fora do SSO com segredo forte; `/api/metrics` só para o coletor; firewall de saída com a lista de 09; nenhum segredo no repositório, imagens ou logs.
- Política de **retenção** das tabelas de histórico (04) e backups.
- Rodada de aceite completa (11) em homologação, com cada ferramenta real.
- Ensaio de falha: derrubar o banco, derrubar a aplicação no meio de um silêncio, enviar eventos duplicados e fora de ordem.
- Documentação de operação (13) revisada com o time que vai operar.

## O que NÃO fazer (lições da versão original)

- Não reintroduzir um token de administração compartilhado: a identidade vem do SSO.
- Não guardar segredos de remediação no banco; só referências `env:NOME`.
- Não deixar chamadas de saída sem lista de destinos, timeout, limite de concorrência e sem seguir redirecionamentos.
- Não depender de transação entre a fonte e o banco para o silêncio: use a intenção gravada antes + recuperação.
- Não confiar na ordem de chegada dos eventos: use o horário da fonte e a idempotência.
- Não aplicar migrações no build nem em cada requisição.
- Não duplicar a tabela de estados/equivalências entre telas, lógica e documentação.
- Não considerar uma integração pronta sem testar o formato real da ferramenta (os pontos ⚠).
