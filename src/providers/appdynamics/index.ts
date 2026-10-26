import { z } from "zod";
import { eventTo } from "@/domain/alert-machine";
import { looseText as text, parsePriority, parseTime, safeHttpUrl, unresolved } from "../common";
import { ProviderPayloadError, type AlertProvider, type NormalizedEvent } from "../types";
import { EVENT_TYPE_EQUIVALENCE } from "./states";

/**
 * AppDynamics envia o que o modelo da "HTTP Request Action" mandar. O modelo esperado está em
 * docs/integrations/appdynamics.md (variáveis `${latestEvent.*}` e `${policy.*}`). Baseado na documentação;
 * NUNCA validado com um controller real. A prioridade não existe no AppDynamics: vai fixa no modelo (um por prioridade).
 */
const payloadSchema = z.object({
  event_id: text.pipe(z.string().min(1)),
  event_type: z.string().min(1),
  application: text.pipe(z.string().min(1)),
  health_rule: text.default(""),
  policy: text.default(""),
  event_time: text.default(""),
  link: z.string().default(""),
  priority: text.default(""),
});

const clean = (value: string) => (unresolved(value) ? "" : value.trim());

export function createAppdynamicsProvider(): AlertProvider {
  return {
    id: "appdynamics",
    parse(body): NormalizedEvent {
      const parsed = payloadSchema.safeParse(body);
      if (!parsed.success) throw new ProviderPayloadError("Invalid AppDynamics webhook payload");
      const p = parsed.data;
      const application = clean(p.application);
      // Um alerta é uma regra de saúde de uma aplicação; sem regra, a política.
      const rule = clean(p.health_rule) || clean(p.policy);
      if (!application || !rule) throw new ProviderPayloadError("Invalid AppDynamics webhook payload");
      const policy = clean(p.policy);
      const row = EVENT_TYPE_EQUIVALENCE[p.event_type.trim().toUpperCase()];
      return {
        provider: "appdynamics",
        externalEventId: p.event_id,
        externalAlertId: `${application}/${rule}`,
        alertName: rule,
        application,
        event: row ? eventTo(row.state) : null,
        occurredAt: parseTime(clean(p.event_time)) ?? new Date(),
        priority: parsePriority(clean(p.priority)),
        tags: policy ? [`policy:${policy}`] : [],
        link: safeHttpUrl(clean(p.link)),
        raw: body,
      };
    },
  };
}
