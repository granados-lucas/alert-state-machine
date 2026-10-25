import { beforeEach, describe, expect, it } from "vitest";
import { BUCKETS, increment, observe, PREFIX, readMetric, renderPrometheus, resetMetrics, timed } from "./metrics";

beforeEach(() => resetMetrics());

describe("contadores", () => {
  it("somam por combinação de rótulos, independente da ordem em que são informados", () => {
    increment("webhook_requests_total", { provider: "datadog", outcome: "applied" });
    increment("webhook_requests_total", { outcome: "applied", provider: "datadog" }, 2);
    increment("webhook_requests_total", { provider: "datadog", outcome: "duplicate" });
    expect(readMetric("webhook_requests_total", { provider: "datadog", outcome: "applied" })).toBe(3);
    expect(readMetric("webhook_requests_total", { provider: "datadog", outcome: "duplicate" })).toBe(1);
    expect(readMetric("webhook_requests_total", { provider: "outro" })).toBe(0);
  });
});

describe("histogramas", () => {
  it("contam cada observação nos baldes cumulativos e somam o tempo", () => {
    observe("webhook_duration_seconds", { provider: "datadog" }, 0.004);
    observe("webhook_duration_seconds", { provider: "datadog" }, 0.3);
    observe("webhook_duration_seconds", { provider: "datadog" }, 60);
    const text = renderPrometheus();
    const bucket = (le: string) => new RegExp(`${PREFIX}webhook_duration_seconds_bucket\\{provider="datadog",le="${le.replace("+", "\\+")}"\\} (\\d+)`).exec(text)?.[1];
    expect(bucket("0.005")).toBe("1");
    expect(bucket("0.25")).toBe("1");
    expect(bucket("0.5")).toBe("2");
    expect(bucket("10")).toBe("2");
    expect(bucket("+Inf")).toBe("3");
    expect(text).toContain(`${PREFIX}webhook_duration_seconds_count{provider="datadog"} 3`);
    expect(text).toMatch(new RegExp(`${PREFIX}webhook_duration_seconds_sum\\{provider="datadog"\\} 60\\.304`));
    expect(BUCKETS).toEqual([...BUCKETS].sort((a, b) => a - b));
  });

  it("timed mede também a tarefa que falha e repassa o erro", async () => {
    expect(await timed("reconciliation_duration_seconds", { provider: "datadog" }, async () => "ok")).toBe("ok");
    await expect(timed("reconciliation_duration_seconds", { provider: "datadog" }, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(readMetric("reconciliation_duration_seconds", { provider: "datadog" })).toBe(2);
  });
});

describe("renderPrometheus", () => {
  it("sempre publica HELP e TYPE, mesmo sem amostras, e escapa os valores dos rótulos", () => {
    increment("remediation_runs_total", { status: 'a"b\\c\nd' });
    const text = renderPrometheus();
    expect(text).toContain(`# HELP ${PREFIX}unhandled_errors_total`);
    expect(text).toContain(`# TYPE ${PREFIX}unhandled_errors_total counter`);
    expect(text).not.toMatch(new RegExp(`^${PREFIX}unhandled_errors_total `, "m"));
    expect(text).toContain(`${PREFIX}remediation_runs_total{status="a\\"b\\\\c\\nd"} 1`);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("inclui as medidas calculadas na coleta, com e sem rótulos", () => {
    const text = renderPrometheus([
      { name: "alerts", help: "Alertas.", samples: [{ labels: { state: "alert" }, value: 4 }] },
      { name: "database_up", help: "Banco.", samples: [{ value: 1 }] },
    ]);
    expect(text).toContain(`# TYPE ${PREFIX}alerts gauge`);
    expect(text).toContain(`${PREFIX}alerts{state="alert"} 4`);
    expect(text).toContain(`${PREFIX}database_up 1`);
  });
});
