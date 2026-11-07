import assert from "node:assert/strict";
import { test } from "node:test";
import { EXIT, main, runOnce } from "./evaluate-combinations.mjs";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
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

test("uso incorreto: sem url ou com intervalo menor que 10 s sai com 2; --help sai com 0", async () => {
  const { log, lines } = quiet();
  assert.equal(await main([], {}, { log }), EXIT.usage);
  assert.match(lines[0], /informe --url/);
  assert.equal(await main(["--url", "http://x", "--every", "5"], {}, { log }), EXIT.usage);
  assert.equal(await main(["--url", "http://x", "--every", "abc"], {}, { log }), EXIT.usage);
  assert.equal(await main(["--help"], {}, { log }), EXIT.ok);
});

test("uma execução chama POST /api/combinations/evaluate com a identidade e sai com 0", async () => {
  const { log, lines } = quiet();
  const { fetchImpl, calls } = scripted([json({ evaluated: 4, changed: 1 })]);
  const code = await main(["--url", "http://app.test/"], { AUTH_USER_HEADER: "X-Auth-Request-User" }, { fetchImpl, log });
  assert.equal(code, EXIT.ok);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://app.test/api/combinations/evaluate");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["x-auth-request-user"], "combination-evaluator@job");
  assert.match(lines.join("\n"), /avaliadas 4, mudaram 1/);
});

test("a url também pode vir de EVALUATE_URL", async () => {
  const { log } = quiet();
  const { fetchImpl, calls } = scripted([json({ evaluated: 0, changed: 0 })]);
  assert.equal(await main([], { EVALUATE_URL: "http://env.test" }, { fetchImpl, log }), EXIT.ok);
  assert.equal(calls[0].url, "http://env.test/api/combinations/evaluate");
});

test("resposta de erro sai com 1 e rede fora sai com 4", async () => {
  const { log } = quiet();
  const config = { url: "http://app.test", headers: {} };
  assert.equal(await runOnce(config, { fetchImpl: scripted([json({ error: "internal error" }, 500)]).fetchImpl, log }), EXIT.failed);
  assert.equal(await runOnce(config, { fetchImpl: scripted([new Error("ECONNREFUSED")]).fetchImpl, log }), EXIT.unreachable);
});

test("modo periódico continua depois de uma falha de rede e para em maxRuns", async () => {
  const { log, sleep, lines } = quiet();
  const { fetchImpl, calls } = scripted([new Error("ECONNREFUSED"), json({ evaluated: 2, changed: 0 })]);
  const code = await main(["--url", "http://app.test", "--every", "10"], {}, { fetchImpl, log, sleep, maxRuns: 2 });
  assert.equal(code, EXIT.ok);
  assert.equal(calls.length, 2);
  assert.match(lines.join("\n"), /não consegui falar com/);
  assert.match(lines.join("\n"), /avaliadas 2/);
});

test("avisa no log quando alguma combinação falhou na avaliação", async () => {
  const { log, lines } = quiet();
  const { fetchImpl } = scripted([json({ evaluated: 3, changed: 0, failed: 2 })]);
  assert.equal(await main(["--url", "http://app.test"], {}, { fetchImpl, log }), EXIT.ok);
  assert.match(lines.join("\n"), /avaliadas 3, mudaram 0, FALHARAM 2/);
});
