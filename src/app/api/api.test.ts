import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { alerts, muteOperations, remediationRuns } from "@/db/schema";
import { createTestDb } from "@/test/db";
import type { Db } from "@/server/db-types";

let db: Db;
let close: () => Promise<void>;
vi.mock("server-only", () => ({}));
vi.mock("@/db", () => ({ getDb: () => db, poolStats: () => null }));
vi.mock("@/lib/logger", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger };
  return { logger };
});

const SECRET = "datadog-secret-0123456789";

const webhook = await import("./webhooks/[provider]/route");
const health = await import("./health/route");
const alertsRoute = await import("./alerts/route");
const alertRoute = await import("./alerts/[id]/route");
const remediationsRoute = await import("./alerts/[id]/remediations/route");
const remediationRoute = await import("./alerts/[id]/remediations/[remediationId]/route");
const applicationsRoute = await import("./applications/route");
const muteRoute = await import("./alerts/[id]/mute/route");
const unmuteRoute = await import("./alerts/[id]/unmute/route");
const muteOperationsRoute = await import("./mute-operations/route");
const muteOperationsRecoverRoute = await import("./mute-operations/recover/route");
const reconciliationRoute = await import("./reconciliation/route");
const reconciliationRunRoute = await import("./reconciliation/[id]/route");
const journeysRoute = await import("./journeys/route");
const journeyRoute = await import("./journeys/[id]/route");
const journeyAppsRoute = await import("./journeys/[id]/applications/route");

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  vi.stubEnv("DATADOG_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("REMEDIATION_ALLOWED_HOSTS", "hooks.test");
  vi.stubEnv("LOG_LEVEL", "silent");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await close();
});
afterEach(() => vi.unstubAllGlobals());

const admin = { "content-type": "application/json", "x-forwarded-email": "ana" };
const req = (url: string, init: RequestInit & { headers?: Record<string, string> } = {}) => new Request(`http://app.test${url}`, init);
const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });
const post = (body: unknown, headers: Record<string, string> = admin) => ({ method: "POST", headers, body: JSON.stringify(body) });
let n = 100;
const dd = (over: Record<string, unknown> = {}) => ({
  event_id: String(++n),
  monitor_id: "900",
  monitor_name: "Erros 5xx",
  transition: "Triggered",
  alert_type: "error",
  priority: "P1",
  tags: "service:api-gw,env:prod",
  last_updated: String(Date.parse("2026-02-01T00:00:00Z") + n * 1000),
  link: "https://app.datadoghq.com/monitors/900",
  ...over,
});
const sendWebhook = (body: unknown, headers: Record<string, string> = { "x-webhook-secret": SECRET }) =>
  webhook.POST(req("/api/webhooks/datadog", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }), ctx({ provider: "datadog" }));

describe("POST /api/webhooks/[provider]", () => {
  it("rejeita provedor desconhecido (404), origem inválida (401), JSON inválido e payload inválido (400)", async () => {
    expect((await webhook.POST(req("/x", { method: "POST" }), ctx({ provider: "newrelic" }))).status).toBe(404);
    expect((await sendWebhook(dd(), { "x-webhook-secret": "errado-errado-errado" })).status).toBe(401);
    expect((await sendWebhook(dd(), {})).status).toBe(401);
    expect((await sendWebhook("{nao json")).status).toBe(400);
    expect((await sendWebhook({ monitor_id: "1" })).status).toBe(400);
  });

  it("recusa corpo grande demais (413)", async () => {
    const big = JSON.stringify({ ...dd(), padding: "x".repeat(70_000) });
    expect((await sendWebhook(big)).status).toBe(413);
  });

  it("aplica a transição, é idempotente e responde 200 na reentrega", async () => {
    const body = dd();
    const first = await sendWebhook(body);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: "applied", state: "alert" });
    const again = await sendWebhook(body);
    expect(await again.json()).toEqual({ status: "duplicate" });
  });

  it("dispara a remediação configurada ao entrar em alert", async () => {
    const created = await alertsRoute.POST(
      req("/api/alerts", post({
        externalId: "901", name: "Fila cheia", application: "queue",
        remediations: [{ name: "scale", mode: "webhook", url: "http://hooks.test/scale" }],
      })),
    );
    expect(created.status).toBe(201);
    const { id } = await created.json();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await sendWebhook(dd({ monitor_id: "901", tags: "service:queue" }));
    expect(await res.json()).toMatchObject({ status: "applied", alertId: id });
    await vi.waitFor(async () => {
      expect(await db.select().from(remediationRuns).where(eq(remediationRuns.alertId, id))).toHaveLength(1);
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("responde 500 sem detalhes quando o banco falha (o provedor reenvia)", async () => {
    const orig = db.transaction;
    db.transaction = (() => Promise.reject(new Error("connection refused 10.0.0.5"))) as typeof db.transaction;
    const res = await sendWebhook(dd());
    db.transaction = orig;
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("10.0.0.5");
  });
});

describe("API de gestão", () => {
  it("o ator vem do cabeçalho do SSO (configurável) e, sem ele, é anonymous", async () => {
    const create = (headers: Record<string, string>, externalId: string) =>
      alertsRoute.POST(req("/api/alerts", { method: "POST", headers, body: JSON.stringify({ externalId, name: "Quem", application: "sso-app" }) }));
    const noHeader = await (await create({ "content-type": "application/json" }, "sso-1")).json();
    const viaSso = await (await create({ "content-type": "application/json", "x-forwarded-email": "  carla@empresa.com " }, "sso-2")).json();
    vi.stubEnv("AUTH_USER_HEADER", "X-Auth-Request-User");
    const custom = await (await create({ "content-type": "application/json", "x-auth-request-user": "dan" }, "sso-3")).json();
    const ignored = await (await create({ "content-type": "application/json", "x-forwarded-email": "ana" }, "sso-4")).json();
    vi.stubEnv("AUTH_USER_HEADER", "");
    const actors = await Promise.all([noHeader, viaSso, custom, ignored].map(async (a) => (await (await alertRoute.GET(req("/x"), ctx({ id: String(a.id) }))).json()).audit[0].actor));
    expect(actors).toEqual(["anonymous", "carla@empresa.com", "dan", "anonymous"]);
  });

  it("cria, consulta, atualiza, arquiva e audita com o ator informado", async () => {
    const created = await alertsRoute.POST(req("/api/alerts", post({ externalId: "mgmt-1", name: "Disco", application: "storage" })));
    expect(created.status).toBe(201);
    const { id } = await created.json();
    expect((await alertsRoute.POST(req("/api/alerts", post({ externalId: "mgmt-1", name: "Disco", application: "storage" })))).status).toBe(409);
    expect((await alertsRoute.POST(req("/api/alerts", post({ name: "sem id" })))).status).toBe(400);

    const patched = await alertRoute.PATCH(req(`/api/alerts/${id}`, { method: "PATCH", headers: admin, body: JSON.stringify({ priority: 2 }) }), ctx({ id: String(id) }));
    expect((await patched.json()).priority).toBe(2);
    const detail = await (await alertRoute.GET(req(`/api/alerts/${id}`, { headers: admin }), ctx({ id: String(id) }))).json();
    expect(detail.audit.map((a: { kind: string; actor: string }) => [a.kind, a.actor])).toEqual([["alert_updated", "ana"], ["alert_created", "ana"]]);

    expect((await alertRoute.DELETE(req(`/api/alerts/${id}`, { method: "DELETE", headers: admin }), ctx({ id: String(id) }))).status).toBe(200);
    const [row] = await db.select().from(alerts).where(eq(alerts.id, id));
    expect(row.archivedAt).not.toBeNull();
  });

  it("valida ids e corpos nas rotas de alerta", async () => {
    expect((await alertRoute.GET(req("/api/alerts/abc", { headers: admin }), ctx({ id: "abc" }))).status).toBe(400);
    expect((await alertRoute.GET(req("/api/alerts/999999", { headers: admin }), ctx({ id: "999999" }))).status).toBe(404);
    expect((await alertRoute.PATCH(req("/api/alerts/1", { method: "PATCH", headers: admin, body: "{}" }), ctx({ id: "1" }))).status).toBe(400);
    expect((await alertRoute.PATCH(req("/api/alerts/x", { method: "PATCH", headers: admin, body: "{}" }), ctx({ id: "x" }))).status).toBe(400);
    expect((await alertRoute.DELETE(req("/api/alerts/x", { method: "DELETE", headers: admin }), ctx({ id: "x" }))).status).toBe(400);
    expect((await alertRoute.DELETE(req("/api/alerts/999999", { method: "DELETE", headers: admin }), ctx({ id: "999999" }))).status).toBe(404);
  });

  it("lista com filtros validados", async () => {
    const ok = await alertsRoute.GET(req("/api/alerts?application=queue&limit=5", { headers: admin }));
    expect((await ok.json()).items.length).toBeGreaterThan(0);
    expect((await alertsRoute.GET(req("/api/alerts?state=bogus", { headers: admin }))).status).toBe(400);
  });

  it("gerencia remediações: cria, rejeita segredo literal e atualiza", async () => {
    const { id } = await (await alertsRoute.POST(req("/api/alerts", post({ externalId: "mgmt-2", name: "Mem", application: "storage" })))).json();
    const c = ctx({ id: String(id) });
    const bad = await remediationsRoute.POST(req("/x", post({ name: "r", mode: "api", url: "http://hooks.test/r", headers: { "X-Api-Key": "literal" } })), c);
    expect(bad.status).toBe(400);
    const ok = await remediationsRoute.POST(req("/x", post({ name: "r", mode: "api", url: "http://hooks.test/r", headers: { "X-Api-Key": "env:K" } })), c);
    expect(ok.status).toBe(201);
    const rem = await ok.json();
    const upd = await remediationRoute.PATCH(
      req("/x", { method: "PATCH", headers: admin, body: JSON.stringify({ enabled: false }) }),
      ctx({ id: String(id), remediationId: String(rem.id) }),
    );
    expect((await upd.json()).enabled).toBe(false);
    expect((await remediationRoute.PATCH(req("/x", { method: "PATCH", headers: admin, body: "{}" }), ctx({ id: "a", remediationId: "b" }))).status).toBe(400);
    expect((await remediationsRoute.POST(req("/x", post({})), ctx({ id: "zzz" }))).status).toBe(400);
  });

  it("lista as aplicações com status", async () => {
    const map = await (await applicationsRoute.GET()).json();
    expect(map.applications.find((a: { name: string }) => a.name === "api-gw")).toMatchObject({ status: "alert" });
  });

  it("jornadas: cria, lê o mapa, troca aplicações, edita e remove", async () => {
    const created = await journeysRoute.POST(req("/api/journeys", post({ name: "Compra", description: "Do carrinho ao pagamento", applications: ["api-gw", "queue", "nova-app"] })));
    expect(created.status).toBe(201);
    const { id } = await created.json();
    expect((await journeysRoute.POST(req("/api/journeys", post({ name: "Compra" })))).status).toBe(409);
    expect((await journeysRoute.POST(req("/api/journeys", post({ name: "" })))).status).toBe(400);

    const map = await (await journeysRoute.GET()).json();
    const compra = map.journeys.find((j: { name: string }) => j.name === "Compra");
    expect(compra).toMatchObject({ status: "alert" });
    expect(compra.applications.map((a: { name: string }) => a.name)).toContain("nova-app");
    expect(map.unassigned.map((a: { name: string }) => a.name)).not.toContain("api-gw");

    const ctxId = ctx({ id: String(id) });
    const put = (apps: string[]) => journeyAppsRoute.PUT(req("/x", { method: "PUT", headers: admin, body: JSON.stringify({ applications: apps }) }), ctxId);
    expect((await (await put(["queue"])).json()).applications).toEqual(["queue"]);
    expect((await journeyAppsRoute.PUT(req("/x", { method: "PUT", headers: admin, body: "{}" }), ctxId)).status).toBe(400);
    expect((await journeyAppsRoute.PUT(req("/x", { method: "PUT", headers: admin, body: "{}" }), ctx({ id: "x" }))).status).toBe(400);

    const patch = (body: unknown, c = ctxId) => journeyRoute.PATCH(req("/x", { method: "PATCH", headers: admin, body: JSON.stringify(body) }), c);
    expect((await (await patch({ description: null })).json()).description).toBeNull();
    expect((await patch({})).status).toBe(400);
    expect((await patch({ name: "x" }, ctx({ id: "999999" }))).status).toBe(404);
    expect((await patch({ name: "x" }, ctx({ id: "zz" }))).status).toBe(400);

    const detail = await (await journeyRoute.GET(req("/x", { headers: admin }), ctxId)).json();
    expect(detail.journey.name).toBe("Compra");
    expect(detail.alerts.length).toBeGreaterThan(0);
    expect((await journeyRoute.GET(req("/x", { headers: admin }), ctx({ id: "999999" }))).status).toBe(404);
    expect((await journeyRoute.GET(req("/x", { headers: admin }), ctx({ id: "zz" }))).status).toBe(400);

    expect((await journeyRoute.DELETE(req("/x", { method: "DELETE", headers: admin }), ctxId)).status).toBe(200);
    expect((await journeyRoute.DELETE(req("/x", { method: "DELETE", headers: admin }), ctxId)).status).toBe(404);
    expect((await journeyRoute.DELETE(req("/x", { method: "DELETE", headers: admin }), ctx({ id: "zz" }))).status).toBe(400);
  });
});

describe("GET /api/health", () => {
  it("200 com banco disponível e 503 sem banco", async () => {
    expect((await health.GET()).status).toBe(200);
    const orig = db.execute;
    db.execute = (() => Promise.reject(new Error("down"))) as unknown as typeof db.execute;
    const res = await health.GET();
    db.execute = orig;
    expect(res.status).toBe(503);
  });
});

describe("observabilidade da aplicação", () => {
  const metricsRoute = () => import("./metrics/route");
  const liveRoute = () => import("./health/live/route");

  it("liveness responde sem tocar o banco", async () => {
    const response = (await liveRoute()).GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("webhook devolve e reaproveita o x-request-id; id estranho é trocado", async () => {
    const send = (headers: Record<string, string>) => sendWebhook(dd(), { "x-webhook-secret": SECRET, ...headers });
    expect((await send({ "x-request-id": "req-abc.123" })).headers.get("x-request-id")).toBe("req-abc.123");
    const generated = (await send({})).headers.get("x-request-id");
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
    const replaced = (await send({ "x-request-id": "ruim com espaço e símbolos!" })).headers.get("x-request-id");
    expect(replaced).toMatch(/^[0-9a-f-]{36}$/);
    expect((await sendWebhook(dd(), { "x-webhook-secret": "errado-errado-errado" })).headers.get("x-request-id")).toBeTruthy();
  });

  it("/api/metrics conta os webhooks por fonte e resultado e publica o estado do banco", async () => {
    await sendWebhook(dd()); // applied
    await sendWebhook(dd(), { "x-webhook-secret": "errado-errado-errado" }); // unauthorized
    await sendWebhook({ monitor_id: "1" }); // invalid
    const response = await (await metricsRoute()).GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const text = await response.text();
    expect(text).toMatch(/global_alerts_webhook_requests_total\{provider="datadog",outcome="(applied|unchanged)"\} \d+/);
    expect(text).toMatch(/global_alerts_webhook_requests_total\{provider="datadog",outcome="unauthorized"\} [1-9]/);
    expect(text).toMatch(/global_alerts_webhook_requests_total\{provider="datadog",outcome="invalid"\} [1-9]/);
    expect(text).toMatch(/global_alerts_webhook_duration_seconds_count\{provider="datadog"\} [1-9]/);
    expect(text).toContain("global_alerts_database_up 1");
    expect(text).toMatch(/global_alerts_alerts\{state="alert"\} \d+/);
    expect(text).not.toContain(SECRET);
  });

  it("fonte desconhecida não cria rótulo novo (a cardinalidade é fixa)", async () => {
    await webhook.POST(req("/x", { method: "POST" }), ctx({ provider: "qualquer-coisa-12345" }));
    const text = await (await (await metricsRoute()).GET()).text();
    expect(text).toContain('provider="unknown",outcome="unknown_provider"');
    expect(text).not.toContain("qualquer-coisa-12345");
  });
});

describe("várias fontes de alertas", () => {
  const SECRETS = { generic: "generic-secret-0123456789", cloudwatch: "cloudwatch-secret-0123456789", appdynamics: "appd-secret-0123456789" };
  beforeAll(() => {
    vi.stubEnv("GENERIC_WEBHOOK_SECRET", SECRETS.generic);
    vi.stubEnv("CLOUDWATCH_WEBHOOK_SECRET", SECRETS.cloudwatch);
    vi.stubEnv("APPDYNAMICS_WEBHOOK_SECRET", SECRETS.appdynamics);
  });
  const send = (provider: string, body: unknown, headers: Record<string, string>) =>
    webhook.POST(req(`/api/webhooks/${provider}`, { method: "POST", headers, body: JSON.stringify(body) }), ctx({ provider }));
  const generic = (over: Record<string, unknown> = {}) => ({ event_id: `g${++n}`, monitor_id: "900", monitor_name: "Genérico", state: "alert", application: "multi-src", priority: "P1", ...over });
  const basic = (secret: string) => ({ authorization: `Basic ${Buffer.from(`sns:${secret}`).toString("base64")}` });
  const alarm = (over: Record<string, unknown> = {}) => ({
    Type: "Notification", MessageId: `sns-${++n}`, TopicArn: "arn:aws:sns:us-east-1:123456789012:t",
    Message: JSON.stringify({ AlarmName: "Latência", AlarmDescription: "service:multi-src priority:1", AlarmArn: "arn:aws:cloudwatch:us-east-1:123456789012:alarm:Latência", NewStateValue: "ALARM" }),
    ...over,
  });

  it("cada fonte tem o seu segredo: o de uma não vale para outra", async () => {
    expect((await send("generic", generic(), { "x-webhook-secret": SECRET })).status).toBe(401); // segredo do Datadog
    expect((await send("generic", generic(), { "x-webhook-secret": SECRETS.cloudwatch })).status).toBe(401);
    expect((await sendWebhook(dd(), { "x-webhook-secret": SECRETS.generic })).status).toBe(401);
    expect((await send("cloudwatch", alarm(), { "x-webhook-secret": SECRETS.cloudwatch })).status).toBe(401); // SNS só fala Basic
    expect((await send("appdynamics", {}, {})).status).toBe(401);
  });

  it("o mesmo ID de monitor em fontes diferentes são alertas diferentes", async () => {
    const fromDatadog = await (await sendWebhook(dd({ monitor_id: "900" }))).json();
    const fromGeneric = await (await send("generic", generic(), { "x-webhook-secret": SECRETS.generic })).json();
    expect(fromGeneric).toMatchObject({ status: expect.stringMatching(/applied|unchanged|created/), state: "alert" });
    expect(fromGeneric.alertId).not.toBe(fromDatadog.alertId);
    const detail = await (await alertRoute.GET(req("/x", { headers: admin }), ctx({ id: String(fromGeneric.alertId) }))).json();
    expect(detail.alert.provider).toBe("generic");
  });

  it("CloudWatch: confirma a assinatura do SNS e depois aplica o alarme", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const handshake = await send("cloudwatch", { Type: "SubscriptionConfirmation", MessageId: "c1", TopicArn: "arn:aws:sns:us-east-1:123456789012:t", SubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=x" }, basic(SECRETS.cloudwatch));
    expect(handshake.status).toBe(200);
    expect(await handshake.json()).toEqual({ status: "handshake", message: "subscription confirmed" });
    expect(fetchMock).toHaveBeenCalledOnce();

    const first = await send("cloudwatch", alarm(), basic(SECRETS.cloudwatch));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ state: "alert" });
    const hostile = await send("cloudwatch", { Type: "SubscriptionConfirmation", MessageId: "c2", SubscribeURL: "http://169.254.169.254/latest" }, basic(SECRETS.cloudwatch));
    expect(hostile.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("CloudWatch: reentrega do mesmo MessageId é duplicata", async () => {
    const body = alarm();
    expect((await send("cloudwatch", body, basic(SECRETS.cloudwatch))).status).toBe(200);
    expect(await (await send("cloudwatch", body, basic(SECRETS.cloudwatch))).json()).toEqual({ status: "duplicate" });
  });

  it("AppDynamics: aplica o evento da política", async () => {
    const body = { event_id: `a${++n}`, event_type: "POLICY_OPEN_WARNING", application: "multi-src", health_rule: "CPU", policy: "P", priority: "2" };
    const response = await send("appdynamics", body, { "x-webhook-secret": SECRETS.appdynamics });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "warn" });
  });

  it("cadastro manual recusa fonte que não existe", async () => {
    const response = await alertsRoute.POST(req("/api/alerts", post({ provider: "newrelic", externalId: "1", name: "x", application: "multi-src" })));
    expect(response.status).toBe(400);
  });
});

describe("silenciar monitor no Datadog", () => {
  const monitorResponse = (state: string) => new Response(JSON.stringify({ id: 4242, overall_state: state }), { status: 200 });
  async function newAlert(externalId: string) {
    const created = await alertsRoute.POST(req("/api/alerts", post({ externalId, name: `Monitor ${externalId}`, application: "mute-app" })));
    return (await created.json()).id as number;
  }
  const enableDatadog = () => {
    vi.stubEnv("DD_API_KEY", "dd-api-key-1234");
    vi.stubEnv("DD_APP_KEY", "dd-app-key-1234");
    vi.stubEnv("DD_API_BASE_URL", "http://dd.test");
  };
  afterEach(() => {
    vi.stubEnv("DD_API_KEY", "");
    vi.stubEnv("DD_APP_KEY", "");
    vi.stubEnv("DD_API_BASE_URL", "");
  });
  const call = (route: typeof muteRoute, id: number | string, body: unknown, headers = admin) =>
    route.POST(req("/x", { method: "POST", headers, body: JSON.stringify(body) }), ctx({ id: String(id) }));

  it("sem credenciais do Datadog responde 503; entradas inválidas, 400; alerta inexistente, 404", async () => {
    const id = await newAlert("5001");
    expect((await call(muteRoute, id, { minutes: 5, reason: "teste" })).status).toBe(503);
    enableDatadog();
    expect((await call(muteRoute, "zz", { minutes: 5, reason: "teste" })).status).toBe(400);
    expect((await call(muteRoute, id, { minutes: 5 })).status).toBe(400);
    expect((await call(muteRoute, 999999, { minutes: 5, reason: "teste" })).status).toBe(404);
    expect((await call(unmuteRoute, "zz", {})).status).toBe(400);
  });

  it("silencia e reativa chamando a API do Datadog e sincroniza o estado informado", async () => {
    enableDatadog();
    const id = await newAlert("4242");
    const fetchMock = vi.fn().mockImplementation(async () => monitorResponse("Alert"));
    vi.stubGlobal("fetch", fetchMock);

    const muted = await call(muteRoute, id, { minutes: 30, reason: "deploy" });
    expect(muted.status).toBe(200);
    expect(await muted.json()).toMatchObject({ reason: "deploy", synced: { outcome: "applied", state: "alert" } });
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/^http:\/\/dd\.test\/api\/v1\/monitor\/4242\/mute\?end=\d+$/);
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ "DD-API-KEY": "dd-api-key-1234", "DD-APPLICATION-KEY": "dd-app-key-1234" });
    const detail = await (await alertRoute.GET(req("/x", { headers: admin }), ctx({ id: String(id) }))).json();
    expect(detail.alert.mutedBy).toBe("ana");
    expect(detail.audit.map((a: { kind: string }) => a.kind)).toEqual(expect.arrayContaining(["monitor_muted", "state_changed"]));

    const unmuted = await call(unmuteRoute, id, { reason: "fim" });
    expect(unmuted.status).toBe(200);
    expect(String(fetchMock.mock.calls[1][0])).toBe("http://dd.test/api/v1/monitor/4242/unmute");
    const after = await (await alertRoute.GET(req("/x", { headers: admin }), ctx({ id: String(id) }))).json();
    expect(after.alert.mutedUntil).toBeNull();
  });

  it("traduz falhas do Datadog: 404 vira 404 e as demais viram 502 (a tentativa fica auditada)", async () => {
    enableDatadog();
    const id = await newAlert("4343");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ errors: ["Monitor not found"] }), { status: 404 })));
    const notFound = await call(muteRoute, id, { minutes: 5, reason: "teste" });
    expect(notFound.status).toBe(404);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ errors: ["Forbidden"] }), { status: 403 })));
    const forbidden = await call(muteRoute, id, { minutes: 5, reason: "teste" });
    expect(forbidden.status).toBe(502);
    expect((await forbidden.json()).error).toBe("Datadog responded 403: Forbidden");
    const detail = await (await alertRoute.GET(req("/x", { headers: admin }), ctx({ id: String(id) }))).json();
    expect(detail.audit.filter((a: { kind: string }) => a.kind === "monitor_mute_failed")).toHaveLength(2);
  });

  it("lista e recupera operações de silêncio pendentes", async () => {
    enableDatadog();
    const id = await newAlert("4444");
    await db.insert(muteOperations).values({ alertId: id, action: "mute", actor: "ana", reason: "deploy", minutes: 60, until: new Date(Date.now() + 3_600_000), createdAt: new Date(Date.now() - 5 * 60_000) });
    const listed = await (await muteOperationsRoute.GET()).json();
    expect(listed.pending.map((o: { alertId: number }) => o.alertId)).toContain(id);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(monitorResponse("OK")));
    const recovered = await muteOperationsRecoverRoute.POST();
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ found: expect.any(Number), succeeded: expect.any(Number) });
    const after = await (await muteOperationsRoute.GET()).json();
    expect(after.pending.map((o: { alertId: number }) => o.alertId)).not.toContain(id);
  });

  it("alerta de provedor sem suporte responde 501", async () => {
    enableDatadog();
    const id = await newAlert("9");
    await db.update(alerts).set({ provider: "newrelic" }).where(eq(alerts.id, id)); // fonte que deixou de existir
    expect((await call(muteRoute, id, { minutes: 5, reason: "teste" })).status).toBe(501);
  });
});

describe("reconciliação", () => {
  const monitors = (state: string) => new Response(JSON.stringify([{ id: 7001, name: "Reconciliado", overall_state: state, tags: ["service:rec-api"], priority: 1 }]), { status: 200 });
  const start = (body: unknown) => reconciliationRoute.POST(req("/api/reconciliation", { method: "POST", headers: admin, body: JSON.stringify(body) }));
  const run = (id: number | string) => reconciliationRunRoute.GET(req("/x"), ctx({ id: String(id) }));
  const waitDone = async (id: number) => {
    let body: { status: string; summary: Record<string, number> } | undefined;
    await vi.waitFor(async () => {
      body = await (await run(id)).json();
      expect(body?.status).not.toBe("running");
    });
    return body!;
  };
  const enableDatadog = () => {
    vi.stubEnv("DD_API_KEY", "dd-api-key-1234");
    vi.stubEnv("DD_APP_KEY", "dd-app-key-1234");
    vi.stubEnv("DD_API_BASE_URL", "http://dd.test");
  };
  afterEach(() => {
    vi.stubEnv("DD_API_KEY", "");
    vi.stubEnv("DD_APP_KEY", "");
    vi.stubEnv("DD_API_BASE_URL", "");
  });

  it("sem credenciais do Datadog responde 503 e entradas inválidas, 400", async () => {
    expect((await start({})).status).toBe(503);
    enableDatadog();
    expect((await start({ pageSize: 1 })).status).toBe(400);
    expect((await start({ provider: "newrelic" })).status).toBe(400);
    expect((await run("zz")).status).toBe(400);
    expect((await run(99999999)).status).toBe(404);
  });

  it("inicia em segundo plano (202), cria o alerta lido do Datadog e registra o resultado", async () => {
    enableDatadog();
    const fetchMock = vi.fn().mockImplementation(async () => monitors("Alert"));
    vi.stubGlobal("fetch", fetchMock);
    const started = await start({ trigger: "schedule" });
    expect(started.status).toBe(202);
    const { id } = await started.json();
    const done = await waitDone(id);
    expect(done).toMatchObject({ status: "succeeded", summary: { created: 1, pages: 1 } });
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://dd.test/api/v1/monitor?page=0&page_size=100");
    const list = await (await alertsRoute.GET(req("/api/alerts?application=rec-api"))).json();
    expect(list.items[0]).toMatchObject({ externalId: "7001", state: "alert", application: "rec-api" });
    const runs = await (await reconciliationRoute.GET()).json();
    expect(runs.runs[0]).toMatchObject({ id, trigger: "schedule", actor: "ana" });
  });

  it("recusa uma segunda execução enquanto outra está em andamento (409)", async () => {
    enableDatadog();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => monitors("OK")));
    const { reconciliationRuns } = await import("@/db/schema");
    const [blocker] = await db.insert(reconciliationRuns).values({ provider: "datadog", trigger: "manual", actor: "outro" }).returning();
    expect((await start({})).status).toBe(409);
    const { eq } = await import("drizzle-orm");
    await db.update(reconciliationRuns).set({ status: "failed" }).where(eq(reconciliationRuns.id, blocker.id));
    expect((await start({ dryRun: true })).status).toBe(202);
  });
});

