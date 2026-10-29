# 01 — Produto e escopo

## Problema

Os alertas da empresa vivem nos monitores de uma ferramenta específica (originalmente o Datadog). Isso acopla o processo de alertas à ferramenta, dificulta enxergar a saúde por fluxo de negócio e deixa a troca de ferramenta cara.

## Ideia

O Global Alerts modela **cada alerta como uma máquina de estados** estimulada por **webhooks**, independente da ferramenta. Trocar de ferramenta deve exigir apenas apontar o webhook da nova ferramenta e, se for o caso, um novo adaptador de entrada. Estados, transições, auditoria, remediação e telas não mudam.

## Funcionalidades

1. **Receber eventos por um webhook único** (`POST /api/webhooks`): autentica a origem, identifica a fonte, normaliza o payload, ignora duplicatas, descarta eventos antigos, aplica a transição, grava histórico e responde rápido.
2. **Mapa de jornadas**: cada jornada é um conjunto de aplicações e é colorida pelo pior estado dos alertas delas, **ponderado pela prioridade**. Mostra também um índice de saúde de 0 a 100%. A mesma aplicação aparece em todas as jornadas de que participa.
3. **Alertas no banco**: criados automaticamente no primeiro evento ou cadastrados antes; com prioridade, tags, link e remediações.
4. **Remediação**: ao entrar em estados escolhidos, o alerta aciona outra ferramenta por webhook ou API (chamada de saída controlada).
5. **Auditoria**: toda mudança de estado e toda manipulação (alerta, remediação, jornada, silêncio, reconciliação) é registrada com autor, horário e antes/depois. A trilha é **somente de inserção**.
6. **Silenciar monitor** na fonte (só Datadog): com prazo e motivo obrigatórios, de forma **atômica** (nunca fica divergência silenciosa entre a fonte e o banco).
7. **Reconciliação** (só Datadog): compara o estado de cada alerta com o estado real dos monitores, corrige divergências, cria alertas de monitores novos e aponta os que sumiram. Manual pela tela ou periódica por um script.
8. **Observabilidade da própria aplicação**: saúde, métricas para Prometheus, tela de status e correlação de requisições nos logs.
9. **Documentação dentro da aplicação** (opcional nesta reconstrução): páginas que exibem os manuais.

## Fora do escopo (versão original)

- Criar, editar ou excluir monitores na fonte. O cadastro daqui não cria o monitor lá. O único acesso de escrita à fonte é silenciar/reativar.
- Notificações (e-mail, chat, pager) e escalonamento.
- Reconhecer alertas (acknowledge) e agendar silêncios futuros ou recorrentes.
- Login próprio, papéis e permissões: o **SSO da empresa fica na frente**; a aplicação só lê a identidade de um cabeçalho para a auditoria. Autorização por papel é evolução futura.
- Silenciar e reconciliar fora do Datadog. As outras fontes só enviam eventos.
- Dependências entre aplicações (foram trocadas por jornadas).
- Jornada por alerta: a jornada é definida por aplicação; o alerta pertence às jornadas da sua aplicação.

## Premissas (decisões já tomadas)

- Estados: `ok`, `warn`, `alert`, `no_data`. Todo alerta **nasce em `no_data`** até o primeiro evento.
- Qualquer estado alcança qualquer outro; repetir o estado atual não é transição.
- **Peso = prioridade do alerta**: P1=16, P2=8, P3=4, P4=2, P5=1; sem prioridade conta como P3. Um alerta em `alert` de P4 ou P5 **não** deixa a aplicação vermelha (rebaixamento para âmbar).
- Aplicações e jornadas são definidas manualmente (tela ou API); a fonte não informa jornadas.
- Um alerta silenciado **continua contando** na saúde (o silêncio é só um aviso visual).
- A identidade vem do SSO. Não há token de administração compartilhado.
- Um webhook e um segredo para todas as ferramentas. A fonte vai no corpo (`"source"`).

## Critérios de aceite do produto

- Um evento válido muda o estado do alerta, aparece no histórico e atualiza o mapa em segundos.
- O mesmo evento enviado duas vezes (ou ao mesmo tempo) gera **uma** transição.
- Um evento mais antigo que o último aplicado **não** altera o estado.
- Se uma aplicação tem um alerta P1–P3 (ou sem prioridade) em `alert`, a aplicação e **todas** as jornadas dela ficam vermelhas; se o alerta é P4/P5, ficam âmbar.
- O índice de saúde segue a fórmula do 02 (exemplos numéricos lá).
- Silenciar com o Datadog fora do ar não altera o alerta e fica auditado como falha.
- Se o processo cair depois de o Datadog aceitar o silêncio e antes de gravá-lo, a operação é concluída sozinha depois (reconciliação ou rota de recuperação).
- Remediação só chama hosts da lista permitida e nunca grava segredos no banco.
- A trilha de auditoria não aceita alteração nem exclusão (nem pela própria aplicação).
- Sem o segredo correto, o webhook responde 401.

## Pendências e riscos conhecidos

| Pendência | Por que importa | Como resolver |
|---|---|---|
| Nenhuma integração foi validada com a ferramenta real | Formatos e textos foram lidos da documentação | Teste com um monitor em cada estado, por fonte (11) |
| Valores exatos de `$ALERT_TRANSITION` do Datadog para aviso e sem dados | Mapeamento de estados | Há contingência pelo `alert_type` (06) |
| Escape de aspas no JSON dos payloads do Datadog | Um nome com aspas pode gerar JSON inválido e perder o evento (400) | Evitar aspas em nomes; usar a reconciliação como rede de segurança |
| Idempotência de silenciar/reativar na fonte | A recuperação repete a chamada | Confirmar com um monitor de teste |
| Assinatura das mensagens do SNS não é verificada | Quem sabe o segredo pode enviar eventos como CloudWatch | Segredo forte, HTTPS, lista de tópicos permitidos |
| Cota real da API do Datadog | A reconciliação consome requisições | Rodar uma simulação e ler os cabeçalhos de limite |
| Origem das jornadas é manual | Manutenção do mapa | Avaliar derivar de uma tag `journey:` nos monitores |
| Monitores com vários grupos (multi-alerta) no mesmo ID | Colapsam em um alerta só (o último evento vence) | Decidir se grupos viram alertas separados |
