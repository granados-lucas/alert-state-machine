// Reproduz o que a integração Webhooks do Datadog envia com o payload personalizado
// documentado em docs/integrations/datadog.md (variáveis $ID, $ALERT_ID, $ALERT_TRANSITION...).
export const STATES = ["ok", "warn", "alert", "no_data"];

const TRANSITION = { ok: "Recovered", warn: "Warn", alert: "Triggered", no_data: "No Data" };
const ALERT_TYPE = { ok: "success", warn: "warning", alert: "error", no_data: "warning" };

let counter = 0;
export function nextEventId() {
  counter += 1;
  return `${Date.now()}${String(counter).padStart(6, "0")}`;
}

export function buildWebhookPayload(monitor, state, { eventId = nextEventId(), at = Date.now(), repeated = false } = {}) {
  const transition = repeated && state === "alert" ? "Re-Triggered" : TRANSITION[state];
  return {
    event_id: eventId,
    monitor_id: monitor.monitorId,
    monitor_name: monitor.name,
    transition,
    alert_type: ALERT_TYPE[state],
    priority: monitor.priority ? `P${monitor.priority}` : "",
    tags: `service:${monitor.application},env:prod,team:${monitor.team}`,
    last_updated: String(at),
    link: `https://app.datadoghq.com/monitors/${monitor.monitorId}`,
  };
}
