"use client";

import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Position,
  useInternalNode,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import type { AlertState } from "@/domain/alert-machine";
import { cn } from "@/lib/utils";
import { edgeSegment } from "./geometry";
import { NODE_SIZE, STATE_META } from "./meta";

export type StateNodeType = Node<{ state: AlertState; count?: number; active: boolean }, "state">;
export type TransitionEdgeType = Edge<{ active: boolean; dimmed: boolean; labelAt: number }, "transition">;

// Os handles existem só para o React Flow aceitar as arestas; ficam invisíveis.
const hiddenHandle = "!pointer-events-none !opacity-0";

export function StateNode({ data }: NodeProps<StateNodeType>) {
  const meta = STATE_META[data.state];
  return (
    <div
      style={NODE_SIZE}
      className={cn(
        "flex items-center gap-3 rounded-2xl border px-4 shadow-lg shadow-black/30",
        meta.tone,
        data.active && "ring-2 ring-accent-soft ring-offset-2 ring-offset-bg",
      )}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} className={hiddenHandle} />
      <span aria-hidden className="text-2xl font-bold leading-none">{meta.glyph}</span>
      <span className="flex flex-col leading-tight">
        <span className="font-semibold text-fg">{meta.label}</span>
        <span className="font-mono text-xs opacity-80">{data.state}</span>
        {data.count !== undefined && <span className="text-xs text-muted">{data.count} monitores</span>}
      </span>
      <Handle type="source" position={Position.Bottom} isConnectable={false} className={hiddenHandle} />
    </div>
  );
}

export function TransitionEdge({ id, source, target, label, data, markerEnd }: EdgeProps<TransitionEdgeType>) {
  const from = useInternalNode(source);
  const to = useInternalNode(target);
  if (!from || !to) return null;
  const center = (n: typeof from) => ({
    x: n.internals.positionAbsolute.x + (n.measured.width ?? NODE_SIZE.width) / 2,
    y: n.internals.positionAbsolute.y + (n.measured.height ?? NODE_SIZE.height) / 2,
  });
  const seg = edgeSegment(center(from), center(to), NODE_SIZE, 14);
  if (!seg) return null;
  const active = data?.active;
  const t = data?.labelAt ?? 0.5;
  const label_ = { x: seg.start.x + (seg.end.x - seg.start.x) * t, y: seg.start.y + (seg.end.y - seg.start.y) * t };
  return (
    <>
      <BaseEdge
        id={id}
        path={`M ${seg.start.x},${seg.start.y} L ${seg.end.x},${seg.end.y}`}
        markerEnd={markerEnd}
        style={{
          stroke: active ? "#a78bfa" : "#4b4d63",
          strokeWidth: active ? 2.5 : 1.5,
          opacity: data?.dimmed ? 0.25 : 1,
        }}
      />
      <EdgeLabelRenderer>
        <div
          style={{ transform: `translate(-50%, -50%) translate(${label_.x}px, ${label_.y}px)`, opacity: data?.dimmed ? 0.35 : 1 }}
          className={cn(
            "pointer-events-none absolute rounded-md bg-surface px-1.5 py-0.5 text-[11px] text-muted",
            active && "font-semibold text-accent-soft",
          )}
        >
          {label}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
