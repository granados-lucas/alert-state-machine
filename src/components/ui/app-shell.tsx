"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { BellIcon, FlowIcon, LayersIcon, MapIcon, PlusIcon, SyncIcon } from "./icons";

const nav = [
  { href: "/", label: "Mapa de jornadas", icon: MapIcon },
  { href: "/alerts", label: "Alertas", icon: BellIcon },
  { href: "/alerts/new", label: "Novo alerta", icon: PlusIcon },
  { href: "/journeys/new", label: "Nova jornada", icon: LayersIcon },
  { href: "/reconciliation", label: "Reconciliação", icon: SyncIcon },
  { href: "/graph", label: "Máquina de estados", icon: FlowIcon },
];

// Rota mais específica vence: /alerts/new não acende "Alertas".
function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/" || pathname.startsWith("/applications") || (pathname.startsWith("/journeys/") && pathname !== "/journeys/new");
  if (href === "/alerts") return pathname === "/alerts" || (pathname.startsWith("/alerts/") && pathname !== "/alerts/new");
  return pathname === href;
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[248px_1fr]">
      <aside className="border-b border-line bg-surface lg:sticky lg:top-0 lg:h-screen lg:border-b-0 lg:border-r">
        <div className="flex items-center gap-3 px-5 py-4 lg:py-6">
          <span aria-hidden className="grid size-9 place-items-center rounded-xl bg-accent/15 text-accent-soft">
            <FlowIcon />
          </span>
          <span className="text-base font-semibold tracking-tight">Global Alerts</span>
        </div>
        <nav aria-label="Principal" className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-col lg:pb-0">
          {nav.map(({ href, label, icon: Icon }) => {
            const active = isActive(pathname, href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex shrink-0 items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors",
                  active ? "bg-accent/15 font-medium text-accent-soft" : "text-muted hover:bg-white/5 hover:text-fg",
                )}
              >
                <Icon />
                {label}
              </Link>
            );
          })}
        </nav>
        <p className="hidden px-5 pt-8 text-xs leading-relaxed text-muted lg:block">
          Alertas do Datadog como máquina de estados, com remediação e trilha de auditoria.
        </p>
      </aside>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
