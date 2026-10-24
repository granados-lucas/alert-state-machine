export type JourneyFormValues = {
  name: string;
  description: string;
  selected: string[];
  /** Aplicações ainda não vistas pelo Datadog, separadas por vírgula. */
  extra: string;
};

/** Une as aplicações marcadas e as digitadas, sem repetição e em ordem alfabética. */
export function collectApplications(values: Pick<JourneyFormValues, "selected" | "extra">) {
  const typed = values.extra.split(",").map((n) => n.trim()).filter(Boolean);
  return [...new Set([...values.selected, ...typed])].sort((a, b) => a.localeCompare(b));
}

/** Corpo de POST /api/journeys; a validação final é do servidor. */
export function buildCreateJourneyBody(values: JourneyFormValues) {
  return { name: values.name.trim(), description: values.description.trim() || null, applications: collectApplications(values) };
}

/** Corpo de PATCH /api/journeys/:id; só envia o que mudou (null = sem alterações). */
export function buildJourneyPatch(values: JourneyFormValues, original: { name: string; description: string | null }) {
  const patch: { name?: string; description?: string | null } = {};
  if (values.name.trim() !== original.name) patch.name = values.name.trim();
  const description = values.description.trim() || null;
  if (description !== original.description) patch.description = description;
  return Object.keys(patch).length > 0 ? patch : null;
}
