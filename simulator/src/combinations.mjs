// Cenário de combinações: um alerta "comportamental" (genérico) e um de "métrica" (AppDynamics) formam uma combinação E com
// duração. Confere pending, alert (com a automação), a normalização (com a automação) e que um alerta que cai antes da
// duração zera a contagem sem disparar nada. Só usa a API HTTP da aplicação principal e o receptor do simulador.
import { SOURCES } from "./sources.mjs";

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function combinationScenario({
  client,
  receiver,
  receiverUrl,
  secret,
  log,
  runId = Date.now(),
  durationSeconds = 4,
  waitMs = 15_000,
  sleepFn = realSleep,
}) {
  const problems = [];
  const fail = (message) => problems.push(`combination: ${message}`);
  let clock = Date.now();
  let n = 0;

  async function send(source, alarm, state) {
    clock += 1000;
    const def = SOURCES[source];
    const body = JSON.stringify(def.payload(alarm, state, clock, `${source}-combo-${runId}-${++n}`));
    const r = await client.sendTo(body, def.headers(secret));
    if (r.status !== 200) fail(`${alarm.name} -> ${state}: webhook answered ${r.status}`);
    return r.json?.alertId;
  }
  async function waitFor(check) {
    const deadline = Date.now() + waitMs;
    for (;;) {
      if (await check()) return true;
      if (Date.now() > deadline) return false;
      await sleepFn(250);
    }
  }

  const behavior = { name: `sim-combo-behavior-${runId}`, application: "src-combo-behavior", priority: 1 };
  const metric = { name: `sim-combo-metric-${runId}`, application: "src-combo-metric", priority: 2 };
  const a = await send("generic", behavior, "ok");
  const b = await send("appdynamics", metric, "ok");
  const name = `sim-combo-${runId}`;
  const created = await client.createCombination({
    name,
    rule: "and",
    alertIds: [a, b],
    durationSeconds,
    automations: [{ name: "sim", mode: "webhook", url: `${receiverUrl}/remediate/combination`, triggerStates: ["alert", "ok"] }],
  });
  if (created.status !== 201) {
    fail(`creating the combination answered ${created.status} ${JSON.stringify(created.json)}`);
    return problems;
  }
  const id = created.json.id;
  const stateOf = async () => (await client.combination(id)).json?.state;
  const calls = () => receiver.calls.filter((c) => c.combination?.name === name);
  const expectState = async (want, when) => {
    const got = await stateOf();
    if (got !== want) fail(`${when}: state ${got}, want ${want}`);
  };

  await expectState("ok", "created with both alerts ok");
  await send("generic", behavior, "alert");
  await expectState("ok", "only one of two alerts alerting (rule and)");
  await send("appdynamics", metric, "alert");
  await expectState("pending", "both alerting, duration not met");
  if (calls().length !== 0) fail("the automation fired while pending");

  await sleepFn((durationSeconds + 1) * 1000);
  await client.evaluateCombinations();
  await expectState("alert", "duration met");
  if (!(await waitFor(() => calls().length >= 1)) || calls()[0].combination.state !== "alert") fail("automation for the alert transition was not received");

  await send("appdynamics", metric, "ok");
  await expectState("ok", "after one alert recovered");
  if (!(await waitFor(() => calls().length >= 2)) || calls()[1]?.combination.state !== "ok") fail("automation for the normalization was not received");

  // Cai antes da duração: contagem zera e nenhuma automação sai.
  await send("appdynamics", metric, "alert");
  await expectState("pending", "alerting again (new count)");
  await sleepFn(1000);
  await send("appdynamics", metric, "ok");
  await expectState("ok", "recovered before the duration");
  await sleepFn((durationSeconds + 1) * 1000);
  await client.evaluateCombinations();
  await expectState("ok", "after the old duration would have elapsed");
  await sleepFn(Math.min(waitMs, 500));
  if (calls().length !== 2) fail(`${calls().length} automation calls in total, want 2 (alert and ok)`);

  log(`combination scenario: ${problems.length === 0 ? "ok" : `${problems.length} problem(s)`} (${calls().length} automation calls)`);
  return problems;
}
