"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { btnPrimary, btnSecondary, Card, field, SectionTitle } from "@/components/ui/ui";
import { formatTime } from "@/lib/format";
import { providerLabel } from "@/providers/catalog";
import { cn } from "@/lib/utils";

const DURATIONS = [
  { label: "15 minutos", minutes: 15 },
  { label: "1 hora", minutes: 60 },
  { label: "4 horas", minutes: 240 },
  { label: "24 horas", minutes: 1440 },
  { label: "3 dias", minutes: 4320 },
  { label: "7 dias (máximo)", minutes: 10080 },
];

type Props = {
  alertId: number;
  provider: string;
  /** API do provedor configurada e provedor suportado. */
  enabled: boolean;
  mute: { until: string; scope: string | null; reason: string | null; by: string | null; at: string | null } | null;
  /** Fim de um silêncio anterior que já expirou (informativo). */
  expiredAt: string | null;
  /** Operação sem desfecho gravado (queda entre o provedor e o banco): será reexecutada. */
  pending: { action: string; since: string } | null;
};

export function MuteControl({ alertId, provider, enabled, mute, expiredAt, pending: pendingOp }: Props) {
  const router = useRouter();
  const [minutes, setMinutes] = useState(60);
  const [reason, setReason] = useState("");
  const [scope, setScope] = useState("");
  const [allScopes, setAllScopes] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [pending, setPending] = useState(false);

  async function send(event: FormEvent, action: "mute" | "unmute") {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setErrors([]);
    try {
      const body = action === "mute" ? { minutes, reason, ...(scope.trim() ? { scope: scope.trim() } : {}) } : { reason: reason || undefined, allScopes };
      const response = await fetch(`/api/alerts/${alertId}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setErrors(data.issues ? data.issues.map((i: { path: string; message: string }) => `${i.path || "corpo"}: ${i.message}`) : [data.error ?? `Erro ${response.status}`]);
        return;
      }
      setReason("");
      router.refresh();
    } catch {
      setErrors(["Não foi possível falar com o servidor."]);
    } finally {
      setPending(false);
    }
  }

  const label = providerLabel(provider);

  return (
    <Card className="flex flex-col gap-4">
      <SectionTitle>Silêncio no {label}</SectionTitle>
      {!enabled ? (
        <p className="text-sm text-muted">
          Indisponível: a API do provedor não está configurada neste servidor (<code>DD_API_KEY</code> e <code>DD_APP_KEY</code>) ou o provedor <strong>{provider}</strong> não suporta silenciar.
        </p>
      ) : (
        <form onSubmit={(e) => void send(e, mute ? "unmute" : "mute")} className="flex flex-col gap-4">
          {mute ? (
            <div className="rounded-2xl border border-warn/35 bg-warn/10 p-4 text-sm">
              <p className="font-medium text-warn">Silenciado até {formatTime(mute.until)}</p>
              <p className="mt-1 text-muted">
                {mute.reason ?? "sem motivo registrado"} · por {mute.by ?? "—"}
                {mute.scope && <> · escopo <code className="font-mono text-xs">{mute.scope}</code></>}
              </p>
              <p className="mt-2 text-xs text-muted">
                Durante o silêncio o {label} não envia notificações nem webhooks: o estado mostrado aqui pode estar desatualizado até o silêncio acabar ou ser removido.
              </p>
            </div>
          ) : (
            <>
              {expiredAt && <p className="text-xs text-muted">O silêncio anterior expirou em {formatTime(expiredAt)}.</p>}
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="flex flex-col gap-1.5 text-sm text-muted">
                  Duração (obrigatória)
                  <select className={field} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
                    {DURATIONS.map((d) => <option key={d.minutes} value={d.minutes}>{d.label}</option>)}
                  </select>
                </label>
                <label className="flex flex-col gap-1.5 text-sm text-muted">
                  Escopo (opcional, ex.: host:app1)
                  <input className={field} value={scope} onChange={(e) => setScope(e.target.value)} />
                </label>
              </div>
            </>
          )}
          <label className="flex flex-col gap-1.5 text-sm text-muted">
            {mute ? "Motivo (opcional)" : "Motivo (obrigatório, fica na auditoria)"}
            <input required={!mute} minLength={mute ? undefined : 3} maxLength={300} className={field} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={mute ? "" : "Ex.: deploy em andamento"} />
          </label>
          {mute && (
            <label className="flex cursor-pointer items-center gap-2 text-sm text-muted">
              <input type="checkbox" className="size-4 accent-accent" checked={allScopes} onChange={(e) => setAllScopes(e.target.checked)} />
              Limpar o silêncio em todos os escopos
            </label>
          )}
          {pendingOp && (
            <p role="status" className="rounded-2xl border border-warn/35 bg-warn/10 p-3 text-sm text-warn">
              Há uma operação de {pendingOp.action === "mute" ? "silenciar" : "reativar"} sem desfecho gravado desde {formatTime(pendingOp.since)}. Ela é reexecutada
              automaticamente (na próxima reconciliação ou em <code>POST /api/mute-operations/recover</code>); novas operações neste alerta aguardam.
            </p>
          )}
          {errors.length > 0 && (
            <ul role="alert" className="list-disc rounded-2xl border border-alert/40 bg-alert/10 p-4 pl-8 text-sm text-alert-fg">
              {errors.map((e) => <li key={e}>{e}</li>)}
            </ul>
          )}
          <button type="submit" disabled={pending} className={cn(mute ? btnSecondary : btnPrimary, "self-start")}>
            {pending ? "Enviando…" : mute ? "Remover silêncio" : `Silenciar no ${label}`}
          </button>
        </form>
      )}
    </Card>
  );
}
