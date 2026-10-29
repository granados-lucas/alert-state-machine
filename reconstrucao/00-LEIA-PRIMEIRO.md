# Global Alerts — kit de reconstrução

Este conjunto de arquivos descreve, sem depender do repositório de código, **tudo o que é preciso para construir de novo** a aplicação Global Alerts: o que ela faz, as regras, o banco, a API, as integrações, as telas, a configuração e a ordem de construção. Foi escrito a partir da versão **0.3.0** (2026-10-28) e revisado para ser lido por quem não tem acesso às ferramentas usadas no desenvolvimento original.

## Como usar

1. Leia os arquivos **na ordem**. Os de 01 a 05 definem o sistema; 06 e 07 definem as integrações; 08 a 10 completam; 11 e 12 dizem como provar que ficou certo e em que ordem construir.
2. Construa seguindo o **12-plano-de-construcao.md** (fases curtas, cada uma com um critério de aceite).
3. Em caso de dúvida entre dois arquivos, vale a **regra de negócio** (02) e o **contrato** (04 banco e 05 API).

| Arquivo | Conteúdo |
|---|---|
| 01-produto-e-escopo.md | Problema, objetivos, o que entra e o que não entra, premissas, critérios de aceite |
| 02-regras-de-negocio.md | Máquina de estados, ingestão de eventos, prioridade e saúde, silêncio, remediação, jornadas, auditoria |
| 03-arquitetura.md | Camadas, módulos, fluxos passo a passo, concorrência, segurança, decisões |
| 04-banco-de-dados.md | Esquema completo em SQL (PostgreSQL), índices, gatilho da auditoria, formato da auditoria |
| 05-api.md | Todas as rotas HTTP: entradas, validações, respostas e códigos |
| 06-integracao-datadog.md | Webhook, tabelas de equivalência, API de silêncio e de reconciliação, limites |
| 07-integracoes-outras-fontes.md | Amazon CloudWatch (SNS), AppDynamics e formato genérico |
| 08-telas.md | O que cada tela mostra e faz (sem aparência: use o design system da empresa) |
| 09-configuracao-e-implantacao.md | Variáveis, execução sem contêiner, contêiner opcional, SSO, rede |
| 10-observabilidade.md | Saúde, métricas, status, logs |
| 11-testes-e-aceite.md | Cenários de aceite (dado/quando/então) e como validar sem simulador |
| 12-plano-de-construcao.md | Ordem de construção em fases |
| 13-guia-de-uso.md | Manual de quem opera a aplicação (criar alertas, ligar ferramentas, silenciar, reconciliar) |

## O que o kit deixa de fora de propósito

- **Design system e aparência.** As telas são descritas só por conteúdo, comportamento e acessibilidade. Use o design system proprietário da empresa.
- **Ferramentas de desenvolvimento assistido** (assistentes de código, skills, grafos de código etc.): nada neste kit depende delas.
- **O simulador do Datadog.** Existia um aplicativo separado que simulava o Datadog para testes. O 11 explica como validar sem ele e descreve o que um simulador precisaria fazer, caso vocês queiram um.

## Stack de referência (substituível)

A versão original usa: Node 24, TypeScript estrito, Next.js (App Router), React, PostgreSQL 17, um ORM com migrações SQL versionadas, validação de entrada com um esquema declarativo (Zod), logs JSON (Pino) e testes com Vitest. **Nada disso é obrigatório.** O que não pode mudar são os contratos: o esquema do banco (04), as rotas e payloads (05, 06, 07) e as regras (02). Se a empresa tiver outra stack (Java, .NET, Go…), mantenha esses contratos.

Exigências mínimas de ambiente: PostgreSQL 14 ou superior (a versão original usa 17), um runtime HTTP, e um **SSO corporativo na frente** da aplicação (ver 09). Docker é **opcional**.

## Glossário

| Termo | Significado |
|---|---|
| **Fonte** (provedor) | A ferramenta de monitoramento que envia eventos: Datadog, CloudWatch, AppDynamics ou genérica |
| **Monitor** | O monitor/alarme na ferramenta de origem |
| **Alerta** | O monitor dentro do Global Alerts: uma máquina de estados com histórico. Identificado por **fonte + ID externo** |
| **Aplicação** | O sistema a que o alerta pertence (vem de uma tag ou campo do evento) |
| **Jornada** | Fluxo de negócio formado por aplicações (ex.: "Compra"). Uma aplicação pode estar em várias jornadas |
| **Prioridade** | P1 a P5 (1 é a mais alta). É também o **peso** do alerta na saúde |
| **Saúde** | Cor (pior estado, com rebaixamento por prioridade) e índice de 0 a 100% de uma aplicação ou jornada |
| **Remediação** | Chamada de saída (webhook ou API) feita quando o alerta entra em certos estados |
| **Reconciliação** | Leitura do estado real dos monitores na fonte para corrigir divergências (só Datadog) |
| **Silêncio** | Ação de silenciar um monitor na fonte por um prazo (só Datadog) |

## Nunca foi validado com sistemas reais

Tudo foi testado contra simulações e documentação. **Ainda não foi executado contra Datadog, CloudWatch ou AppDynamics reais.** Cada ponto incerto está marcado com ⚠ nos arquivos 06 e 07. Antes de produção, valide com um monitor de teste em cada ferramenta (ver 11).

## Perguntas que a empresa precisa responder (afetam a construção)

1. Qual é o SSO e qual cabeçalho ele preenche com a identidade do usuário? (09)
2. O caminho do webhook (`/api/webhooks`) e o de métricas (`/api/metrics`) podem ficar fora do SSO? Sem isso as ferramentas e o coletor de métricas não conseguem chamar. (09)
3. Quais ferramentas de monitoramento entram na primeira versão? O mínimo útil é uma fonte + mapa + auditoria.
4. A aplicação ficará acessível pela internet para o CloudWatch (SNS) e o Datadog? Ambos precisam alcançá-la. (07, 06)
5. Quais destinos de remediação serão permitidos (lista fechada de hosts)? (02, 09)
6. Como as jornadas serão mantidas (manualmente, como na versão original)?
