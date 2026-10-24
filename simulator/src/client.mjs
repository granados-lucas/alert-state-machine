// Cliente HTTP da aplicação principal. É a única ligação do simulador com ela.
export function createClient({ baseUrl, webhookSecret }) {
  const url = (path) => new URL(path, baseUrl).toString();
  // O SSO corporativo diria quem somos; aqui o simulador se identifica no cabeçalho de identidade.
const admin = { "content-type": "application/json", "x-forwarded-email": "simulator@local" };

  async function call(path, init) {
    const response = await fetch(url(path), init);
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* corpo não JSON */
    }
    return { status: response.status, json };
  }

  return {
    async waitHealthy(timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        try {
          if ((await call("/api/health")).status === 200) return;
        } catch {
          /* ainda subindo */
        }
        if (Date.now() > deadline) throw new Error(`${baseUrl} did not become healthy in ${timeoutMs} ms`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    },
    registerAlert: (body) => call("/api/alerts", { method: "POST", headers: admin, body: JSON.stringify(body) }),
    createJourney: (body) => call("/api/journeys", { method: "POST", headers: admin, body: JSON.stringify(body) }),
    muteAlert: (id, body) => call(`/api/alerts/${id}/mute`, { method: "POST", headers: admin, body: JSON.stringify(body) }),
    unmuteAlert: (id, body) => call(`/api/alerts/${id}/unmute`, { method: "POST", headers: admin, body: JSON.stringify(body) }),
    startReconciliation: (body) => call("/api/reconciliation", { method: "POST", headers: admin, body: JSON.stringify(body) }),
    reconciliationRun: (id) => call(`/api/reconciliation/${id}`, { headers: admin }),
    listReconciliations: () => call("/api/reconciliation", { headers: admin }),
    journeys: () => call("/api/journeys", { headers: admin }),
    sendWebhook: (payload, { secret = webhookSecret, raw } = {}) =>
      call("/api/webhooks/datadog", {
        method: "POST",
        headers: { "content-type": "application/json", "x-webhook-secret": secret },
        body: raw ?? JSON.stringify(payload),
      }),
    applications: () => call("/api/applications", { headers: admin }),
    alertDetail: (id) => call(`/api/alerts/${id}`, { headers: admin }),
    async listAllAlerts() {
      const items = [];
      let before;
      do {
        const query = new URLSearchParams({ limit: "200", ...(before ? { before: String(before) } : {}) });
        const { status, json } = await call(`/api/alerts?${query}`, { headers: admin });
        if (status !== 200) throw new Error(`GET /api/alerts returned ${status}`);
        items.push(...json.items);
        before = json.nextCursor;
      } while (before);
      return items;
    },
  };
}
