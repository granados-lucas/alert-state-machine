import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, linkClass } from "@/components/ui/ui";
import { cn } from "@/lib/utils";
import { DOCS, DOC_GROUPS, findDoc, renderDoc } from "@/server/docs";

// Geradas no build a partir dos arquivos Markdown; qualquer outro endereço é 404.
export const dynamicParams = false;
export const generateStaticParams = () => DOCS.map((d) => ({ slug: d.slug }));

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const entry = findDoc((await params).slug);
  return { title: entry ? `${entry.title} · Documentação · Global Alerts` : "Documentação · Global Alerts" };
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const doc = await renderDoc(slug);
  if (!doc) notFound();
  const { entry, html, headings } = doc;

  return (
    <main className="mx-auto w-full max-w-7xl px-5 py-6 lg:px-8">
      <nav aria-label="Trilha" className="mb-5 text-sm text-muted">
        <Link className={linkClass} href="/docs">Documentação</Link> <span aria-hidden>/</span> {entry.group} <span aria-hidden>/</span>{" "}
        <span className="text-fg">{entry.title}</span>
      </nav>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-[minmax(0,1fr)_260px]">
        {/* Conteúdo vindo de arquivos do próprio repositório; HTML cru dentro deles é escapado em src/server/docs.ts. */}
        <article className="doc min-w-0" dangerouslySetInnerHTML={{ __html: html }} />
        <aside aria-label="Navegação da documentação" className="flex flex-col gap-4 lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:self-start lg:overflow-y-auto">
          {headings.length > 0 && (
            <Card className="p-4">
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">Nesta página</h2>
              <ul className="flex flex-col gap-1 text-sm">
                {headings.map((h) => (
                  <li key={h.id} className={cn(h.depth === 3 && "pl-3")}>
                    <a className={cn(linkClass, h.depth === 3 ? "text-muted" : "")} href={`#${h.id}`}>{h.text}</a>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card className="p-4">
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">Documentos</h2>
            {DOC_GROUPS.map((group) => (
              <div key={group} className="mb-2 last:mb-0">
                <p className="text-xs text-muted">{group}</p>
                <ul className="text-sm">
                  {DOCS.filter((d) => d.group === group).map((d) => (
                    <li key={d.slug}>
                      <Link className={cn(linkClass, d.slug === entry.slug && "font-medium text-fg no-underline")} href={`/docs/${d.slug}`} aria-current={d.slug === entry.slug ? "page" : undefined}>
                        {d.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </Card>
        </aside>
      </div>
    </main>
  );
}
