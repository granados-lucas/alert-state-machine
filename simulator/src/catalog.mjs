import { createRng } from "./rng.mjs";

const APP_NAMES = [
  "checkout", "payments", "billing", "catalog", "search", "inventory", "shipping", "orders",
  "auth", "users", "notifications", "email-gateway", "sms-gateway", "reports", "analytics", "ingest",
  "api-gateway", "web-frontend", "mobile-bff", "recommendations", "pricing", "promotions", "fraud-check", "ledger",
  "scheduler", "media-service", "cdn-origin", "audit-trail", "feature-flags", "config-service", "queue-workers", "data-sync",
  "support-portal", "partner-api",
  "cart", "wishlist", "reviews", "loyalty", "returns", "refunds", "tax-service", "address-validation",
  "warehouse", "carrier-integration", "customer-profile", "chat-support", "push-gateway", "ab-testing", "data-warehouse", "etl-jobs",
];
const JOURNEY_DEFS = [
  ["Compra", "Do carrinho à confirmação do pedido", ["web-frontend", "mobile-bff", "api-gateway", "auth", "catalog", "cart", "pricing", "promotions", "tax-service", "address-validation", "checkout", "payments", "fraud-check", "inventory", "orders"]],
  ["Pagamento e cobrança", "Cobrança, antifraude e conciliação", ["payments", "fraud-check", "billing", "ledger", "tax-service", "refunds", "notifications", "email-gateway"]],
  ["Entrega", "Separação, envio e avisos ao cliente", ["orders", "inventory", "warehouse", "shipping", "carrier-integration", "address-validation", "notifications", "sms-gateway"]],
  ["Cadastro e acesso", "Criar conta, entrar e recuperar acesso", ["web-frontend", "mobile-bff", "api-gateway", "auth", "users", "customer-profile", "email-gateway", "sms-gateway", "feature-flags"]],
  ["Busca e descoberta", "Encontrar e recomendar produtos", ["web-frontend", "api-gateway", "search", "catalog", "recommendations", "reviews", "ab-testing", "media-service", "cdn-origin"]],
  ["Suporte ao cliente", "Atendimento e histórico do cliente", ["support-portal", "chat-support", "users", "customer-profile", "orders", "notifications", "email-gateway", "audit-trail"]],
  ["Devoluções e reembolsos", "Pedir devolução, receber o produto e devolver o dinheiro", ["support-portal", "orders", "returns", "warehouse", "refunds", "payments", "ledger", "notifications"]],
  ["Fidelidade e engajamento", "Programa de pontos, listas de desejos e campanhas", ["web-frontend", "mobile-bff", "loyalty", "wishlist", "promotions", "recommendations", "customer-profile", "push-gateway", "email-gateway"]],
  ["Relatórios e analytics", "Ingestão, processamento e painéis", ["ingest", "analytics", "reports", "queue-workers", "etl-jobs", "data-warehouse", "data-sync", "config-service"]],
  ["Parceiros", "Integrações com parceiros", ["partner-api", "api-gateway", "auth", "orders", "carrier-integration", "ledger"]],
];
const CHECKS = [
  "High error rate", "Latency p95", "CPU saturation", "Memory usage", "Queue backlog", "Disk usage",
  "Pod restarts", "DB connections", "Timeouts to upstream", "5xx responses", "Apdex low", "Heartbeat missing",
];
const TEAMS = ["platform", "payments", "growth", "data", "core"];
const REMEDIATION_KINDS = ["hook", "api", "flaky"];

/**
 * Catálogo determinístico: `apps` aplicações, exatamente `alerts` monitores (mínimo 2 por aplicação),
 * jornadas que compartilham aplicações e ~25% com remediação (metade registrada pela API, metade descoberta por webhook).
 */
export function generateCatalog({ apps = 32, alerts = 200, seed = 42, idBase = 100000 } = {}) {
  if (apps > APP_NAMES.length) throw new Error(`at most ${APP_NAMES.length} applications`);
  if (alerts < apps * 2) throw new Error("need at least 2 alerts per application");
  const rng = createRng(seed);
  const names = APP_NAMES.slice(0, apps);
  const counts = names.map(() => 2);
  for (let i = apps * 2; i < alerts; i++) counts[rng.int(0, apps - 1)] += 1;

  const monitors = [];
  names.forEach((application, appIndex) => {
    for (let n = 0; n < counts[appIndex]; n++) {
      const monitorId = String(idBase + monitors.length);
      const registerViaApi = rng.chance(0.5);
      monitors.push({
        monitorId,
        application,
        name: `${application}: ${CHECKS[(n + appIndex) % CHECKS.length]} #${monitorId}`,
        priority: rng.pick([1, 2, 2, 3, 3, 4, null]),
        team: rng.pick(TEAMS),
        registerViaApi,
        // Remediação só existe em alertas registrados pela API (é onde ela se configura).
        remediation: registerViaApi && rng.chance(0.5) ? rng.pick(REMEDIATION_KINDS) : null,
      });
    }
  });

  // Jornadas fixas; uma aplicação pode estar em várias e algumas ficam sem jornada (aparecem em "Sem jornada").
  const known = new Set(names);
  const journeys = JOURNEY_DEFS.map(([name, description, members]) => ({ name, description, applications: members.filter((m) => known.has(m)) })).filter(
    (j) => j.applications.length > 0,
  );
  return { applications: names, monitors, journeys };
}
