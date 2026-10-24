import "server-only";
import { getDatadogApiConfig, getDatadogWebhookSecret } from "@/lib/env";
import { createDatadogProvider } from "./datadog";
import type { AlertProvider } from "./types";

// Novo provedor = novo adaptador registrado aqui; o domínio não muda.
export function getProvider(id: string): AlertProvider | undefined {
  if (id === "datadog") return createDatadogProvider({ secret: getDatadogWebhookSecret(), api: getDatadogApiConfig() });
  return undefined;
}
