import { readFile } from "node:fs/promises";
import path from "node:path";
import { Marked, type Tokens } from "marked";

/**
 * Documentação dentro da aplicação: renderiza os próprios arquivos Markdown do repositório (fonte única; nada é
 * copiado para o código). As páginas /docs são geradas no build, então em produção não há leitura de arquivo.
 */
export type DocGroup = "Manual" | "Integrações" | "Operação" | "Referência";
export type DocEntry = { slug: string; title: string; description: string; file: string; group: DocGroup };

export const DOCS: DocEntry[] = [
  { slug: "manual", title: "Manual de uso", description: "Colocar no ar, criar alertas, ligar as ferramentas, jornadas, prioridades, remediação e silêncio.", file: "docs/guia-de-uso.md", group: "Manual" },
  { slug: "datadog", title: "Datadog", description: "Webhook, silenciar monitores, reconciliação, limites de uso e o que não foi verificado.", file: "docs/integrations/datadog.md", group: "Integrações" },
  { slug: "cloudwatch", title: "Amazon CloudWatch", description: "Alarmes pela assinatura HTTPS do SNS, confirmação automática e riscos.", file: "docs/integrations/cloudwatch.md", group: "Integrações" },
  { slug: "appdynamics", title: "AppDynamics", description: "Ação de requisição HTTP, modelo de payload, tipos de evento e riscos.", file: "docs/integrations/appdynamics.md", group: "Integrações" },
  { slug: "generic", title: "Fonte genérica", description: "JSON canônico para qualquer ferramenta sem adaptador.", file: "docs/integrations/generic.md", group: "Integrações" },
  { slug: "observabilidade", title: "Observabilidade da aplicação", description: "Status, métricas Prometheus, correlação de requisições e alertas sugeridos.", file: "docs/observability.md", group: "Operação" },
  { slug: "arquitetura", title: "Arquitetura", description: "Estrutura do código, fluxo do webhook, dados, segurança e decisões.", file: "docs/architecture.md", group: "Referência" },
  { slug: "produto", title: "Produto e escopo", description: "O que o sistema faz, o que não faz, premissas e pendências.", file: "PRODUCT.md", group: "Referência" },
];

export const DOC_GROUPS: DocGroup[] = ["Manual", "Integrações", "Operação", "Referência"];

export type Heading = { id: string; text: string; depth: number };
export type RenderedDoc = { entry: DocEntry; html: string; headings: Heading[] };

const bySlug = new Map(DOCS.map((d) => [d.slug, d]));
const byFile = new Map(DOCS.map((d) => [d.file, d]));

export const findDoc = (slug: string) => bySlug.get(slug);

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function slugify(text: string) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Caminho de documento citado no texto ("docs/observability.md", "PRODUCT.md#x") -> endereço da página. */
function docHref(ref: string) {
  const [file, hash] = ref.split("#");
  const normalized = file.replace(/^\.?\/?/, "").replace(/^(\.\.\/)+/, "");
  const entry = byFile.get(normalized) ?? byFile.get(`docs/${normalized}`) ?? DOCS.find((d) => d.file.endsWith(`/${normalized}`));
  return entry ? `/docs/${entry.slug}${hash ? `#${hash}` : ""}` : null;
}

/** Converte Markdown em HTML. HTML cru do arquivo é mostrado como texto (nunca interpretado). */
export function renderMarkdown(markdown: string, current: DocEntry): { html: string; headings: Heading[] } {
  const headings: Heading[] = [];
  const used = new Map<string, number>();
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      html: (token: Tokens.HTML | Tokens.Tag) => escapeHtml(token.text),
      heading(token: Tokens.Heading) {
        const text = token.text.replace(/`/g, "");
        const base = slugify(text) || "secao";
        const count = used.get(base) ?? 0;
        used.set(base, count + 1);
        const id = count === 0 ? base : `${base}-${count + 1}`;
        if (token.depth >= 2 && token.depth <= 3) headings.push({ id, text, depth: token.depth });
        return `<h${token.depth} id="${id}">${this.parser.parseInline(token.tokens)}</h${token.depth}>\n`;
      },
      codespan(token: Tokens.Codespan) {
        const code = `<code>${escapeHtml(token.text)}</code>`;
        // Um documento citado entre crases vira link para a página dele.
        const href = /\.md(#[\w-]+)?$/.test(token.text) && !/\s/.test(token.text) ? docHref(token.text) : null;
        return href && !href.startsWith(`/docs/${current.slug}`) ? `<a href="${href}">${code}</a>` : code;
      },
      link(token: Tokens.Link) {
        const inner = this.parser.parseInline(token.tokens);
        const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
        if (/^https?:\/\//i.test(token.href)) return `<a href="${escapeHtml(token.href)}"${title} target="_blank" rel="noreferrer noopener">${inner}</a>`;
        if (token.href.startsWith("#")) return `<a href="${escapeHtml(token.href)}"${title}>${inner}</a>`;
        const internal = docHref(token.href);
        // Qualquer outro destino (javascript:, caminhos do repositório sem página) vira texto, sem link.
        return internal ? `<a href="${internal}"${title}>${inner}</a>` : inner;
      },
      table(token: Tokens.Table) {
        const cell = (c: Tokens.TableCell, tag: "th" | "td") => `<${tag}${c.align ? ` style="text-align:${c.align}"` : ""}${tag === "th" ? ' scope="col"' : ""}>${this.parser.parseInline(c.tokens)}</${tag}>`;
        const head = `<tr>${token.header.map((c) => cell(c, "th")).join("")}</tr>`;
        const rows = token.rows.map((row) => `<tr>${row.map((c) => cell(c, "td")).join("")}</tr>`).join("");
        // O contêiner rolável evita que uma tabela larga estoure a página no celular.
        return `<div class="doc-table"><table><thead>${head}</thead><tbody>${rows}</tbody></table></div>\n`;
      },
    },
  });
  return { html: marked.parse(markdown, { async: false }), headings };
}

export async function renderDoc(slug: string, root = process.cwd()): Promise<RenderedDoc | null> {
  const entry = findDoc(slug);
  if (!entry) return null;
  // Só roda no build (as páginas são estáticas): o caminho não deve arrastar o projeto inteiro para o rastreamento da imagem.
  const markdown = await readFile(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ root, entry.file), "utf8");
  return { entry, ...renderMarkdown(markdown, entry) };
}
