import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export const btnPrimary =
  "inline-flex items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white shadow-[0_0_24px_-6px_rgb(138_98_255/0.8)] transition-colors hover:bg-[#9b78ff] disabled:cursor-not-allowed disabled:opacity-60";
export const btnSecondary =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-line bg-surface-2 px-4 py-2 text-sm font-medium text-accent-soft transition-colors hover:bg-white/5";
export const field =
  "w-full rounded-xl border border-line bg-bg px-3 py-2 text-sm text-fg placeholder:text-muted transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40";
export const linkClass = "text-accent-soft underline-offset-4 hover:underline";

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={cn("rounded-2xl border border-line bg-surface p-5", className)}>{children}</section>;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-muted">{subtitle}</p>}
      </div>
      {actions}
    </header>
  );
}

export function SectionTitle({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h2 id={id} className="text-xs font-medium uppercase tracking-wider text-muted">
      {children}
    </h2>
  );
}

type Tone = "neutral" | "ok" | "warn" | "alert" | "info" | "accent";
const toneText: Record<Tone, string> = {
  neutral: "text-muted",
  ok: "text-ok",
  warn: "text-warn",
  alert: "text-alert-fg",
  info: "text-info",
  accent: "text-accent-soft",
};

export function KpiCard({ icon, label, value, hint, tone = "neutral" }: { icon: ReactNode; label: string; value: ReactNode; hint?: string; tone?: Tone }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex items-center justify-between">
        <span className={cn("grid size-8 place-items-center rounded-lg bg-surface-2", toneText[tone])}>{icon}</span>
        <span className="text-xs text-muted">{label}</span>
      </div>
      <p className={cn("mt-3 text-3xl font-semibold tracking-tight", tone === "neutral" ? "text-fg" : toneText[tone])}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export const tableHead = "px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted";
export const tableCell = "px-3 py-3";
