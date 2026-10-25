import "server-only";
import { getCloudwatchTopicArns, getDatadogApiConfig, getWebhookSecret } from "@/lib/env";
import { createAppdynamicsProvider } from "./appdynamics";
import { PROVIDER_IDS, type ProviderId } from "./catalog";
import { createCloudwatchProvider } from "./cloudwatch";
import { createDatadogProvider } from "./datadog";
import { createGenericProvider } from "./generic";
import type { AlertProvider } from "./types";

const BUILDERS: Record<ProviderId, () => AlertProvider> = {
  datadog: () => createDatadogProvider({ api: getDatadogApiConfig() }),
  cloudwatch: () => createCloudwatchProvider({ topicArns: getCloudwatchTopicArns() }),
  appdynamics: () => createAppdynamicsProvider(),
  generic: () => createGenericProvider(),
};

export function getProvider(id: string): AlertProvider | undefined {
  return (PROVIDER_IDS as readonly string[]).includes(id) ? BUILDERS[id as ProviderId]() : undefined;
}

/** O webhook único está habilitado (segredo definido e válido)? */
export function webhookEnabled() {
  try {
    return getWebhookSecret() !== undefined;
  } catch {
    return false; // segredo curto demais
  }
}

/** Fontes com a API de ações habilitada (silenciar, reconciliar). */
export function providerStatus() {
  return PROVIDER_IDS.map((id) => {
    try {
      const provider = BUILDERS[id]();
      return { id, control: provider.control !== undefined, source: provider.source !== undefined };
    } catch {
      return { id, control: false, source: false }; // configuração inválida: fonte indisponível
    }
  });
}
