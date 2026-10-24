import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AlertEvent } from "@/domain/alert-machine";
import { ProviderPayloadError, type AlertProvider, type NormalizedEvent } from "../types";
import { createDatadogControl, type DatadogApiConfig } from "./api";

export const DATADOG_SECRET_HEADER = "x-webhook-secret";

// Payload configurado na integração Webhooks do Datadog (ver docs/integrations/datadog.md).
// Variáveis `$X` do Datadog chegam como texto; números são aceitos por tolerância.
const text = z.union([z.string(), z.number()]).transform(String);
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

const BY_ALERT_TYPE: Record<string, AlertEvent> = { success: "recovered", warning: "warned", error: "triggered" };

export function mapTransition(transition: string, alertType: string): AlertEvent | null {
  const t = transition.toLowerCase();
  if (t.includes("recover")) return "recovered";
  if (t.includes("no data") || t.includes("no_data")) return "data_missing";
  if (t.includes("warn")) return "warned";
  if (t.includes("trigger")) return "triggered";
  // Sem transição reconhecida: o tipo do alerta ainda indica a severidade corrente.
  return BY_ALERT_TYPE[alertType.toLowerCase()] ?? null;
}

export function applicationFromTags(tags: string[]) {
  for (const key of ["service", "app", "application"]) {
    const hit = tags.find((tag) => tag.toLowerCase().startsWith(`${key}:`));
    const value = hit?.slice(key.length + 1).trim();
    if (value) return value;
  }
  return "unassigned";
}

// O link vira href na interface: só http(s) passa.
function safeHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createDatadogProvider(options: { secret: string | undefined; api?: DatadogApiConfig; fetch?: typeof fetch }): AlertProvider {
  return {
    id: "datadog",
    control: options.api ? createDatadogControl(options.api, options.fetch) : undefined,
    authenticate(headers) {
      const received = headers.get(DATADOG_SECRET_HEADER);
      return Boolean(options.secret && received && safeEqual(received, options.secret));
    },
    parse(body): NormalizedEvent {
      const parsed = payloadSchema.safeParse(body);
      if (!parsed.success) throw new ProviderPayloadError("Invalid Datadog webhook payload");
      const p = parsed.data;
      const tags = p.tags.split(",").map((tag) => tag.trim()).filter(Boolean);
      const millis = Number(p.last_updated);
      const priority = /^P?([1-5])$/i.exec(p.priority.trim())?.[1];
      return {
        provider: "datadog",
        externalEventId: p.event_id,
        externalAlertId: p.monitor_id,
        alertName: p.monitor_name,
        application: applicationFromTags(tags),
        event: mapTransition(p.transition, p.alert_type),
        occurredAt: Number.isFinite(millis) && millis > 0 ? new Date(millis) : new Date(),
        priority: priority ? Number(priority) : null,
        tags,
        link: safeHttpUrl(p.link),
        raw: body,
      };
    },
  };
}
