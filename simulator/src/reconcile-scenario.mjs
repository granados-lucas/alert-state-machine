// Equivalência esperada (oráculo próprio, independente do código da aplicação).
const EQUIVALENT = { OK: "ok", Warn: "warn", Alert: "alert", "No Data": "no_data", Unknown: "no_data" }; // Skipped/Ignored: mantém

async function waitForRun(client, id, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { json } = await client.reconciliationRun(id);
    if (json?.status && json.status !== "running") return json;
    if (Date.now() > deadline) throw new Error(`reconciliation #${id} did not finish in ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Reconciliação contra o Datadog simulado: o Datadog "mudou" sem webhook (monitores silenciados, webhook
 * perdido), listou estados sem equivalente (Skipped, Ignored), um estado Unknown, monitores que a aplicação
 * nunca viu e deixou de listar um monitor. Roda uma simulação, a execução real (com limite de uso
 * forçado: o 1º pedido leva 429) e uma terceira execução, que não deve encontrar mais nada.
 */
export async function reconcileScenario({ client, catalog, model, fake, log, strict }) {
  const problems = [];
  const monitors = catalog.monitors;
  const picks = monitors.filter((_, i) => i % 17 === 3).slice(0, 8);
  const differentState = (s) => (s === "alert" ? "ok" : "alert");

  // 1. Desvios: 4 mudanças silenciosas (sem webhook), Skipped, Unknown, Ignored e 1 monitor que sumiu do Datadog.
  for (const m of picks.slice(0, 4)) model.silentChange(m.monitorId, differentState(model.get(m.monitorId).state));
  fake.overrides.set(picks[4].monitorId, "Skipped");
  fake.overrides.set(picks[5].monitorId, "Unknown");
  fake.overrides.set(picks[6].monitorId, "Ignored");
  fake.hidden.add(picks[7].monitorId);
  const base = Number(monitors[monitors.length - 1].monitorId) + 5000;
  const ghostStates = ["Alert", "OK", "Skipped"];
  ghostStates.forEach((overall_state, i) =>
    fake.ghosts.push({ id: base + i, name: `ghost: monitor desconhecido #${base + i}`, overall_state, tags: ["service:ghost-app", "env:prod"], priority: null }),
  );

  // 2. O que deve acontecer, segundo o oráculo.
  const expected = { corrected: 0, inSync: 0, kept: 0, created: ghostStates.length, missing: fake.hidden.size };
  const plan = [];
  for (const m of monitors) {
    if (fake.hidden.has(m.monitorId)) continue;
    const raw = fake.overrides.get(m.monitorId) ?? { ok: "OK", warn: "Warn", alert: "Alert", no_data: "No Data" }[model.get(m.monitorId).truth];
    const state = EQUIVALENT[raw];
    if (state === undefined) expected.kept += 1;
    else if (state !== model.get(m.monitorId).state) {
      expected.corrected += 1;
      plan.push([m.monitorId, state]);
    } else expected.inSync += 1;
  }

  const check = (label, summary, want) => {
    for (const [key, value] of Object.entries(want)) {
      if (summary[key] !== value && !(key === "missing" && !strict && summary.missing >= value)) problems.push(`${label}: ${key} = ${summary[key]}, want ${value}`);
    }
  };
  const alertsByExternal = async () => new Map((await client.listAllAlerts()).filter((a) => a.provider === "datadog").map((a) => [a.externalId, a]));

  // 3. Simulação: relata e não muda nada.
  fake.setRateLimit(4, 1000);
  const dry = await client.startReconciliation({ dryRun: true, pageSize: 25 });
  if (dry.status !== 202) problems.push(`dry-run start: ${dry.status} ${JSON.stringify(dry.json)}`);
  const dryRun = await waitForRun(client, dry.json.id);
  if (dryRun.status !== "succeeded" || !dryRun.dryRun) problems.push(`dry-run: status ${dryRun.status} ${dryRun.error ?? ""}`);
  check("dry-run", dryRun.summary, { corrected: expected.corrected, created: expected.created, kept: expected.kept, missing: expected.missing });
  const afterDry = await alertsByExternal();
  if (afterDry.has(String(fake.ghosts[0].id))) problems.push("dry-run must not create alerts");
  if (plan.length && afterDry.get(plan[0][0])?.state !== model.get(plan[0][0]).state) problems.push("dry-run must not change states");

  // 4. Execução real, com o primeiro pedido barrado pelo limite de uso (429).
  fake.exhaustRateLimit();
  const real = await client.startReconciliation({ pageSize: 25 });
  if (real.status !== 202) problems.push(`start: ${real.status} ${JSON.stringify(real.json)}`);
  const second = await client.startReconciliation({ pageSize: 25 });
  if (second.status !== 409) problems.push(`second concurrent start: ${second.status}, want 409`);
  const run = await waitForRun(client, real.json.id);
  if (run.status !== "succeeded") problems.push(`run: status ${run.status} ${run.error ?? ""}`);
  check("run", run.summary, expected);
  if ((run.summary.rateLimited ?? 0) < 1) problems.push("run: expected at least one 429 absorbed");
  if (!run.rateLimit?.limit) problems.push("run: rate limit headers were not recorded");
  for (const [id, state] of plan) model.apply(id, state, Date.now());

  // 5. Os alertas novos existem com o estado equivalente; o monitor que sumiu continua ativo.
  const final = await alertsByExternal();
  const wantGhost = ["alert", "ok", "no_data"];
  fake.ghosts.forEach((g, i) => {
    const got = final.get(String(g.id));
    if (!got || got.state !== wantGhost[i]) problems.push(`ghost ${g.id}: ${got?.state ?? "missing"}, want ${wantGhost[i]}`);
  });
  const vanished = final.get(picks[7].monitorId);
  if (!vanished || vanished.archivedAt) problems.push("missing monitor must stay active (reported, never archived)");

  // 6. Terceira execução: nada mais a corrigir.
  fake.clearRateLimit();
  const again = await client.startReconciliation({ pageSize: 25 });
  const third = await waitForRun(client, again.json.id);
  check("third run", third.summary, { corrected: 0, created: 0, kept: expected.kept + 1 });

  const runs = await client.listReconciliations();
  if ((runs.json?.runs?.length ?? 0) < 3) problems.push("reconciliation history should list the three runs");
  log(`reconciliation: dry-run + real run (${run.summary.corrected} corrected, ${run.summary.created} created, ${run.summary.kept} kept, ${run.summary.missing} missing, ${run.summary.rateLimited}x 429) + idempotent re-run`);
  return { problems, ghostApplications: ["ghost-app"] };
}
