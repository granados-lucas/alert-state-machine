import { buildWebhookPayload } from "./datadog.mjs";
import { createRng } from "./rng.mjs";


function remediationBody(kind, receiverUrl) {
  if (kind === "api") {
    return {
      name: "api-fix",
      mode: "api",
      url: `${receiverUrl}/remediate/api`,
      method: "POST",
      headers: { Authorization: "env:SIMULATOR_REMEDIATION_TOKEN" },
      bodyTemplate: '{"alert":"{{alert.name}}","state":"{{alert.state}}"}',
      triggerStates: ["alert", "warn"],
    };
  }
  return { name: `${kind}-fix`, mode: "webhook", url: `${receiverUrl}/remediate/${kind}`, triggerStates: ["alert"] };
}

const registerBody = (m, receiverUrl) => ({
  externalId: m.monitorId,
  name: m.name,
  application: m.application,
  priority: m.priority,
  tags: [`service:${m.application}`, "env:prod", `team:${m.team}`],
  link: `https://app.datadoghq.com/monitors/${m.monitorId}`,
  remediations: m.remediation ? [remediationBody(m.remediation, receiverUrl)] : [],
});

export async function seed({ client, catalog, receiverUrl, log }) {
  const failures = [];
  const viaApi = catalog.monitors.filter((m) => m.registerViaApi);
  for (const m of viaApi) {
    const { status, json } = await client.registerAlert(registerBody(m, receiverUrl));
    if (status !== 201) failures.push(`register ${m.monitorId}: ${status} ${JSON.stringify(json)}`);
  }
  log(`registered ${viaApi.length} alerts via API; ${catalog.monitors.length - viaApi.length} will be discovered by webhook`);
  return failures;
}

export async function createJourneys({ client, catalog, log }) {
  const failures = [];
  for (const journey of catalog.journeys) {
    const { status, json } = await client.createJourney(journey);
    // 409: já existe (demonstração reiniciada sobre dados antigos).
    if (status !== 201 && status !== 409) failures.push(`journey ${journey.name}: ${status} ${JSON.stringify(json)}`);
  }
  log(`defined ${catalog.journeys.length} journeys (${new Set(catalog.journeys.flatMap((j) => j.applications)).size} applications, shared ones appear in several)`);
  return failures;
}

/** Envia um evento e confere a resposta contra o oráculo. Retorna a lista de divergências. */
async function sendChecked({ client, model, monitor, state, at, kind }) {
  const m = model.get(monitor.monitorId);
  const problems = [];
  const payload = buildWebhookPayload(monitor, state, { at, repeated: m.state === state });
  if (kind === "bad-secret") {
    const r = await client.sendWebhook(payload, { secret: "wrong-secret-wrong-secret" });
    if (r.status !== 401) problems.push(`bad secret got ${r.status}`);
    return problems;
  }
  if (kind === "malformed") {
    const r = await client.sendWebhook(null, { raw: '{"event_id": "x", broken' });
    if (r.status !== 400) problems.push(`malformed got ${r.status}`);
    return problems;
  }
  if (kind === "duplicate") {
    const expected = model.apply(monitor.monitorId, state, at);
    const [a, b] = await Promise.all([client.sendWebhook(payload), client.sendWebhook(payload)]);
    const got = [a.json?.status, b.json?.status].sort();
    const want = [expected, "duplicate"].sort();
    if (a.status !== 200 || b.status !== 200 || got.join() !== want.join()) {
      problems.push(`duplicate ${monitor.monitorId}: got ${got}, want ${want}`);
    }
    return problems;
  }
  const expected = model.apply(monitor.monitorId, state, at);
  const r = await client.sendWebhook(payload);
  if (r.status !== 200 || r.json?.status !== expected) {
    problems.push(`${kind} ${monitor.monitorId}->${state}: got ${r.status} ${r.json?.status}, want ${expected}`);
  }
  return problems;
}

/** Fase de eventos: rodadas concorrentes com monitores distintos (ordem por monitor preservada). */
// Pesos padrão (teste de carga) e "calmo" (demonstração): no calmo a maioria dos alertas está em OK
// e os problemas aparecem e somem, como numa operação saudável.
export const BUSY_WEIGHTS = [["alert", 3], ["warn", 3], ["ok", 5], ["no_data", 1]];
export const CALM_WEIGHTS = [["ok", 100], ["warn", 3], ["alert", 1.5], ["no_data", 0.5]];
const PROBLEM_WEIGHTS = [["warn", 5], ["alert", 3], ["no_data", 1]];

export async function churn({ client, catalog, model, events, seed: seedValue, log, workers = 12, stateWeights = BUSY_WEIGHTS, isMuted = () => false }) {
  const rng = createRng(seedValue + 1);
  const problems = [];
  let sent = 0;
  const startedAt = Date.now();
  const kinds = [["normal", 84], ["duplicate", 6], ["stale", 4], ["bad-secret", 3], ["malformed", 3]];
  while (sent < events) {
    const batch = new Set();
    while (batch.size < Math.min(workers, catalog.monitors.length)) batch.add(rng.pick(catalog.monitors));
    const results = await Promise.all(
      [...batch].map((monitor) => {
        const m = model.get(monitor.monitorId);
        let kind = rng.weighted(kinds);
        if (kind === "stale" && m.lastTs === null) kind = "normal";
        const state = rng.weighted(stateWeights);
        // Monitor silenciado no Datadog: o estado muda lá, mas nenhum webhook é enviado.
        if (isMuted(monitor.monitorId)) {
          model.silentChange(monitor.monitorId, state);
          return Promise.resolve([]);
        }
        const at = kind === "stale" ? m.lastTs - 120_000 : Math.max(Date.now(), (m.lastTs ?? 0) + 1);
        return sendChecked({ client, model, monitor, state, at, kind });
      }),
    );
    for (const list of results) problems.push(...list);
    sent += batch.size;
    if (sent % 300 < workers) log(`sent ${sent}/${events} events`);
  }
  const seconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
  log(`${sent} events in ${seconds.toFixed(1)}s (${(sent / seconds).toFixed(0)}/s)`);
  return problems;
}

/** Compara o estado final da aplicação principal com o oráculo. */
export async function verify({ client, catalog, model, receiver, log, appLevel, stillMuted = [] }) {
  const problems = [];

  const alerts = await client.listAllAlerts();
  const mine = new Map(alerts.filter((a) => a.provider === "datadog").map((a) => [a.externalId, a]));
  for (const m of model.all()) {
    const got = mine.get(m.monitor.monitorId);
    if (!got) problems.push(`alert ${m.monitor.monitorId} missing in main app`);
    else if (got.state !== m.state) problems.push(`alert ${m.monitor.monitorId}: state ${got.state}, want ${m.state}`);
  }
  for (const id of stillMuted) {
    if (!mine.get(id)?.mutedUntil) problems.push(`alert ${id} should still be muted`);
  }
  log(`checked ${model.all().length} alerts (${stillMuted.length} still muted with a stale state on purpose)`);

  // Auditoria: uma entrada state_changed por transição aplicada, em todos os alertas.
  const entries = model.all().filter((m) => mine.has(m.monitor.monitorId));
  for (let i = 0; i < entries.length; i += 20) {
    const slice = entries.slice(i, i + 20);
    const details = await Promise.all(slice.map((m) => client.alertDetail(mine.get(m.monitor.monitorId).id)));
    details.forEach((d, j) => {
      const got = d.json.audit.filter((a) => a.kind === "state_changed").length;
      if (got !== slice[j].transitions) problems.push(`audit ${slice[j].monitor.monitorId}: ${got} state changes, want ${slice[j].transitions}`);
    });
  }
  log("checked the audit trail of every alert");

  if (appLevel) {
    const { json } = await client.applications();
    for (const app of catalog.applications) {
      const got = json.applications.find((a) => a.name === app)?.status ?? null;
      const want = model.applicationStatus(app);
      if (got !== want) problems.push(`application ${app}: status ${got}, want ${want}`);
    }
    const { json: map } = await client.journeys();
    for (const journey of catalog.journeys) {
      const got = map.journeys.find((j) => j.name === journey.name);
      if (!got) {
        problems.push(`journey ${journey.name} missing`);
        continue;
      }
      const want = model.journeyStatus(journey.applications);
      if (got.status !== want) problems.push(`journey ${journey.name}: status ${got.status}, want ${want}`);
      const members = got.applications.map((a) => a.name).sort().join();
      if (members !== [...journey.applications].sort().join()) problems.push(`journey ${journey.name}: applications differ`);
    }
    const covered = new Set(catalog.journeys.flatMap((j) => j.applications));
    const wantUnassigned = catalog.applications.filter((a) => !covered.has(a)).sort().join();
    if (map.unassigned.map((a) => a.name).sort().join() !== wantUnassigned) problems.push("applications without journey differ");
    log(`checked ${catalog.applications.length} application statuses and ${catalog.journeys.length} journeys`);
  } else {
    log("application-level check skipped: the main app already had data (use a clean database)");
  }

  // Remediações: contagem exata por monitor (a execução ocorre depois da resposta; aguarda).
  const expected = model.all().filter((m) => m.monitor.remediation);
  const total = expected.reduce((sum, m) => sum + m.remediations, 0);
  const deadline = Date.now() + 20_000;
  const received = () => receiver.calls.filter((c) => c.authorized).length;
  while (received() < total && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
  await new Promise((r) => setTimeout(r, 500));
  for (const m of expected) {
    const got = receiver.calls.filter((c) => c.monitorId === m.monitor.monitorId && c.authorized).length;
    if (got !== m.remediations) problems.push(`remediation ${m.monitor.monitorId}: ${got} calls, want ${m.remediations}`);
  }
  const unauthorized = receiver.calls.filter((c) => !c.authorized).length;
  if (unauthorized) problems.push(`${unauthorized} remediation calls reached the receiver without the expected token`);
  log(`checked remediation calls: ${total} expected, ${received()} received`);
  return problems;
}

/**
 * Rodada de demonstração com dinâmica de saúde: poucos alertas degradam por vez e cada alerta com
 * problema se recupera sozinho com probabilidade `recoverChance` por rodada (vida média ~1/recoverChance
 * rodadas). Todo evento muda o estado de verdade, então cada um é visível na interface.
 */
export async function healthRound({ client, catalog, model, rng, degradeSlots = 3, degradeChance = 0.13, recoverChance = 0.05, isMuted = () => false }) {
  const events = [];
  for (const monitor of catalog.monitors) {
    const state = model.get(monitor.monitorId).state;
    if (state !== "ok" && rng.chance(recoverChance)) events.push([monitor, "ok"]);
  }
  for (let i = 0; i < degradeSlots; i++) {
    if (!rng.chance(degradeChance)) continue;
    const healthy = catalog.monitors.filter((m) => model.get(m.monitorId).state === "ok" && !events.some(([e]) => e === m));
    if (healthy.length) events.push([rng.pick(healthy), rng.weighted(PROBLEM_WEIGHTS)]);
  }
  await Promise.all(
    events.map(([monitor, state]) => {
      if (isMuted(monitor.monitorId)) {
        model.silentChange(monitor.monitorId, state);
        return Promise.resolve([]);
      }
      const at = Math.max(Date.now(), (model.get(monitor.monitorId).lastTs ?? 0) + 1);
      return sendChecked({ client, model, monitor, state, at, kind: "normal" });
    }),
  );
  return events.length;
}

const differentState = (state) => (state === "alert" ? "ok" : "alert");

/**
 * Silenciar e reativar pela API da aplicação principal, contra o Datadog simulado:
 * silencia 6 monitores (1 com escopo), faz o estado deles mudar no provedor sem webhook, reativa 3
 * (a aplicação deve sincronizar o estado informado) e deixa 3 silenciados; 1 monitor responde 403.
 */
export async function muteScenario({ client, catalog, model, fake, log }) {
  const problems = [];
  const ids = new Map((await client.listAllAlerts()).filter((a) => a.provider === "datadog").map((a) => [a.externalId, a.id]));
  const picks = catalog.monitors.filter((_, i) => i % 31 === 0).slice(0, 7);
  const [forbidden, ...muted] = [picks[picks.length - 1], ...picks.slice(0, 6)];
  const scopeOf = (i) => (i === 0 ? "env:prod" : undefined);

  for (const [i, monitor] of muted.entries()) {
    const r = await client.muteAlert(ids.get(monitor.monitorId), { minutes: 60, reason: `simulador: silêncio ${i}`, ...(scopeOf(i) ? { scope: scopeOf(i) } : {}) });
    if (r.status !== 200) {
      problems.push(`mute ${monitor.monitorId}: ${r.status} ${JSON.stringify(r.json)}`);
      continue;
    }
    const entry = fake.mutes.get(monitor.monitorId);
    const seconds = entry ? entry.end - Date.now() / 1000 : -1;
    if (!entry || seconds < 3500 || seconds > 3700) problems.push(`mute ${monitor.monitorId}: Datadog end is ${seconds.toFixed(0)}s away, want ~3600`);
    if ((entry?.scope ?? undefined) !== scopeOf(i)) problems.push(`mute ${monitor.monitorId}: scope ${entry?.scope}, want ${scopeOf(i)}`);
    // O monitor estava em sincronia: nada muda na aplicação.
    const want = model.apply(monitor.monitorId, model.get(monitor.monitorId).truth, Date.now());
    if (r.json?.synced?.outcome !== want) problems.push(`mute ${monitor.monitorId}: sync outcome ${r.json?.synced?.outcome}, want ${want}`);
  }

  // Durante o silêncio o estado muda no Datadog sem webhook: a aplicação fica desatualizada, de propósito.
  for (const monitor of muted) model.silentChange(monitor.monitorId, differentState(model.get(monitor.monitorId).state));

  for (const monitor of muted) {
    const detail = await client.alertDetail(ids.get(monitor.monitorId));
    if (!detail.json?.alert?.mutedUntil) problems.push(`alert ${monitor.monitorId} should be muted in the main app`);
    if (!detail.json?.audit?.some((a) => a.kind === "monitor_muted")) problems.push(`alert ${monitor.monitorId}: no monitor_muted in the audit`);
  }

  // Reativa 3: a aplicação aplica o estado informado pelo Datadog.
  for (const monitor of muted.slice(0, 3)) {
    const truth = model.get(monitor.monitorId).truth;
    const want = model.apply(monitor.monitorId, truth, Date.now() + 1000);
    const r = await client.unmuteAlert(ids.get(monitor.monitorId), { reason: "simulador: fim da janela", allScopes: true });
    if (r.status !== 200) problems.push(`unmute ${monitor.monitorId}: ${r.status} ${JSON.stringify(r.json)}`);
    else if (r.json?.synced?.outcome !== want || r.json?.synced?.state !== truth) {
      problems.push(`unmute ${monitor.monitorId}: synced ${JSON.stringify(r.json?.synced)}, want ${want}/${truth}`);
    }
    if (fake.mutes.has(monitor.monitorId)) problems.push(`unmute ${monitor.monitorId}: Datadog still reports a mute`);
    const detail = await client.alertDetail(ids.get(monitor.monitorId));
    if (detail.json?.alert?.mutedUntil) problems.push(`alert ${monitor.monitorId} should no longer be muted`);
  }

  // Permissão negada no Datadog: 502, nada muda e a tentativa fica auditada.
  fake.forbidden.add(forbidden.monitorId);
  const denied = await client.muteAlert(ids.get(forbidden.monitorId), { minutes: 10, reason: "simulador: sem permissão" });
  if (denied.status !== 502) problems.push(`mute without permission: ${denied.status}, want 502`);
  const deniedDetail = await client.alertDetail(ids.get(forbidden.monitorId));
  if (deniedDetail.json?.alert?.mutedUntil) problems.push("failed mute must not mark the alert as muted");
  if (!deniedDetail.json?.audit?.some((a) => a.kind === "monitor_mute_failed")) problems.push("failed mute must be audited");
  fake.forbidden.delete(forbidden.monitorId);

  log(`mute scenario: ${muted.length} muted, 3 unmuted (state synced), 1 denied by Datadog`);
  return { problems, stillMuted: muted.slice(3).map((m) => m.monitorId) };
}
