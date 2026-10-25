import { parseArgs } from "node:util";
import { generateCatalog } from "./catalog.mjs";
import { createClient } from "./client.mjs";
import { buildWebhookPayload } from "./datadog.mjs";
import { createModel } from "./model.mjs";
import { createFakeDatadog } from "./fake-datadog.mjs";
import { startReceiver } from "./receiver.mjs";
import { createRng } from "./rng.mjs";
import { reconcileScenario } from "./reconcile-scenario.mjs";
import { CALM_WEIGHTS, churn, createJourneys, healthRound, muteScenario, seed, verify } from "./scenario.mjs";
import { multiSourceScenario } from "./sources.mjs";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    target: { type: "string", default: process.env.TARGET_URL ?? "http://localhost:3000" },
    apps: { type: "string", default: "32" },
    alerts: { type: "string", default: "200" },
    events: { type: "string", default: "1500" },
    seed: { type: "string", default: "42" },
    "receiver-port": { type: "string", default: process.env.RECEIVER_PORT ?? "9100" },
    "receiver-url": { type: "string", default: process.env.RECEIVER_PUBLIC_URL ?? "http://localhost:9100" },
    // stream: pausa entre rodadas (ms) e monitores alterados por rodada; run: 12 em paralelo.
    interval: { type: "string", default: "1500" },
    workers: { type: "string" },
  },
});

const required = (name) => {
  const value = process.env[name];
  if (!value) {
    console.error(`missing environment variable ${name}`);
    process.exit(2);
  }
  return value;
};
const log = (message) => console.log(`[simulator] ${message}`);
const command = positionals[0] ?? "run";

const catalog = generateCatalog({
  apps: Number(values.apps),
  alerts: Number(values.alerts),
  seed: Number(values.seed),
  // Ids de monitor únicos por execução: reexecutar não colide com dados antigos.
  idBase: Number(process.env.MONITOR_ID_BASE ?? Date.now() % 1_000_000_000) * 1000,
});
const client = createClient({
  baseUrl: values.target,
  webhookSecret: required("DATADOG_WEBHOOK_SECRET"),
});
const model = createModel(catalog.monitors);
const fake = createFakeDatadog({ apiKey: required("DD_API_KEY"), appKey: required("DD_APP_KEY"), getTruth: (id) => model.get(id)?.truth, monitors: () => catalog.monitors });
const receiver = await startReceiver({ port: Number(values["receiver-port"]), token: required("SIMULATOR_REMEDIATION_TOKEN"), extraHandler: fake.handle });
log(`catalog: ${catalog.applications.length} applications, ${catalog.monitors.length} monitors; receiver on :${receiver.port}`);
await client.waitHealthy();

const hadData = ((await client.applications()).json?.applications ?? []).length > 0;
const problems = await seed({ client, catalog, receiverUrl: values["receiver-url"], log });

// Estado inicial de cada monitor: cria por webhook os que ainda não existem.
const rng = createRng(Number(values.seed));
for (const monitor of catalog.monitors) {
  const state = rng.weighted(command === "stream" ? CALM_WEIGHTS : [["ok", 6], ["warn", 2], ["alert", 2], ["no_data", 1]]);
  const at = Date.now();
  const expected = model.apply(monitor.monitorId, state, at);
  const r = await client.sendWebhook(buildWebhookPayload(monitor, state, { at }));
  if (r.status !== 200 || r.json?.status !== expected) problems.push(`initial ${monitor.monitorId}: ${r.status} ${r.json?.status}, want ${expected}`);
}
log(`initial state sent for ${catalog.monitors.length} monitors`);
problems.push(...(await createJourneys({ client, catalog, log })));

if (command === "stream") {
  // Modo demonstração: dinâmica de saúde contínua, em ritmo humano (~1 mudança por segundo ou menos).
  // Divergências do oráculo são esperadas quando já existem dados de execuções anteriores.
  const pause = Number(values.interval);
  const streamRng = createRng(Date.now() % 2147483647);
  log(`streaming health changes every ${pause} ms until stopped (${catalog.monitors.length} monitors)`);
  let rounds = 0;
  let sent = 0;
  for (;;) {
    try {
      sent += await healthRound({ client, catalog, model, rng: streamRng, isMuted: fake.isMuted });
    } catch (error) {
      log(`round failed (${error instanceof Error ? error.message : "error"}); retrying`);
      await new Promise((r) => setTimeout(r, 5000));
    }
    rounds += 1;
    // Se a aplicação principal teve os dados zerados (down -v) com o demo rodando, repõe alertas, estados e jornadas.
    try {
      if (rounds % 10 === 0 && ((await client.journeys()).json?.journeys ?? []).length < catalog.journeys.length) {
        log("main application lost its journeys; seeding again");
        await seed({ client, catalog, receiverUrl: values["receiver-url"], log: () => {} });
        for (const monitor of catalog.monitors) {
          const { state, lastTs } = model.get(monitor.monitorId);
          const at = Math.max(Date.now(), (lastTs ?? 0) + 1);
          model.apply(monitor.monitorId, state, at);
          await client.sendWebhook(buildWebhookPayload(monitor, state, { at }));
        }
        await createJourneys({ client, catalog, log });
      }
    } catch (error) {
      log(`resync failed (${error instanceof Error ? error.message : "error"}); retrying`);
    }
    if (rounds % 40 === 0) log(`${sent} state changes sent so far`);
    await new Promise((r) => setTimeout(r, pause));
  }
}

problems.push(...(await churn({ client, catalog, model, events: Number(values.events), seed: Number(values.seed), log, workers: Number(values.workers ?? 12) })));
const muting = await muteScenario({ client, catalog, model, fake, log });
problems.push(...muting.problems);
const reconciling = await reconcileScenario({ client, catalog, model, fake, log, strict: !hadData });
problems.push(...reconciling.problems);
problems.push(...(await verify({ client, catalog, model, receiver, log, appLevel: !hadData, stillMuted: muting.stillMuted, extraUnassigned: reconciling.ghostApplications })));
// Outras fontes: depois da verificação geral, porque criam alertas em aplicações próprias (src-<fonte>-N).
problems.push(
  ...(await multiSourceScenario({
    client,
    log,
    secrets: { cloudwatch: process.env.CLOUDWATCH_WEBHOOK_SECRET, appdynamics: process.env.APPDYNAMICS_WEBHOOK_SECRET, generic: process.env.GENERIC_WEBHOOK_SECRET },
  })),
);
await receiver.close();

if (problems.length) {
  console.error(`\n[simulator] FAILED with ${problems.length} divergences (first 20):`);
  problems.slice(0, 20).forEach((p) => console.error(` - ${p}`));
  process.exit(1);
}
log("OK: the main application matches the oracle");
