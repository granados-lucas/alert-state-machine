import { describe, expect, it, vi } from "vitest";
import { ProviderApiError, ProviderPayloadError } from "./types";
import { createAppdynamicsProvider } from "./appdynamics";
import { EVENT_TYPE_EQUIVALENCE } from "./appdynamics/states";
import { basicPasswordAuth, headerSecretAuth } from "./auth";
import { listProviderInfo, PROVIDER_IDS, providerLabel } from "./catalog";
import { createCloudwatchProvider } from "./cloudwatch";
import { createGenericProvider } from "./generic";
import { parsePriority, parseTime, unresolved } from "./common";

const SECRET = "fonte-secret-0123456789";

describe("autenticação", () => {
  it("cabeçalho: só o segredo exato; sem segredo configurado nega tudo", () => {
    expect(headerSecretAuth(SECRET)(new Headers({ "x-webhook-secret": SECRET }))).toBe(true);
    expect(headerSecretAuth(SECRET)(new Headers({ "x-webhook-secret": "outro-secret-0123456789" }))).toBe(false);
    expect(headerSecretAuth(undefined)(new Headers({ "x-webhook-secret": "" }))).toBe(false);
  });

  it("Basic: o segredo é a senha, o usuário é ignorado", () => {
    const basic = (user: string, pass: string) => new Headers({ authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}` });
    expect(basicPasswordAuth(SECRET)(basic("sns", SECRET))).toBe(true);
    expect(basicPasswordAuth(SECRET)(basic("qualquer", SECRET))).toBe(true);
    expect(basicPasswordAuth(SECRET)(basic("sns", "errada-errada-errada"))).toBe(false);
    expect(basicPasswordAuth(SECRET)(new Headers({ authorization: `Basic ${Buffer.from(SECRET).toString("base64")}` }))).toBe(false); // sem ":"
    expect(basicPasswordAuth(SECRET)(new Headers({ authorization: `Bearer ${SECRET}` }))).toBe(false);
    expect(basicPasswordAuth(SECRET)(new Headers())).toBe(false);
    expect(basicPasswordAuth(undefined)(basic("sns", ""))).toBe(false);
  });
});

describe("utilitários", () => {
  it("prioridade, tempo e variáveis não preenchidas", () => {
    expect([parsePriority("P2"), parsePriority(3), parsePriority("9"), parsePriority(""), parsePriority(null)]).toEqual([2, 3, null, null, null]);
    expect(parseTime("2026-03-01T10:00:00.000+0000")).toEqual(new Date("2026-03-01T10:00:00Z"));
    expect(parseTime("1767225600000")).toEqual(new Date(1767225600000));
    expect([parseTime("lixo"), parseTime(""), parseTime(undefined)]).toEqual([null, null, null]);
    expect([unresolved("${latestEvent.deepLink}"), unresolved("null"), unresolved(""), unresolved("https://x")]).toEqual([true, true, true, false]);
  });
});

describe("catálogo", () => {
  it("toda fonte registrada tem rótulo, segredo próprio e tabela de equivalência", () => {
    const info = listProviderInfo();
    expect(info.map((p) => p.id)).toEqual([...PROVIDER_IDS]);
    expect(new Set(info.map((p) => p.secretEnv)).size).toBe(info.length);
    for (const p of info) expect(p.rows.length).toBeGreaterThan(0);
    expect(providerLabel("cloudwatch")).toBe("Amazon CloudWatch");
    expect(providerLabel("desconhecida")).toBe("desconhecida");
  });
});

describe("genérico", () => {
  const provider = createGenericProvider({ secret: SECRET });
  const body = { event_id: "e1", monitor_id: 7, monitor_name: "Fila cheia", state: "warn", occurred_at: "2026-03-01T10:00:00Z", application: "pagamentos", tags: ["env:prod"], priority: "P2", link: "https://x.test/7" };

  it("normaliza o payload canônico", () => {
    expect(provider.parse(body)).toMatchObject({
      provider: "generic", externalEventId: "e1", externalAlertId: "7", alertName: "Fila cheia", application: "pagamentos",
      event: "warned", occurredAt: new Date("2026-03-01T10:00:00Z"), priority: 2, tags: ["env:prod"], link: "https://x.test/7",
    });
  });

  it("aplicação vem das tags quando não informada; estado e campos obrigatórios são validados", () => {
    expect(provider.parse({ ...body, application: undefined, tags: ["service:api"], state: "ok", link: "javascript:alert(1)" })).toMatchObject({ application: "api", event: "recovered", link: null });
    expect(() => provider.parse({ ...body, state: "explodiu" })).toThrow(ProviderPayloadError);
    expect(() => provider.parse({ monitor_id: 1 })).toThrow(ProviderPayloadError);
  });
});

describe("appdynamics", () => {
  const provider = createAppdynamicsProvider({ secret: SECRET });
  const body = { event_id: 991, event_type: "POLICY_OPEN_CRITICAL", application: "Checkout", health_rule: "CPU alta", policy: "Política A", event_time: "1767225600000", link: "https://ctl.test/e/991", priority: "1" };

  it("normaliza o evento da política: a regra de saúde identifica o alerta", () => {
    expect(provider.parse(body)).toMatchObject({
      provider: "appdynamics", externalEventId: "991", externalAlertId: "Checkout/CPU alta", alertName: "CPU alta", application: "Checkout",
      event: "triggered", occurredAt: new Date(1767225600000), priority: 1, tags: ["policy:Política A"], link: "https://ctl.test/e/991",
    });
  });

  it("sem regra usa a política; variável não preenchida conta como vazia; sem aplicação ou nome é inválido", () => {
    expect(provider.parse({ ...body, health_rule: "${latestEvent.healthRule.name}", link: "${latestEvent.deepLink}", priority: "" })).toMatchObject({ externalAlertId: "Checkout/Política A", link: null, priority: null });
    expect(() => provider.parse({ ...body, health_rule: "", policy: "" })).toThrow(ProviderPayloadError);
    expect(() => provider.parse({ ...body, application: "${latestEvent.application.name}" })).toThrow(ProviderPayloadError);
  });

  it("tabela de equivalência: abre, continua, sobe, desce e fecha; tipo desconhecido mantém o estado", () => {
    const eventOf = (event_type: string) => provider.parse({ ...body, event_type }).event;
    expect(eventOf("POLICY_OPEN_WARNING")).toBe("warned");
    expect(eventOf("policy_continues_critical")).toBe("triggered");
    expect(eventOf("POLICY_UPGRADED")).toBe("triggered");
    expect(eventOf("POLICY_DOWNGRADED")).toBe("warned");
    expect(eventOf("POLICY_CLOSE_WARNING")).toBe("recovered");
    expect(eventOf("POLICY_CANCELED_CRITICAL")).toBe("recovered");
    expect(eventOf("ALGO_NOVO")).toBeNull();
    expect(Object.values(EVENT_TYPE_EQUIVALENCE).filter((r) => r.assumed).length).toBeGreaterThan(0);
  });
});

describe("cloudwatch", () => {
  const TOPIC = "arn:aws:sns:us-east-1:123456789012:alarmes";
  const ARN = "arn:aws:cloudwatch:us-east-1:123456789012:alarm:CPU alta";
  const message = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ AlarmName: "CPU alta", AlarmDescription: "service:checkout priority:2 CPU acima de 80%", AlarmArn: ARN, NewStateValue: "ALARM", StateChangeTime: "2026-03-01T10:00:00.000+0000", ...over });
  const notification = (over: Record<string, unknown> = {}, inner = message()) => ({ Type: "Notification", MessageId: "m-1", TopicArn: TOPIC, Message: inner, Timestamp: "2026-03-01T10:00:05.000Z", ...over });
  const provider = createCloudwatchProvider({ secret: SECRET });

  it("normaliza o alarme: ARN identifica, descrição traz aplicação e prioridade", () => {
    expect(provider.parse(notification())).toMatchObject({
      provider: "cloudwatch", externalEventId: "m-1", externalAlertId: ARN, alertName: "CPU alta", application: "checkout", priority: 2,
      event: "triggered", occurredAt: new Date("2026-03-01T10:00:00Z"),
      link: "https://console.aws.amazon.com/cloudwatch/home?region=us-east-1#alarmsV2:alarm/CPU%20alta",
    });
  });

  it("mapeia OK e INSUFFICIENT_DATA; estado desconhecido mantém; sem data usa o carimbo do SNS", () => {
    expect(provider.parse(notification({}, message({ NewStateValue: "OK" }))).event).toBe("recovered");
    expect(provider.parse(notification({}, message({ NewStateValue: "INSUFFICIENT_DATA" }))).event).toBe("data_missing");
    expect(provider.parse(notification({}, message({ NewStateValue: "TALVEZ" }))).event).toBeNull();
    expect(provider.parse(notification({}, message({ StateChangeTime: undefined }))).occurredAt).toEqual(new Date("2026-03-01T10:00:05Z"));
    expect(provider.parse(notification({}, message({ AlarmDescription: null }))).application).toBe("unassigned");
  });

  it("rejeita o que não é notificação de alarme ou vem de outro tópico", () => {
    expect(() => provider.parse(notification({ Type: "SubscriptionConfirmation" }))).toThrow(ProviderPayloadError);
    expect(() => provider.parse(notification({}, "isto não é json"))).toThrow(ProviderPayloadError);
    expect(() => provider.parse(notification({}, JSON.stringify({ outra: "coisa" })))).toThrow(ProviderPayloadError);
    expect(() => provider.parse("texto")).toThrow(ProviderPayloadError);
    const restricted = createCloudwatchProvider({ secret: SECRET, topicArns: [TOPIC] });
    expect(restricted.parse(notification()).externalEventId).toBe("m-1");
    expect(() => restricted.parse(notification({ TopicArn: "arn:aws:sns:us-east-1:999999999999:outro" }))).toThrow(ProviderPayloadError);
  });

  describe("confirmação da assinatura do SNS", () => {
    const confirmation = (over: Record<string, unknown> = {}) => ({
      Type: "SubscriptionConfirmation", MessageId: "c-1", TopicArn: TOPIC, Token: "t", SubscribeURL: `https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${TOPIC}&Token=t`, ...over,
    });

    it("confirma visitando o SubscribeURL do SNS, sem seguir redirecionamentos", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
      const p = createCloudwatchProvider({ secret: SECRET, fetch: fetchMock });
      expect(await p.handshake?.(confirmation())).toEqual({ message: "subscription confirmed" });
      expect(String(fetchMock.mock.calls[0][0])).toMatch(/^https:\/\/sns\.us-east-1\.amazonaws\.com\/\?Action=ConfirmSubscription/);
      expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "error" });
    });

    it("recusa SubscribeURL que não seja o endpoint do SNS (a aplicação não vira proxy) e tópicos fora da lista", async () => {
      const fetchMock = vi.fn();
      const p = createCloudwatchProvider({ secret: SECRET, topicArns: [TOPIC], fetch: fetchMock });
      for (const url of ["http://sns.us-east-1.amazonaws.com/?x", "https://evil.test/?x", "https://sns.us-east-1.amazonaws.com.evil.test/", "https://u:p@sns.us-east-1.amazonaws.com/", "isso não é url", "http://169.254.169.254/"]) {
        await expect(p.handshake?.(confirmation({ SubscribeURL: url }))).rejects.toBeInstanceOf(ProviderPayloadError);
      }
      await expect(p.handshake?.(confirmation({ TopicArn: "arn:aws:sns:us-east-1:999999999999:outro" }))).rejects.toBeInstanceOf(ProviderPayloadError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("falha de rede ou resposta de erro do SNS vira erro do provedor (o SNS tenta de novo)", async () => {
      const down = createCloudwatchProvider({ secret: SECRET, fetch: vi.fn().mockRejectedValue(new Error("rede")) });
      await expect(down.handshake?.(confirmation())).rejects.toBeInstanceOf(ProviderApiError);
      const refused = createCloudwatchProvider({ secret: SECRET, fetch: vi.fn().mockResolvedValue(new Response("", { status: 403 })) });
      await expect(refused.handshake?.(confirmation())).rejects.toMatchObject({ status: 403 });
    });

    it("cancelamento é ignorado; notificações e corpos estranhos seguem para o parse", async () => {
      expect(await provider.handshake?.({ Type: "UnsubscribeConfirmation", MessageId: "u" })).toEqual({ message: "unsubscribe confirmation ignored" });
      expect(await provider.handshake?.(notification())).toBeNull();
      expect(await provider.handshake?.("texto")).toBeNull();
    });
  });
});
