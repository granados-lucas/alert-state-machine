import { createServer } from "node:http";

// Destino de remediação falso: registra o que a aplicação principal chama.
// /remediate/hook (webhook padrão), /remediate/api (exige Authorization) e /remediate/flaky (sempre 503).
export function startReceiver({ port, token, extraHandler }) {
  const calls = []; // { kind, monitorId, authorized }
  const server = createServer((req, res) => {
    const send = (status, body = {}) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (extraHandler?.(req, res)) return;
    if (req.method === "GET" && req.url === "/health") return send(200, { ok: true });
    if (req.method === "GET" && req.url === "/calls") return send(200, calls);
    const kind = /^\/remediate\/(hook|api|flaky)$/.exec(req.url ?? "")?.[1];
    if (req.method !== "POST" || !kind) return send(404);
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        return send(400);
      }
      const name = typeof body.alert === "string" ? body.alert : body.alert?.name;
      const monitorId = /#(\d+)$/.exec(name ?? "")?.[1] ?? null;
      const authorized = kind !== "api" || req.headers.authorization === token;
      calls.push({ kind, monitorId, authorized });
      if (!authorized) return send(401);
      send(kind === "flaky" ? 503 : 200, { received: true });
    });
  });
  return new Promise((resolve) => {
    server.listen(port, "0.0.0.0", () => resolve({ calls, port: server.address().port, close: () => new Promise((r) => server.close(r)) }));
  });
}
