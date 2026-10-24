// Simula a parte da API do Datadog que a aplicação principal usa: silenciar e reativar monitores
// (POST /api/v1/monitor/{id}/mute|unmute). Valida as chaves, o prazo e devolve o monitor com
// `overall_state`, como a API documentada. Monitores silenciados não geram webhooks (ver scenario.mjs).
const STATE_NAME = { ok: "OK", warn: "Warn", alert: "Alert", no_data: "No Data" };

export function createFakeDatadog({ apiKey, appKey, getTruth, now = () => Date.now() }) {
  const mutes = new Map(); // monitorId -> { end (s), scope }
  const forbidden = new Set(); // monitorIds que respondem 403 (simula permissão negada)
  const calls = []; // { action, monitorId, query }

  const isMuted = (monitorId) => {
    const mute = mutes.get(monitorId);
    return Boolean(mute && mute.end * 1000 > now());
  };

  function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://fake");
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
    return reply(200, { id: Number(monitorId), name: `monitor ${monitorId}`, overall_state: STATE_NAME[truth] }), true;
  }

  return { handle, isMuted, mutes, forbidden, calls };
}
