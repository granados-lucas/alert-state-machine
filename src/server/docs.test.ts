import { describe, expect, it } from "vitest";
import { DOCS, DOC_GROUPS, findDoc, renderDoc, renderMarkdown, slugify } from "./docs";

const entry = DOCS[0];

describe("renderMarkdown", () => {
  it("gera ids estáveis nos títulos, sem repetir, e lista só h2 e h3", () => {
    const { html, headings } = renderMarkdown("# Título\n\n## 1. Colocar no ar\n\n### Ação `x`\n\n## 1. Colocar no ar\n\n#### Fundo\n", entry);
    expect(html).toContain('<h2 id="1-colocar-no-ar">');
    expect(html).toContain('<h2 id="1-colocar-no-ar-2">');
    expect(html).toContain('<h3 id="acao-x">');
    expect(headings).toEqual([
      { id: "1-colocar-no-ar", text: "1. Colocar no ar", depth: 2 },
      { id: "acao-x", text: "Ação x", depth: 3 },
      { id: "1-colocar-no-ar-2", text: "1. Colocar no ar", depth: 2 },
    ]);
  });

  it("nunca interpreta HTML cru do arquivo", () => {
    const { html } = renderMarkdown('texto <script>alert(1)</script> e <img src=x onerror=alert(1)>\n\n<div onclick="x()">oi</div>\n', entry);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<div onclick");
    expect(html).toContain("&lt;script&gt;");
  });

  it("links: externos abrem com rel seguro, documentos viram páginas, o resto vira texto", () => {
    const { html } = renderMarkdown("[a](https://exemplo.com) [b](docs/integrations/cloudwatch.md#riscos) [c](javascript:alert(1)) [d](src/server/x.ts) [e](#nesta)", entry);
    expect(html).toContain('<a href="https://exemplo.com" target="_blank" rel="noreferrer noopener">a</a>');
    expect(html).toContain('<a href="/docs/cloudwatch#riscos">b</a>');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("src/server/x.ts\"");
    expect(html).toContain('<a href="#nesta">e</a>');
  });

  it("caminho de documento entre crases vira link, exceto para o próprio documento", () => {
    const manual = renderMarkdown("veja `docs/observability.md` e `docs/guia-de-uso.md` e `arquivo qualquer.md`", entry).html;
    expect(manual).toContain('<a href="/docs/observabilidade"><code>docs/observability.md</code></a>');
    expect(manual).toContain("<code>docs/guia-de-uso.md</code>");
    expect(manual).not.toContain('href="/docs/manual"');
    expect(manual).toContain("<code>arquivo qualquer.md</code>");
    expect(renderMarkdown("`PRODUCT.md`", entry).html).toContain('href="/docs/produto"');
  });

  it("tabelas ganham contêiner rolável e cabeçalho com escopo; código é escapado", () => {
    const { html } = renderMarkdown("| A | B |\n|---|:-:|\n| `<x>` | 2 |\n\n```json\n{\"a\": \"<b>\"}\n```\n", entry);
    expect(html).toContain('<div class="doc-table"><table>');
    expect(html).toContain('<th scope="col">A</th>');
    expect(html).toContain('<td style="text-align:center">2</td>');
    expect(html).toContain("<code>&lt;x&gt;</code>");
    expect(html).toContain("&lt;b&gt;");
  });
});

describe("catálogo de documentos", () => {
  it("slugs únicos, todos em um grupo conhecido", () => {
    expect(new Set(DOCS.map((d) => d.slug)).size).toBe(DOCS.length);
    for (const d of DOCS) expect(DOC_GROUPS).toContain(d.group);
    expect(findDoc("manual")?.file).toBe("docs/guia-de-uso.md");
    expect(findDoc("nao-existe")).toBeUndefined();
    expect(slugify("Integração: Café & Cia!")).toBe("integracao-cafe-cia");
  });

  it("todos os arquivos existem e renderizam com título e sem HTML cru", async () => {
    for (const d of DOCS) {
      const doc = await renderDoc(d.slug);
      expect(doc, d.slug).not.toBeNull();
      expect(doc?.html, d.slug).toMatch(/<h1 id="/);
      expect(doc?.html, d.slug).not.toMatch(/<script|<iframe/i);
    }
    expect(await renderDoc("nao-existe")).toBeNull();
  });
});
