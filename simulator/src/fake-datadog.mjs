// Simula a parte da API do Datadog que a aplicação principal usa:
//   POST /api/v1/monitor/{id}/mute|unmute  (silenciar e reativar)
//   GET  /api/v1/monitor                   (listar monitores: página, tamanho e filtro de tags, com cabeçalhos X-RateLimit-*)
// Valida as chaves e devolve `overall_state` como a API documentada. Monitores silenciados não geram
// webhooks (ver scenario.mjs).
export const STATE_NAME = { ok: "OK", warn: "Warn", alert: "Alert", no_data: "No Data" };

export function createFakeDatadog({ apiKey, appKey, getTruth, monitors = () => [], now = () => Date.now() }) {
  const mutes = new Map(); // monitorId -> { end (s), scope }
  const forbidden = new Set(); // monitorIds que respondem 403 (simula permissão negada)
  const calls = []; // { action, monitorId, query }
  // Desvios da listagem, para testar a reconciliação:
  const overrides = new Map(); // monitorId -> overall_state bruto (ex.: "Skipped")
  const hidden = new Set(); // monitorIds que o Datadog não lista mais
  const ghosts = []; // monitores que existem no Datadog e a aplicação nunca viu
  const limit = { max: null, periodMs: 1000, windowStart: 0, count: 0 };
  const stats = { listRequests: 0, rateLimited: 0 };

  const isMuted = (monitorId) => {
    const mute = mutes.get(monitorId);
    return Boolean(mute && mute.end * 1000 > now());
  };

  function listing() {
    const base = monitors()
      .filter((m) => !hidden.has(m.monitorId))
      .map((m) => ({
        id: Number(m.monitorId),
        name: m.name,
        overall_state: overrides.get(m.monitorId) ?? STATE_NAME[getTruth(m.monitorId)],
        tags: [`service:${m.application}`, "env:prod", `team:${m.team}`],
        priority: m.priority,
      }));
    return [...base, ...ghosts];
  }

  function handleList(url, req, res) {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (req.headers["dd-api-key"] !== apiKey || req.headers["dd-application-key"] !== appKey) return send(403, { errors: ["Forbidden"] });
    stats.listRequests += 1;

    let rateHeaders = {};
    if (limit.max !== null) {
      const t = now();
      if (t - limit.windowStart >= limit.periodMs) Object.assign(limit, { windowStart: t, count: 0 });
      const resetSeconds = Math.max(1, Math.ceil((limit.windowStart + limit.periodMs - t) / 1000));
      const headers = (remaining) => ({
        "x-ratelimit-limit": String(limit.max),
        "x-ratelimit-period": String(Math.ceil(limit.periodMs / 1000)),
        "x-ratelimit-remaining": String(remaining),
        "x-ratelimit-reset": String(resetSeconds),
        "x-ratelimit-name": "monitors_read",
      });
      if (limit.count >= limit.max) {
        stats.rateLimited += 1;
        return send(429, { errors: ["Rate limit exceeded"] }, headers(0));
      }
      limit.count += 1;
      rateHeaders = headers(limit.max - limit.count);
    }

    const page = url.searchParams.get("page");
    const pageSize = Number(url.searchParams.get("page_size") ?? 100);
    const wanted = (url.searchParams.get("monitor_tags") ?? "").split(",").filter(Boolean);
    const all = listing().filter((m) => wanted.every((tag) => m.tags.includes(tag)));
    // Sem `page` a API devolve tudo; com `page` (base 0) devolve a fatia.
    const body = page === null ? all : all.slice(Number(page) * pageSize, Number(page) * pageSize + pageSize);
    return send(200, body, rateHeaders);
  }

  function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://fake");
    if (req.method === "GET" && url.pathname === "/api/v1/monitor") return handleList(url, req, res), true;
    const match = /^\/api\/v1\/monitor\/(\d+)\/(mute|unmute)$/.exec(url.pathname);
    if (!match) return false;
    const [, monitorId, action] = match;
    const reply = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    calls.push({ action, monitorId, query: Object.fromEntries(url.searchParams) });
    if (req.method !== "POST") return reply(405, { errors: ["Method not allowed"] }), true;
    if (req.headers["dd-api-key"] !== apiKey || req.headers["dd-application-key"] !== appKey || forbidden.has(monitorId)) {
      return reply(403, { errors: ["Forbidden"] }), true;
    }
    const truth = getTruth(monitorId);
    if (truth === undefined) return reply(404, { errors: [`Monitor ${monitorId} not found`] }), true;

    const scope = url.searchParams.get("scope");
    if (action === "mute") {
      const end = Number(url.searchParams.get("end"));
      if (!Number.isInteger(end) || end * 1000 <= now()) return reply(400, { errors: ["end must be a POSIX timestamp in the future"] }), true;
      mutes.set(monitorId, { end, scope });
    } else if (url.searchParams.get("all_scopes") === "true" || (mutes.get(monitorId)?.scope ?? null) === scope) {
      mutes.delete(monitorId);
    }
    return reply(200, { id: Number(monitorId), name: `monitor ${monitorId}`, overall_state: overrides.get(monitorId) ?? STATE_NAME[truth] }), true;
  }

  return {
    handle,
    isMuted,
    mutes,
    forbidden,
    calls,
    overrides,
    hidden,
    ghosts,
    stats,
    /** Liga o limite de uso: `max` requisições por janela de `periodMs`. */
    setRateLimit: (max, periodMs = 1000) => Object.assign(limit, { max, periodMs, windowStart: 0, count: 0 }),
    /** Esgota a janela atual: a próxima requisição leva 429. */
    exhaustRateLimit: () => Object.assign(limit, { windowStart: now(), count: limit.max ?? 0 }),
    clearRateLimit: () => Object.assign(limit, { max: null }),
  };
}
