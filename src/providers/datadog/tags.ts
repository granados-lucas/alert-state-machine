// A aplicação de um monitor vem da tag service: (fallback app:, application:); sem elas, "unassigned".
export function applicationFromTags(tags: string[]) {
  for (const key of ["service", "app", "application"]) {
    const hit = tags.find((tag) => tag.toLowerCase().startsWith(`${key}:`));
    const value = hit?.slice(key.length + 1).trim();
    if (value) return value;
  }
  return "unassigned";
}
