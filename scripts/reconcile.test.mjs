import assert from "node:assert/strict";
import { test } from "node:test";
import { EXIT, main, runOnce } from "./reconcile.mjs";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const config = { url: "http://app.test", timeoutMs: 60_000, headers: { "content-type": "application/json" }, body: { dryRun: false } };
const quiet = () => {
  const lines = [];
  return { log: (line) => lines.push(line), lines, sleep: async () => {} };
};

function scripted(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchImpl, calls };
}

test("uso incorreto: sem url, intervalo curto ou tamanho de página inválido saem com 2", async () => {
  const { log, lines } = quiet();
  assert.equal(await main([], {}, { log }), EXIT.usage);
  assert.equal(await main(["--url", "http://x", "--every", "30"], {}, { log }), EXIT.usage);
  assert.equal(await main(["--url", "http://x", "--page-size", "5"], {}, { log }), EXIT.usage);
  assert.match(lines[0], /informe --url/);
  assert.equal(await main(["--help"], {}, { log }), EXIT.ok);
});

test("uma execução concluída: envia as opções e o cabeçalho de identidade e sai com 0", async () => {
  const { log, lines, sleep } = quiet();
  const { fetchImpl, calls } = scripted([json({ id: 9, dryRun: true }, 202), json({ id: 9, status: "running", summary: {} }), json({ id: 9, status: "succeeded", dryRun: true, summary: { seen: 30, pages: 1, corrected: 2, created: 1 } })]);
  const code = await main(["--url", "http://app.test/", "--dry-run", "--no-create", "--tag", "service:a", "--tag", "env:prod", "--page-size", "50"], { AUTH_USER_HEADER: "X-Auth-Request-User" }, { fetchImpl, log, sleep });
  assert.equal(code, EXIT.ok);
  assert.equal(calls[0].url, "http://app.test/api/reconciliation");
  assert.deepEqual(JSON.parse(calls[0].init.body), { provider: "datadog", dryRun: true, createMissing: false, remediate: true, tags: ["service:a", "env:prod"], trigger: "manual", pageSize: 50 });
  assert.equal(calls[0].init.headers["x-auth-request-user"], "reconciler@job");
  assert.equal(calls.length, 3);
  assert.match(lines.at(-1), /#9 succeeded \(simulação\): 30 lidos em 1 páginas, 2 corrigidos, 1 criados/);
});

test("códigos de saída por situação", async () => {
  const run = async (responses, cfg = config) => runOnce(cfg, { ...scripted(responses), ...quiet() });
  const done = (status) => [json({ id: 1 }, 202), json({ id: 1, status, summary: {}, error: status === "failed" ? "boom" : null })];
  assert.equal(await run(done("partial")), EXIT.partial);
  assert.equal(await run(done("failed")), EXIT.failed);
  assert.equal(await run([json({ error: "a reconciliation is already running" }, 409)]), EXIT.busy);
  assert.equal(await run([json({ error: "the provider API is not configured" }, 503)]), EXIT.failed);
  assert.equal(await run([new TypeError("fetch failed")]), EXIT.unreachable);
});

test("falha passageira ao consultar não interrompe; passar do prazo encerra com erro", async () => {
  const ok = await runOnce(config, { ...scripted([json({ id: 2 }, 202), new TypeError("net"), json({ id: 2, status: "succeeded", summary: {} })]), ...quiet() });
  assert.equal(ok, EXIT.ok);
  let clock = 0;
  const slow = scripted([json({ id: 3 }, 202), json({ id: 3, status: "running" }), json({ id: 3, status: "running" })]);
  const code = await runOnce({ ...config, timeoutMs: 5000 }, { ...slow, ...quiet(), now: () => (clock += 4000) });
  assert.equal(code, EXIT.failed);
});

test("modo periódico: repete, marca trigger=schedule e sobrevive a uma falha", async () => {
  const { log, lines, sleep } = quiet();
  const { fetchImpl, calls } = scripted([
    json({ id: 1 }, 202), json({ id: 1, status: "succeeded", summary: {} }),
    new TypeError("fora do ar"),
  ]);
  const code = await main(["--url", "http://app.test", "--every", "60"], {}, { fetchImpl, log, sleep, maxRuns: 2 });
  assert.equal(code, EXIT.ok);
  assert.equal(JSON.parse(calls[0].init.body).trigger, "schedule");
  assert.equal(lines.filter((l) => l.startsWith("próxima execução")).length, 2);
  assert.ok(lines.some((l) => l.includes("não consegui falar")));
});
