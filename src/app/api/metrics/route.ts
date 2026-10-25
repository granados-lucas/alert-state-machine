import { renderPrometheus } from "@/lib/metrics";
import { appVersion, currentTelemetry, startedAt } from "@/server/observability";
import { toGauges } from "@/server/telemetry";

export const dynamic = "force-dynamic";

// Métricas no formato de texto do Prometheus. Só agregados: sem nomes de alerta, IDs ou usuários.
// Sem login e sem token: o scraper deve alcançar esta rota pela rede interna (ver docs/observability.md).
export async function GET() {
  const telemetry = await currentTelemetry();
  const body = renderPrometheus(toGauges(telemetry, { version: appVersion(), startedAt }));
  return new Response(body, { headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" } });
}
