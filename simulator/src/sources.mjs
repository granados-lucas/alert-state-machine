// Outras fontes de alertas além do Datadog (CloudWatch via SNS, AppDynamics, genérico). O simulador monta os
// payloads por conta própria, a partir da documentação de cada ferramenta, e confere o resultado na aplicação.
// Nada aqui importa código da aplicação principal.
const CLOUDWATCH_STATE = { ok: "OK", alert: "ALARM", no_data: "INSUFFICIENT_DATA" };
const APPDYNAMICS_EVENT = { alert: "POLICY_OPEN_CRITICAL", warn: "POLICY_OPEN_WARNING", ok: "POLICY_CLOSE_WARNING" };

const iso = (at) => new Date(at).toISOString().replace("Z", "+0000");

export const SOURCES = {
  cloudwatch: {
    states: ["ok", "alert", "no_data"],
    // O SNS autentica com HTTP Basic embutido na URL (usuário:senha); aqui, só o cabeçalho resultante.
    headers: (secret) => ({ "content-type": "text/plain; charset=UTF-8", authorization: `Basic ${Buffer.from(`sns:${secret}`).toString("base64")}` }),
    externalId: (alarm) => `arn:aws:cloudwatch:us-east-1:123456789012:alarm:${alarm.name}`,
    payload: (alarm, state, at, eventId) => ({
      Type: "Notification",
      MessageId: eventId,
      TopicArn: "arn:aws:sns:us-east-1:123456789012:alarmes",
      Subject: `ALARM: "${alarm.name}" in US East (N. Virginia)`,
      Message: JSON.stringify({
        AlarmName: alarm.name,
        AlarmDescription: `service:${alarm.application} priority:${alarm.priority} simulador`,
        AWSAccountId: "123456789012",
        AlarmArn: `arn:aws:cloudwatch:us-east-1:123456789012:alarm:${alarm.name}`,
        NewStateValue: CLOUDWATCH_STATE[state],
        NewStateReason: "simulador",
        StateChangeTime: iso(at),
        Region: "US East (N. Virginia)",
      }),
      Timestamp: new Date(at).toISOString(),
    }),
  },
  appdynamics: {
    states: ["ok", "warn", "alert"],
    headers: (secret) => ({ "content-type": "application/json", "x-webhook-secret": secret }),
    externalId: (alarm) => `${alarm.application}/${alarm.name}`,
    payload: (alarm, state, at, eventId) => ({
      source: "appdynamics",
      event_id: eventId,
      event_type: APPDYNAMICS_EVENT[state],
      application: alarm.application,
      health_rule: alarm.name,
      policy: "Política do simulador",
      event_time: String(at),
      link: `https://controller.example.test/events/${eventId}`,
      priority: String(alarm.priority),
    }),
  },
  generic: {
    states: ["ok", "warn", "alert", "no_data"],
    headers: (secret) => ({ "content-type": "application/json", "x-webhook-secret": secret }),
    externalId: (alarm) => alarm.name,
    payload: (alarm, state, at, eventId) => ({
      source: "generic",
      event_id: eventId,
      monitor_id: alarm.name,
      monitor_name: alarm.name,
      state,
      occurred_at: new Date(at).toISOString(),
      application: alarm.application,
      priority: alarm.priority,
      tags: ["env:prod"],
    }),
  },
};

// Sequências fixas de estados por fonte: o último é o estado final esperado.
const SEQUENCES = {
  cloudwatch: [["alert", "ok", "alert"], ["no_data", "ok"], ["alert"]],
  appdynamics: [["warn", "alert", "ok", "warn"], ["alert", "ok"], ["alert"]],
  generic: [["alert", "warn", "no_data", "ok"], ["warn"], ["alert", "ok", "alert"]],
};

/**
 * Todas as fontes entram pelo mesmo webhook, com o mesmo segredo. Cada uma recebe 3 alarmes em aplicações próprias (src-<fonte>-N), com sequências de eventos, uma reentrega
 * duplicada e um segredo errado. Confere respostas, estado final, aplicação, fonte e prioridade na aplicação principal.
 */
export async function multiSourceScenario({ client, secret, log, runId = Date.now() }) {
  const problems = [];
  let clock = Date.now();
  let n = 0;
  const expected = [];
  for (const [source, sequences] of Object.entries(SEQUENCES)) {
    const def = SOURCES[source];
    for (const [i, sequence] of sequences.entries()) {
      const alarm = { name: `sim-${source}-${runId}-${i}`, application: `src-${source}-${i}`, priority: 1 + (i % 3) };
      let last = null;
      for (const state of sequence) {
        clock += 1000;
        const eventId = `${source}-${runId}-${++n}`;
        const body = JSON.stringify(def.payload(alarm, state, clock, eventId));
        const r = await client.sendTo(body, def.headers(secret));
        // "unchanged" só ocorre se o alerta novo já nasce no estado enviado (ok).
        if (r.status !== 200 || !["applied", "unchanged"].includes(r.json?.status) || r.json?.state !== state) {
          problems.push(`${source} ${alarm.name}->${state}: got ${r.status} ${JSON.stringify(r.json)}, want applied/${state}`);
        }
        if (state === sequence[0] && sequence.length === 1) {
          const again = await client.sendTo(body, def.headers(secret));
          if (again.json?.status !== "duplicate") problems.push(`${source} ${alarm.name}: duplicate delivery got ${JSON.stringify(again.json)}`);
        }
        last = state;
      }
      expected.push({ source, alarm, externalId: def.externalId(alarm), state: last });
    }
    const denied = await client.sendTo(JSON.stringify(def.payload({ name: "x", application: "x", priority: 1 }, "alert", clock, `${source}-bad`)), def.headers("segredo-errado-0123456789"));
    if (denied.status !== 401) problems.push(`${source}: wrong secret got ${denied.status}, want 401`);
  }

  const alerts = await client.listAllAlerts();
  for (const e of expected) {
    const got = alerts.find((a) => a.provider === e.source && a.externalId === e.externalId);
    if (!got) {
      problems.push(`${e.source} ${e.alarm.name}: alert missing in main app`);
      continue;
    }
    if (got.state !== e.state) problems.push(`${e.source} ${e.alarm.name}: state ${got.state}, want ${e.state}`);
    const detail = (await client.alertDetail(got.id)).json?.alert;
    if (detail?.application !== e.alarm.application) problems.push(`${e.source} ${e.alarm.name}: application ${detail?.application}, want ${e.alarm.application}`);
    // CloudWatch e AppDynamics trazem a prioridade do próprio evento (descrição / modelo da ação).
    if (detail?.priority !== e.alarm.priority) problems.push(`${e.source} ${e.alarm.name}: priority ${detail?.priority}, want ${e.alarm.priority}`);
  }
  log(`multi-source scenario: ${expected.length} alerts from ${new Set(expected.map((e) => e.source)).size} sources checked`);
  return problems;
}
