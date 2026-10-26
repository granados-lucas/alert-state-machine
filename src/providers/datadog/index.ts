import { z } from "zod";
import { applicationFromTags, looseText as text, parsePriority, safeHttpUrl } from "../common";
import { ProviderPayloadError, type AlertProvider, type NormalizedEvent } from "../types";
import { createDatadogControl, type DatadogApiConfig } from "./api";
import { createDatadogSource } from "./source";
import { mapTransition } from "./states";

// Payload configurado na integração Webhooks do Datadog (ver docs/integrations/datadog.md).
// Variáveis `$X` do Datadog chegam como texto; números são aceitos por tolerância.
const payloadSchema = z.object({
  event_id: text.pipe(z.string().min(1)),
  monitor_id: text.pipe(z.string().min(1)),
  monitor_name: z.string().min(1),
  transition: z.string().default(""),
  alert_type: z.string().default(""),
  priority: z.string().default(""),
  tags: z.string().default(""),
  last_updated: text.default(""),
  link: z.string().default(""),
});

export function createDatadogProvider(options: { api?: DatadogApiConfig; fetch?: typeof fetch }): AlertProvider {
  return {
    id: "datadog",
    control: options.api ? createDatadogControl(options.api, options.fetch) : undefined,
    source: options.api ? createDatadogSource(options.api, options.fetch) : undefined,
    parse(body): NormalizedEvent {
      const parsed = payloadSchema.safeParse(body);
      if (!parsed.success) throw new ProviderPayloadError("Invalid Datadog webhook payload");
      const p = parsed.data;
      const tags = p.tags.split(",").map((tag) => tag.trim()).filter(Boolean);
      const millis = Number(p.last_updated);
      return {
        provider: "datadog",
        externalEventId: p.event_id,
        externalAlertId: p.monitor_id,
        alertName: p.monitor_name,
        application: applicationFromTags(tags),
        event: mapTransition(p.transition, p.alert_type),
        occurredAt: Number.isFinite(millis) && millis > 0 ? new Date(millis) : new Date(),
        priority: parsePriority(p.priority),
        tags,
        link: safeHttpUrl(p.link),
        raw: body,
      };
    },
  };
}
