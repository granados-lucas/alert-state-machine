import { z } from "zod";
import { eventTo } from "@/domain/alert-machine";
import { basicPasswordAuth } from "../auth";
import { applicationFromTags, parsePriority, parseTime, tokensFrom } from "../common";
import { ProviderApiError, ProviderPayloadError, type AlertProvider, type NormalizedEvent } from "../types";
import { ALARM_STATE_EQUIVALENCE } from "./states";

/**
 * Alarmes do CloudWatch chegam pelo Amazon SNS (assinatura HTTPS). Premissas, baseadas na documentação e
 * NÃO validadas com a AWS real:
 *  - o SNS autentica o destino com HTTP Basic embutido na URL (https://usuario:SEGREDO@host/...);
 *  - o corpo é JSON mesmo com `Content-Type: text/plain`; `Message` é o alarme, também em JSON (texto);
 *  - NÃO verificamos a assinatura da mensagem do SNS (SigningCertURL): quem conhece o segredo pode enviar eventos.
 */
const envelope = z.object({
  Type: z.string(),
  MessageId: z.string().min(1),
  TopicArn: z.string().optional(),
  Message: z.string().optional(),
  Timestamp: z.string().optional(),
  SubscribeURL: z.string().optional(),
});

const alarm = z.object({
  AlarmName: z.string().min(1),
  AlarmDescription: z.string().nullish(),
  AlarmArn: z.string().min(1),
  NewStateValue: z.string(),
  StateChangeTime: z.string().optional(),
});

// Destino do SubscribeURL: só o endpoint do próprio SNS, por https (evita que a aplicação seja usada para chamar outro host).
const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

// arn:aws:cloudwatch:REGIAO:CONTA:alarm:NOME
function consoleLink(arn: string, name: string) {
  const region = /^arn:aws[\w-]*:cloudwatch:([a-z0-9-]+):/.exec(arn)?.[1];
  return region ? `https://console.aws.amazon.com/cloudwatch/home?region=${region}#alarmsV2:alarm/${encodeURIComponent(name)}` : null;
}

export function createCloudwatchProvider(options: { secret: string | undefined; topicArns?: string[]; fetch?: typeof fetch }): AlertProvider {
  const fetchImpl = options.fetch ?? fetch;
  return {
    id: "cloudwatch",
    authenticate: basicPasswordAuth(options.secret),
    async handshake(body) {
      const parsed = envelope.safeParse(body);
      if (!parsed.success) return null; // o parse acusa o payload inválido
      const message = parsed.data;
      if (message.Type === "UnsubscribeConfirmation") return { message: "unsubscribe confirmation ignored" };
      if (message.Type !== "SubscriptionConfirmation") return null;
      if (options.topicArns?.length && !options.topicArns.includes(message.TopicArn ?? "")) throw new ProviderPayloadError("topic is not allowed");
      let url: URL;
      try {
        url = new URL(message.SubscribeURL ?? "");
      } catch {
        throw new ProviderPayloadError("invalid SubscribeURL");
      }
      if (url.protocol !== "https:" || !SNS_HOST.test(url.hostname) || url.username || url.password) throw new ProviderPayloadError("SubscribeURL is not an SNS endpoint");
      let response: Response;
      try {
        response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(10_000) });
      } catch {
        throw new ProviderApiError("SNS subscription confirmation failed (network)", null);
      }
      if (!response.ok) throw new ProviderApiError(`SNS responded ${response.status} to the subscription confirmation`, response.status);
      return { message: "subscription confirmed" };
    },
    parse(body): NormalizedEvent {
      const wrapped = envelope.safeParse(body);
      if (!wrapped.success || wrapped.data.Type !== "Notification" || !wrapped.data.Message) throw new ProviderPayloadError("Invalid SNS notification");
      if (options.topicArns?.length && !options.topicArns.includes(wrapped.data.TopicArn ?? "")) throw new ProviderPayloadError("topic is not allowed");
      let inner: unknown;
      try {
        inner = JSON.parse(wrapped.data.Message);
      } catch {
        throw new ProviderPayloadError("SNS message is not a CloudWatch alarm");
      }
      const parsed = alarm.safeParse(inner);
      if (!parsed.success) throw new ProviderPayloadError("SNS message is not a CloudWatch alarm");
      const a = parsed.data;
      const tokens = tokensFrom(a.AlarmDescription);
      const state = ALARM_STATE_EQUIVALENCE[a.NewStateValue];
      return {
        provider: "cloudwatch",
        externalEventId: wrapped.data.MessageId,
        externalAlertId: a.AlarmArn,
        alertName: a.AlarmName,
        application: applicationFromTags(tokens),
        event: state ? eventTo(state.state) : null,
        occurredAt: parseTime(a.StateChangeTime) ?? parseTime(wrapped.data.Timestamp) ?? new Date(),
        priority: parsePriority(tokens.find((t) => t.toLowerCase().startsWith("priority:"))?.slice(9)),
        tags: tokens,
        link: consoleLink(a.AlarmArn, a.AlarmName),
        raw: body,
      };
    },
  };
}
