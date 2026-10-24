import type { AlertEvent, AlertState } from "@/domain/alert-machine";

export const NODE_SIZE = { width: 176, height: 76 };

type StateMeta = {
  label: string;
  glyph: string;
  position: { x: number; y: number };
  /** Cartão/badge tingido (borda, fundo e texto). */
  tone: string;
  /** Ponto e barras de cor cheia. */
  dot: string;
  hex: string;
};

// Posição (canto superior esquerdo) de cada estado: K4 desenhado sem cruzamentos,
// com "warn" no centro do triângulo ok/alert/no_data.
export const STATE_META: Record<AlertState, StateMeta> = {
  ok: {
    label: "OK",
    glyph: "✓",
    position: { x: 0, y: 0 },
    tone: "border-ok/30 bg-ok/10 text-ok",
    dot: "bg-ok",
    hex: "#7cffb2",
  },
  alert: {
    label: "Alerta",
    glyph: "✕",
    position: { x: 680, y: 0 },
    tone: "border-alert/40 bg-alert/10 text-alert-fg",
    dot: "bg-alert",
    hex: "#ef4444",
  },
  warn: {
    label: "Aviso",
    glyph: "!",
    position: { x: 340, y: 170 },
    tone: "border-warn/35 bg-warn/10 text-warn",
    dot: "bg-warn",
    hex: "#f59e0b",
  },
  no_data: {
    label: "Sem dados",
    glyph: "?",
    position: { x: 340, y: 400 },
    tone: "border-nodata/35 bg-nodata/10 text-nodata",
    dot: "bg-nodata",
    hex: "#94a3b8",
  },
};

export const EVENT_LABEL: Record<AlertEvent, string> = {
  recovered: "recuperado",
  warned: "aviso",
  triggered: "disparado",
  data_missing: "sem dados",
};
