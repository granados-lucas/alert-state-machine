#!/usr/bin/env node
// Reavalia as combinações de alertas na aplicação (POST /api/combinations/evaluate). É o relógio que faz a duração
// ("os 2 alertando por 2 minutos") completar sem evento novo e que percebe o fim de um silêncio.
// Sem dependências: roda com Node 18+ no compose, em Kubernetes ou como serviço.
//
//   node scripts/evaluate-combinations.mjs --url http://localhost:3000           # uma execução
//   node scripts/evaluate-combinations.mjs --url http://app:3000 --every 30      # repete a cada 30 s
//
// Códigos de saída (modo uma execução): 0 concluída · 1 a aplicação respondeu erro · 2 uso incorreto ·
// 4 aplicação inacessível.
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

export const EXIT = { ok: 0, failed: 1, usage: 2, unreachable: 4 };

const OPTIONS = {
  url: { type: "string" },
  every: { type: "string" },
  identity: { type: "string", default: "combination-evaluator@job" },
  "identity-header": { type: "string" },
  help: { type: "boolean", default: false },
};

export const HELP = `Uso: node scripts/evaluate-combinations.mjs --url <http://app:3000> [opções]
  --every 30                repete a cada N segundos (mín. 10); sem isso roda uma vez
  --identity NOME           valor do cabeçalho de identidade (auditoria)
  --identity-header NAME    cabeçalho de identidade (padrão: AUTH_USER_HEADER ou x-forwarded-email)
Variáveis: EVALUATE_URL, AUTH_USER_HEADER.`;

function parse(argv, env) {
  const { values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false });
  if (values.help) return { help: true };
  const url = values.url ?? env.EVALUATE_URL;
  if (!url) throw new Error("informe --url (ou EVALUATE_URL)");
  const every = values.every === undefined ? null : Number(values.every);
  if (every !== null && (!Number.isFinite(every) || every < 10)) throw new Error("--every precisa ser um número de segundos >= 10");
  return {
    url: url.replace(/\/+$/, ""),
    every,
    headers: { [(values["identity-header"] ?? env.AUTH_USER_HEADER ?? "x-forwarded-email").toLowerCase()]: values.identity },
  };
}

/** Um ciclo: pede a reavaliação e devolve o código de saída. */
export async function runOnce(config, { fetchImpl = fetch, log = console.log } = {}) {
  let response;
  try {
    response = await fetchImpl(`${config.url}/api/combinations/evaluate`, { method: "POST", headers: config.headers });
  } catch {
    log(`erro: não consegui falar com ${config.url}`);
    return EXIT.unreachable;
  }
  const body = await response.json().catch(() => ({}));
  if (response.status !== 200) {
    log(`erro: a aplicação respondeu ${response.status}: ${body.error ?? JSON.stringify(body)}`);
    return EXIT.failed;
  }
  log(`avaliadas ${body.evaluated ?? 0}, mudaram ${body.changed ?? 0}`);
  return EXIT.ok;
}

export async function main(argv, env = process.env, deps = {}) {
  const log = deps.log ?? console.log;
  let config;
  try {
    config = parse(argv, env);
  } catch (error) {
    log(`erro: ${error.message}\n\n${HELP}`);
    return EXIT.usage;
  }
  if (config.help) {
    log(HELP);
    return EXIT.ok;
  }
  if (config.every === null) return runOnce(config, deps);

  // Modo periódico: uma falha não derruba o laço; SIGTERM/SIGINT encerram entre os ciclos.
  let stop = false;
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => (stop = true));
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  log(`avaliação periódica a cada ${config.every} s (Ctrl+C para parar)`);
  while (!stop) {
    await runOnce(config, deps);
    for (let waited = 0; waited < config.every && !stop; waited += 1) await sleep(1000);
    if (deps.maxRuns !== undefined && --deps.maxRuns <= 0) break;
  }
  return EXIT.ok;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
