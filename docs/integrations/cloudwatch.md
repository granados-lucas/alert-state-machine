# Integração com o Amazon CloudWatch

Estudo feito em 2026-10-25 nas páginas oficiais do Amazon SNS ([formato das mensagens HTTP/S](https://docs.aws.amazon.com/sns/latest/dg/sns-message-and-json-formats.html), [assinatura de endpoints HTTP/S](https://docs.aws.amazon.com/sns/latest/dg/sns-http-https-endpoint-as-subscriber.html), [confirmação da assinatura](https://docs.aws.amazon.com/sns/latest/dg/http-subscription-confirmation-json.html)) e do CloudWatch ([alarmes](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/AlarmThatSendsEmail.html)). **Nada foi validado com uma conta AWS real.** O campo a campo do JSON do alarme não consta nas páginas lidas: foi montado a partir de guias de terceiros e do conhecimento geral (itens marcados **não verificado**).

## Como o CloudWatch chega aqui

O CloudWatch não chama webhooks: o **alarme publica num tópico do SNS** e o SNS entrega por **assinatura HTTPS** a `POST /api/webhooks/cloudwatch`.

| Fato (documentação) | Uso aqui |
|---|---|
| O SNS aceita usuário e senha na URL da assinatura (`https://usuario:senha@host`), enviados como Basic/Digest sobre HTTPS | **Autenticação:** o segredo `CLOUDWATCH_WEBHOOK_SECRET` é a **senha**; o usuário é ignorado. Não há como o SNS enviar um cabeçalho personalizado |
| Ao assinar, o SNS envia `SubscriptionConfirmation` com `SubscribeURL` e `Token`; **nenhuma notificação chega antes de a assinatura ser confirmada** | A aplicação confirma sozinha, mas só visitando um `SubscribeURL` `https://sns.<região>.amazonaws.com[.cn]/…` (sem usuário/senha, sem redirecionamento, 10 s). Outro destino responde 400 e **não é chamado** |
| O corpo é JSON, mas o `Content-Type` é `text/plain` | A leitura do corpo ignora o tipo de conteúdo |
| O SNS considera retentáveis os erros 5xx e 429; os demais 4xx são falhas permanentes | Mesmo critério do webhook do Datadog (4xx só quando reenviar não resolve) |
| Cada mensagem tem `MessageId` único (o mesmo na reentrega) | É a chave de idempotência (`event_id`) |

## Configurar

1. Defina `CLOUDWATCH_WEBHOOK_SECRET` (≥ 16 caracteres; **só letras, números, `-` e `_`**, porque vai dentro de uma URL). Opcional: `CLOUDWATCH_TOPIC_ARNS` com os ARNs de tópico aceitos (sem isso, qualquer tópico que conheça o segredo envia eventos).
2. Crie um tópico SNS (ou use o dos alarmes) e uma assinatura **HTTPS** com o endpoint `https://sns:<SEGREDO>@<host-do-global-alerts>/api/webhooks/cloudwatch`. A aplicação precisa ser alcançável pela internet **neste caminho** (o SNS não suporta endpoints privados) e esse caminho fica fora do SSO.
3. O SNS envia a confirmação; a aplicação a confirma (resposta `{"status":"handshake"}`). Se a confirmação falhar (502), o SNS tenta de novo.
4. Em cada alarme, adicione o tópico como ação para **ALARM**, **OK** e **INSUFFICIENT_DATA**.
5. Na **descrição do alarme**, inclua `service:<aplicação>` e, se quiser, `priority:<1 a 5>` (ex.: `service:checkout priority:2 CPU acima de 80%`). Sem `service:` a aplicação é `unassigned`; sem `priority:` não há prioridade (conta como P3).

Cadastro manual (opcional): fonte **Amazon CloudWatch** e, no ID, o **ARN do alarme**.

## Como a aplicação interpreta

- **Identidade do alerta:** `AlarmArn`. **Nome:** `AlarmName`. **Horário:** `StateChangeTime` (aceita o fuso `+0000`), ou o `Timestamp` do SNS.
- **Estados:** `OK` → Ok; `ALARM` → Alerta; `INSUFFICIENT_DATA` → Sem dados. O CloudWatch não tem estado de aviso. Valor desconhecido mantém o estado atual (tabela na tela **Máquina de estados**).
- **Link:** monta o link do console a partir da região do ARN (`#alarmsV2:alarm/<nome>`); **não verificado**.
- **Alarmes compostos** têm o mesmo formato de notificação (suposição).

## Riscos e pontos a validar

1. **A assinatura das mensagens do SNS não é verificada** (`Signature`/`SigningCertURL`). Quem souber o segredo pode enviar eventos como se fosse o CloudWatch. Compensações: segredo forte, HTTPS, `CLOUDWATCH_TOPIC_ARNS`. Verificar a assinatura exigiria baixar e validar o certificado do SNS: decisão pendente.
2. **Formato do JSON do alarme** (`AlarmName`, `AlarmArn`, `NewStateValue`, `StateChangeTime`, `AlarmDescription`): confirme enviando um alarme de teste (`aws cloudwatch set-alarm-state`).
3. O segredo aparece na URL da assinatura: quem tem acesso ao SNS (`GetSubscriptionAttributes`) o enxerga. Dê esse acesso só a quem precisa e troque o segredo ao revogar.
4. Não há reconciliação nem silenciamento para o CloudWatch (só webhook). Silenciar equivaleria a desativar as ações do alarme (`DisableAlarmActions`): não implementado.
