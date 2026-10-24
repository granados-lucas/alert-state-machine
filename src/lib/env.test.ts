import { afterEach, describe, expect, it, vi } from "vitest";
import { getAuthUserHeader, getDatabaseUrl, getDatadogApiConfig, getLogLevel } from "./env";

vi.mock("server-only", () => ({}));
afterEach(() => vi.unstubAllEnvs());

describe("server environment", () => {
  it("does not require a database URL to read independent configuration", () => {
    vi.stubEnv("DATABASE_URL", undefined);
    vi.stubEnv("LOG_LEVEL", undefined);
    expect(getLogLevel()).toBe("info");
    expect(() => getDatabaseUrl()).toThrow("DATABASE_URL");
  });

  it("accepts PostgreSQL connection protocols", () => {
    for (const protocol of ["postgres", "postgresql"]) {
      const value = `${protocol}://app:development@localhost:5432/app`;
      vi.stubEnv("DATABASE_URL", value);
      expect(getDatabaseUrl()).toBe(value);
    }
  });

  it("rejects a wrong protocol without exposing its credentials", () => {
    vi.stubEnv("DATABASE_URL", "https://app:sensitive-test-value@example.invalid/db");
    expect(() => getDatabaseUrl()).toThrow("DATABASE_URL");
    expect(() => getDatabaseUrl()).not.toThrow("sensitive-test-value");
  });

  it("rejects malformed URLs and invalid log levels", () => {
    vi.stubEnv("DATABASE_URL", "not a URL");
    vi.stubEnv("LOG_LEVEL", "not-a-level");
    expect(() => getDatabaseUrl()).toThrow("DATABASE_URL");
    expect(() => getLogLevel()).toThrow("LOG_LEVEL");
  });
});

describe("Datadog API config", () => {
  it("fica desligada sem as duas chaves", () => {
    vi.stubEnv("DD_API_KEY", "dd-api-key-1234");
    vi.stubEnv("DD_APP_KEY", "");
    expect(getDatadogApiConfig()).toBeUndefined();
  });

  it("monta o destino pelo site (padrão datadoghq.com) ou pelo override sem barra final", () => {
    vi.stubEnv("DD_API_KEY", "dd-api-key-1234");
    vi.stubEnv("DD_APP_KEY", "dd-app-key-1234");
    vi.stubEnv("DD_SITE", "");
    vi.stubEnv("DD_API_BASE_URL", "");
    expect(getDatadogApiConfig()).toEqual({ baseUrl: "https://api.datadoghq.com", apiKey: "dd-api-key-1234", appKey: "dd-app-key-1234" });
    vi.stubEnv("DD_SITE", "datadoghq.eu");
    expect(getDatadogApiConfig()?.baseUrl).toBe("https://api.datadoghq.eu");
    vi.stubEnv("DD_API_BASE_URL", "http://sim.test:9100/");
    expect(getDatadogApiConfig()?.baseUrl).toBe("http://sim.test:9100");
  });

  it("rejeita site desconhecido, URL inválida e chave curta sem expor o valor", () => {
    vi.stubEnv("DD_API_KEY", "dd-api-key-1234");
    vi.stubEnv("DD_APP_KEY", "dd-app-key-1234");
    vi.stubEnv("DD_API_BASE_URL", "");
    vi.stubEnv("DD_SITE", "evil.example.com");
    expect(() => getDatadogApiConfig()).toThrow("DD_SITE");
    vi.stubEnv("DD_SITE", "");
    vi.stubEnv("DD_API_BASE_URL", "ftp://x");
    expect(() => getDatadogApiConfig()).toThrow("DD_API_BASE_URL");
    vi.stubEnv("DD_API_BASE_URL", "");
    vi.stubEnv("DD_API_KEY", "curta");
    expect(() => getDatadogApiConfig()).toThrow("DD_API_KEY");
    expect(() => getDatadogApiConfig()).not.toThrow("curta");
  });
});

describe("AUTH_USER_HEADER", () => {
  it("usa x-forwarded-email por padrão, normaliza em minúsculas e rejeita nomes inválidos", () => {
    vi.stubEnv("AUTH_USER_HEADER", "");
    expect(getAuthUserHeader()).toBe("x-forwarded-email");
    vi.stubEnv("AUTH_USER_HEADER", "X-Auth-Request-User");
    expect(getAuthUserHeader()).toBe("x-auth-request-user");
    vi.stubEnv("AUTH_USER_HEADER", "bad header: x");
    expect(() => getAuthUserHeader()).toThrow("AUTH_USER_HEADER");
  });
});
