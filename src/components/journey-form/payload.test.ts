import { describe, expect, it } from "vitest";
import { buildCreateJourneyBody, buildJourneyPatch, collectApplications } from "./payload";

const values = { name: " Compra ", description: "  ", selected: ["web", "pay"], extra: " nova-app , web ,, " };

describe("journey form payload", () => {
  it("une marcadas e digitadas sem repetição, em ordem", () => {
    expect(collectApplications(values)).toEqual(["nova-app", "pay", "web"]);
  });

  it("monta o corpo de criação com descrição vazia como null", () => {
    expect(buildCreateJourneyBody(values)).toEqual({ name: "Compra", description: null, applications: ["nova-app", "pay", "web"] });
  });

  it("monta o patch só com o que mudou", () => {
    expect(buildJourneyPatch(values, { name: "Compra", description: null })).toBeNull();
    expect(buildJourneyPatch(values, { name: "Outra", description: null })).toEqual({ name: "Compra" });
    expect(buildJourneyPatch({ ...values, description: "d" }, { name: "Compra", description: null })).toEqual({ description: "d" });
    expect(buildJourneyPatch(values, { name: "Compra", description: "antiga" })).toEqual({ description: null });
  });
});
