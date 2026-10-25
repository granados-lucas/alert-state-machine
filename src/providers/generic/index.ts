import { z } from "zod";
import { eventTo, ALERT_STATES } from "@/domain/alert-machine";
import { headerSecretAuth } from "../auth";
import { applicationFromTags, parsePriority, parseTime, safeHttpUrl } from "../common";
import { ProviderPayloadError, type AlertProvider, type NormalizedEvent } from "../types";

// Formato canônico para qualquer fonte sem adaptador próprio (script, Alertmanager via proxy, ferramenta interna).
const text = z.union([z.string(), z.number()]).transform(String);
const payloadSchema = z.object({
  event_id: text.pipe(z.string().min(1)),
  monitor_id: text.pipe(z.string().min(1)),
  monitor_name: z.string().min(1),
  state: z.enum(ALERT_STATES),
  occurred_at: text.optional(),
  application: z.string().trim().optional(),
  tags: z.array(z.string()).default([]),
  priority: text.optional(),
  link: z.string().optional(),
});

export function createGenericProvider(options: { secret: string | undefined }): AlertProvider {
  return {
    id: "generic",
    authenticate: headerSecretAuth(options.secret),
    parse(body): NormalizedEvent {
      const parsed = payloadSchema.safeParse(body);
      if (!parsed.success) throw new ProviderPayloadError("Invalid generic webhook payload");
      const p = parsed.data;
      return {
        provider: "generic",
        externalEventId: p.event_id,
        externalAlertId: p.monitor_id,
        alertName: p.monitor_name,
        application: p.application || applicationFromTags(p.tags),
        event: eventTo(p.state),
        occurredAt: parseTime(p.occurred_at) ?? new Date(),
        priority: parsePriority(p.priority),
        tags: p.tags,
        link: safeHttpUrl(p.link),
        raw: body,
      };
    },
  };
}
