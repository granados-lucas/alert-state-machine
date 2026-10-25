import "server-only";
import { getCloudwatchTopicArns, getDatadogApiConfig, getWebhookSecret } from "@/lib/env";
import { createAppdynamicsProvider } from "./appdynamics";
import { PROVIDER_IDS, type ProviderId } from "./catalog";
import { createCloudwatchProvider } from "./cloudwatch";
import { createDatadogProvider } from "./datadog";
import { createGenericProvider } from "./generic";
import type { AlertProvider } from "./types";

// Cada fonte tem o seu segredo (`<ID>_WEBHOOK_SECRET`): vazar o de uma não permite enviar eventos como outra.
const BUILDERS: Record<ProviderId, () => AlertProvider> = {
  datadog: () => createDatadogProvider({ secret: getWebhookSecret("datadog"), api: getDatadogApiConfig() }),
  cloudwatch: () => createCloudwatchProvider({ secret: getWebhookSecret("cloudwatch"), topicArns: getCloudwatchTopicArns() }),
  appdynamics: () => createAppdynamicsProvider({ secret: getWebhookSecret("appdynamics") }),
  generic: () => createGenericProvider({ secret: getWebhookSecret("generic") }),
};

export function getProvider(id: string): AlertProvider | undefined {
  return (PROVIDER_IDS as readonly string[]).includes(id) ? BUILDERS[id as ProviderId]() : undefined;
}

/** Fontes com o webhook habilitado (segredo definido) e com a API de ações habilitada. */
export function providerStatus() {
  return PROVIDER_IDS.map((id) => {
    const provider = BUILDERS[id]();
    return { id, webhook: getWebhookSecret(id) !== undefined, control: provider.control !== undefined, source: provider.source !== undefined };
  });
}
