import assert from "node:assert/strict";
import { test } from "node:test";
import { generateCatalog } from "../src/catalog.mjs";
import { buildWebhookPayload } from "../src/datadog.mjs";
import { createModel } from "../src/model.mjs";
import { createFakeDatadog } from "../src/fake-datadog.mjs";
import { startReceiver } from "../src/receiver.mjs";
import { createRng } from "../src/rng.mjs";

test("catálogo padrão tem 32 aplicações e exatamente 200 monitores únicos", () => {
  const c = generateCatalog();
  assert.equal(c.applications.length, 32);
  assert.equal(c.monitors.length, 200);
  assert.equal(new Set(c.monitors.map((m) => m.monitorId)).size, 200);
  for (const app of c.applications) assert.ok(c.monitors.filter((m) => m.application === app).length >= 2);
});

test("catálogo é determinístico por semente", () => {
  assert.deepEqual(generateCatalog({ seed: 7 }), generateCatalog({ seed: 7 }));
  assert.notDeepEqual(generateCatalog({ seed: 7 }).monitors, generateCatalog({ seed: 8 }).monitors);
});

test("jornadas compartilham aplicações e deixam algumas sem jornada", () => {
  const c = generateCatalog();
  assert.ok(c.journeys.length >= 6);
  const known = new Set(c.applications);
  const count = new Map();
  for (const j of c.journeys) for (const a of j.applications) {
    assert.ok(known.has(a), `${a} não existe no catálogo`);
    count.set(a, (count.get(a) ?? 0) + 1);
  }
  assert.ok([...count.values()].some((n) => n >= 3), "alguma aplicação deveria estar em 3+ jornadas");
  assert.ok(c.applications.some((a) => !count.has(a)), "alguma aplicação deveria ficar sem jornada");
});

test("jornadas ignoram aplicações fora do catálogo reduzido", () => {
  const c = generateCatalog({ apps: 4, alerts: 8 });
  const known = new Set(c.applications);
  for (const j of c.journeys) for (const a of j.applications) assert.ok(known.has(a));
});

test("remediação só existe em alertas registrados pela API", () => {
  const c = generateCatalog();
  assert.ok(c.monitors.some((m) => m.remediation));
  assert.ok(c.monitors.every((m) => m.registerViaApi || m.remediation === null));
});

test("catálogo recusa tamanhos impossíveis", () => {
  assert.throws(() => generateCatalog({ apps: 99 }));
  assert.throws(() => generateCatalog({ apps: 10, alerts: 15 }));
});

test("payload imita as variáveis do webhook do Datadog", () => {
  const m = generateCatalog().monitors[0];
  const p = buildWebhookPayload(m, "alert", { eventId: "9", at: 1700000000000 });
  assert.equal(p.event_id, "9");
  assert.equal(p.transition, "Triggered");
  assert.equal(p.alert_type, "error");
  assert.equal(p.last_updated, "1700000000000");
  assert.match(p.tags, new RegExp(`service:${m.application}`));
  assert.equal(buildWebhookPayload(m, "alert", { repeated: true }).transition, "Re-Triggered");
  assert.equal(buildWebhookPayload(m, "ok").transition, "Recovered");
});

test("saúde da jornada é o pior estado entre as aplicações", () => {
  const monitors = [
    { monitorId: "1", application: "a", remediation: null },
    { monitorId: "2", application: "b", remediation: null },
  ];
  const model = createModel(monitors);
  model.apply("1", "ok", 1);
  model.apply("2", "alert", 1);
  assert.equal(model.journeyStatus(["a"]), "ok");
  assert.equal(model.journeyStatus(["a", "b"]), "alert");
  assert.equal(model.journeyStatus(["x"]), null);
});

test("modelo aplica, ignora repetição e descarta evento antigo", () => {
  const m = { monitorId: "1", application: "a", remediation: "hook" };
  const model = createModel([m]);
  assert.equal(model.apply("1", "alert", 100), "applied");
  assert.equal(model.apply("1", "alert", 200), "unchanged");
  assert.equal(model.apply("1", "ok", 50), "stale");
  assert.equal(model.get("1").state, "alert");
  assert.equal(model.get("1").remediations, 1);
  assert.equal(model.applicationStatus("a"), "alert");
  assert.equal(model.applicationStatus("outra"), null);
});

test("PRNG repete a sequência para a mesma semente", () => {
  const a = createRng(1);
  const b = createRng(1);
  assert.deepEqual([a.next(), a.int(1, 9), a.pick([1, 2, 3])], [b.next(), b.int(1, 9), b.pick([1, 2, 3])]);
});

test("receptor conta chamadas, exige token na rota api e responde 503 na flaky", async () => {
  const receiver = await startReceiver({ port: 0, token: "tok" });
  const post = (path, body, headers = {}) =>
    fetch(`http://127.0.0.1:${receiver.port}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.equal((await post("/remediate/hook", { alert: { name: "x #11" } })).status, 200);
  assert.equal((await post("/remediate/flaky", { alert: { name: "x #12" } })).status, 503);
  assert.equal((await post("/remediate/api", { alert: "x #13" })).status, 401);
  assert.equal((await post("/remediate/api", { alert: "x #13" }, { authorization: "tok" })).status, 200);
  assert.equal((await post("/nope", {})).status, 404);
  assert.deepEqual(receiver.calls.map((c) => [c.kind, c.monitorId, c.authorized]), [
    ["hook", "11", true], ["flaky", "12", true], ["api", "13", false], ["api", "13", true],
  ]);
  await receiver.close();
});

test("Datadog simulado: valida chaves e prazo, silencia, reativa e informa o estado do monitor", async () => {
  const truth = { 42: "alert" };
  const fake = createFakeDatadog({ apiKey: "k1", appKey: "k2", getTruth: (id) => truth[id], now: () => 1_000_000 });
  const receiver = await startReceiver({ port: 0, token: "tok", extraHandler: fake.handle });
  const call = (path, headers = { "DD-API-KEY": "k1", "DD-APPLICATION-KEY": "k2" }) =>
    fetch(`http://127.0.0.1:${receiver.port}${path}`, { method: "POST", headers }).then(async (r) => [r.status, await r.json()]);

  assert.deepEqual(await call("/api/v1/monitor/42/mute?end=2000", {}), [403, { errors: ["Forbidden"] }]);
  assert.equal((await call("/api/v1/monitor/99/mute?end=2000"))[0], 404);
  assert.equal((await call("/api/v1/monitor/42/mute?end=900"))[0], 400);
  assert.equal((await call("/api/v1/monitor/42/mute"))[0], 400);

  const [status, body] = await call("/api/v1/monitor/42/mute?end=2000&scope=env%3Aprod");
  assert.equal(status, 200);
  assert.equal(body.overall_state, "Alert");
  assert.equal(fake.isMuted("42"), true);
  assert.deepEqual(fake.mutes.get("42"), { end: 2000, scope: "env:prod" });

  // reativar com outro escopo não limpa; all_scopes limpa
  await call("/api/v1/monitor/42/unmute?scope=host%3Aa");
  assert.equal(fake.isMuted("42"), true);
  await call("/api/v1/monitor/42/unmute?all_scopes=true");
  assert.equal(fake.isMuted("42"), false);

  fake.forbidden.add("42");
  assert.equal((await call("/api/v1/monitor/42/mute?end=2000"))[0], 403);
  assert.equal(fake.calls.length, 8);
  await receiver.close();
});

test("monitor silenciado: o estado muda só no provedor (silentChange)", () => {
  const model = createModel([{ monitorId: "1", application: "a", remediation: null }]);
  model.apply("1", "ok", 1);
  model.silentChange("1", "alert");
  assert.equal(model.get("1").state, "ok");
  assert.equal(model.get("1").truth, "alert");
  assert.equal(model.apply("1", "alert", 2), "applied");
  assert.equal(model.get("1").truth, "alert");
});
