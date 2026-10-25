// Utilitários dos adaptadores: nada aqui conhece o formato de uma ferramenta específica.

// A aplicação de um monitor vem da tag service: (fallback app:, application:); sem elas, "unassigned".
export function applicationFromTags(tags: string[]) {
  for (const key of ["service", "app", "application"]) {
    const hit = tags.find((tag) => tag.toLowerCase().startsWith(`${key}:`));
    const value = hit?.slice(key.length + 1).trim();
    if (value) return value;
  }
  return "unassigned";
}

// O link vira href na interface: só http(s) passa.
export function safeHttpUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** "P2", "2" ou 2 -> 2 (1 a 5); qualquer outra coisa -> null. */
export function parsePriority(value: string | number | null | undefined) {
  const hit = /^P?([1-5])$/i.exec(String(value ?? "").trim());
  return hit ? Number(hit[1]) : null;
}

/** Epoch em milissegundos (número ou texto) ou data ISO, inclusive com fuso "+0000"; inválido -> null. */
export function parseTime(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  const date = /^\d+$/.test(text) ? new Date(Number(text)) : new Date(text.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isFinite(date.getTime()) && date.getTime() > 0 ? date : null;
}

/** Variável de modelo que o provedor não preencheu (ex.: "${latestEvent.deepLink}") conta como vazia. */
export const unresolved = (value: string | null | undefined) => !value || /\$\{|^null$|^undefined$/i.test(value.trim());

/** "service:x priority:2" dentro de um texto livre (descrição); pares chave:valor separados por espaço. */
export function tokensFrom(text: string | null | undefined) {
  return (text ?? "").split(/\s+/).filter((token) => /^[A-Za-z_][\w-]*:\S+$/.test(token));
}
