#!/usr/bin/env node
// Dispara a reconciliação com o Datadog na aplicação (POST /api/reconciliation) e espera o resultado.
// Sem dependências: roda com Node 18+ em cron, Kubernetes CronJob, GitHub Actions ou no compose.
//
//   node scripts/reconcile.mjs --url http://localhost:3000            # uma execução
//   node scripts/reconcile.mjs --url http://app:3000 --every 300      # repete a cada 5 min
//   node scripts/reconcile.mjs --dry-run --tag service:checkout       # só simula, só um serviço
//
// Códigos de saída (modo uma execução): 0 concluída · 1 falhou · 2 uso incorreto · 3 parcial
// (tempo/páginas esgotados) · 4 aplicação inacessível · 5 já havia uma execução em andamento.
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

export const EXIT = { ok: 0, failed: 1, usage: 2, partial: 3, unreachable: 4, busy: 5 };

const OPTIONS = {
  url: { type: "string" },
  provider: { type: "string", default: "datadog" },
  "dry-run": { type: "boolean", default: false },
  "no-create": { type: "boolean", default: false },
  "no-remediate": { type: "boolean", default: false },
  tag: { type: "string", multiple: true, default: [] },
  "page-size": { type: "string" },
  every: { type: "string" },
  timeout: { type: "string", default: "1800" },
  identity: { type: "string", default: "reconciler@job" },
  "identity-header": { type: "string" },
  help: { type: "boolean", default: false },
};

export const HELP = `Uso: node scripts/reconcile.mjs --url <http://app:3000> [opções]
  --provider datadog        provedor (padrão datadog)
  --dry-run                 só simula: relata o que mudaria
  --no-create               não cria alertas para monitores novos
  --no-remediate            não executa remediações dos alertas corrigidos
  --tag service:x           filtra por tag do Datadog (repetível)
  --page-size 100           monitores por página (10 a 1000)
  --every 300               repete a cada N segundos (mín. 60); sem isso roda uma vez
  --timeout 1800            segundos esperando uma execução terminar
  --identity reconciler@job valor do cabeçalho de identidade (auditoria)
  --identity-header NAME    cabeçalho de identidade (padrão: AUTH_USER_HEADER ou x-forwarded-email)
Variáveis: RECONCILE_URL, AUTH_USER_HEADER.`;

function parse(argv, env) {
  const { values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false });
  const url = values.url ?? env.RECONCILE_URL;
  const every = values.every === undefined ? null : Number(values.every);
  if (values.help) return { help: true };
  if (!url) throw new Error("informe --url (ou RECONCILE_URL)");
  if (every !== null && (!Number.isFinite(every) || every < 60)) throw new Error("--every precisa ser um número de segundos >= 60");
  const pageSize = values["page-size"] === undefined ? undefined : Number(values["page-size"]);
  if (pageSize !== undefined && !(pageSize >= 10 && pageSize <= 1000)) throw new Error("--page-size deve estar entre 10 e 1000");
  return {
    url: url.replace(/\/+$/, ""),
    every,
    timeoutMs: Number(values.timeout) * 1000,
    headers: {
      "content-type": "application/json",
      [(values["identity-header"] ?? env.AUTH_USER_HEADER ?? "x-forwarded-email").toLowerCase()]: values.identity,
    },
    body: {
      provider: values.provider,
      dryRun: values["dry-run"],
      createMissing: !values["no-create"],
      remediate: !values["no-remediate"],
      tags: values.tag,
      trigger: every === null ? "manual" : "schedule",
      ...(pageSize === undefined ? {} : { pageSize }),
    },
  };
}

function describe(run) {
  const s = run.summary ?? {};
  return `#${run.id} ${run.status}${run.dryRun ? " (simulação)" : ""}: ${s.seen ?? 0} lidos em ${s.pages ?? 0} páginas, ${s.corrected ?? 0} corrigidos, ${s.created ?? 0} criados, ${s.inSync ?? 0} em dia, ${s.kept ?? 0} mantidos, ${s.missing ?? 0} ausentes, ${s.rateLimited ?? 0}x limite de uso${run.error ? ` | ${run.error}` : ""}`;
}

/** Uma execução: inicia, acompanha até terminar e devolve o código de saída. */
export async function runOnce(config, { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log, now = Date.now } = {}) {
  let started;
  try {
    started = await fetchImpl(`${config.url}/api/reconciliation`, { method: "POST", headers: config.headers, body: JSON.stringify(config.body) });
  } catch {
    log(`erro: não consegui falar com ${config.url}`);
    return EXIT.unreachable;
  }
  const payload = await started.json().catch(() => ({}));
  if (started.status === 409) {
    log("já existe uma reconciliação em andamento; nada a fazer agora");
    return EXIT.busy;
  }
  if (started.status !== 202) {
    log(`erro: a aplicação respondeu ${started.status}: ${payload.error ?? JSON.stringify(payload)}`);
    return EXIT.failed;
  }
  log(`execução #${payload.id} iniciada${payload.dryRun ? " (simulação)" : ""}`);
  const deadline = now() + config.timeoutMs;
  for (;;) {
    await sleep(3000);
    let run;
    try {
      const res = await fetchImpl(`${config.url}/api/reconciliation/${payload.id}`);
      run = await res.json();
    } catch {
      log("aviso: falha ao consultar a execução; tentando de novo");
      if (now() > deadline) return EXIT.unreachable;
      continue;
    }
    if (run.status && run.status !== "running") {
      log(describe(run));
      return run.status === "succeeded" ? EXIT.ok : run.status === "partial" ? EXIT.partial : EXIT.failed;
    }
    if (now() > deadline) {
      log(`erro: a execução #${payload.id} não terminou em ${Math.round(config.timeoutMs / 1000)} s (segue rodando no servidor)`);
      return EXIT.failed;
    }
  }
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

  // Modo periódico: uma falha não derruba o laço; SIGTERM/SIGINT encerram entre as execuções.
  let stop = false;
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => (stop = true));
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  log(`reconciliação periódica a cada ${config.every} s (Ctrl+C para parar)`);
  while (!stop) {
    const code = await runOnce(config, deps);
    log(`próxima execução em ${config.every} s (última saiu com código ${code})`);
    for (let waited = 0; waited < config.every && !stop; waited += 1) await sleep(1000);
    if (deps.maxRuns !== undefined && --deps.maxRuns <= 0) break;
  }
  return EXIT.ok;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
