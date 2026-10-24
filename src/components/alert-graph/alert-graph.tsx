"use client";

import { useMemo, useState } from "react";
import { Background, Controls, MarkerType, MiniMap, ReactFlow, type EdgeTypes, type NodeChange, type NodeTypes } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ALERT_STATES, TRANSITIONS, listEdges, type AlertState } from "@/domain/alert-machine";
import { SectionTitle } from "@/components/ui/ui";
import { cn } from "@/lib/utils";
import { edgeSegment, placeLabels } from "./geometry";
import { StateNode, TransitionEdge, type StateNodeType, type TransitionEdgeType } from "./flow-parts";
import { EVENT_LABEL, NODE_SIZE, STATE_META } from "./meta";

const nodeTypes: NodeTypes = { state: StateNode };
const edgeTypes: EdgeTypes = { transition: TransitionEdge };
const edgeDefs = listEdges();
const center = (state: AlertState) => ({ x: STATE_META[state].position.x + NODE_SIZE.width / 2, y: STATE_META[state].position.y + NODE_SIZE.height / 2 });
const segments = edgeDefs.flatMap((e) => edgeSegment(center(e.from), center(e.to), NODE_SIZE, 14) ?? []);
const nodeRects = ALERT_STATES.map((s) => ({ ...STATE_META[s].position, ...NODE_SIZE }));
// Fração do rótulo ao longo de cada aresta, calculada uma vez para o layout padrão.
const labelAt = placeLabels(segments, { width: 84, height: 20 }, nodeRects);

type Props = { counts?: Partial<Record<AlertState, number>> };

export function AlertGraph({ counts }: Props) {
  const [selected, setSelected] = useState<AlertState | null>(null);
  const [dragged, setDragged] = useState<Record<string, { x: number; y: number }>>({});
  const onNodesChange = (changes: NodeChange<StateNodeType>[]) => {
    for (const change of changes) {
      if (change.type === "position" && change.position) {
        const { id, position } = change;
        setDragged((d) => ({ ...d, [id]: position as { x: number; y: number } }));
      }
    }
  };

  const nodes = useMemo<StateNodeType[]>(
    () =>
      ALERT_STATES.map((state) => ({
        id: state,
        type: "state",
        position: dragged[state] ?? STATE_META[state].position,
        // Tamanho explícito: o fluxo é controlado e o minimapa só desenha nós com dimensões conhecidas.
        width: NODE_SIZE.width,
        height: NODE_SIZE.height,
        data: { state, count: counts?.[state], active: selected === state },
      })),
    [counts, selected, dragged],
  );

  const edges = useMemo<TransitionEdgeType[]>(
    () =>
      edgeDefs.map((e, index) => {
        const active = selected === e.from;
        return {
          id: `${e.from}-${e.event}`,
          type: "transition",
          source: e.from,
          target: e.to,
          label: EVENT_LABEL[e.event],
          markerEnd: { type: MarkerType.ArrowClosed, color: active ? "#a78bfa" : "#4b4d63" },
          data: { active, dimmed: selected !== null && !active, labelAt: labelAt[index] },
        };
      }),
    [selected],
  );

  const toggle = (state: AlertState) => setSelected((current) => (current === state ? null : state));

  return (
    <div className="flex flex-col gap-6">
      <div
        role="region"
        aria-label="Grafo da máquina de estados. A mesma informação está na lista abaixo."
        className="h-[560px] w-full overflow-hidden rounded-2xl border border-line bg-surface"
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          colorMode="dark"
          fitView
          fitViewOptions={{ padding: 0.15, duration: 0 }}
          minZoom={0.4}
          maxZoom={1.8}
          nodesConnectable={false}
          deleteKeyCode={null}
          onNodeClick={(_, node) => toggle(node.id as AlertState)}
          onPaneClick={() => setSelected(null)}
        >
          <Background />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable ariaLabel="Mapa geral do grafo" nodeColor={(n) => STATE_META[n.id as AlertState].hex} />
        </ReactFlow>
      </div>

      <section aria-labelledby="transitions-heading" className="flex flex-col gap-3">
        <SectionTitle id="transitions-heading">Estados e transições</SectionTitle>
        <p className="text-sm text-muted">Selecione um estado (no grafo ou aqui) para destacar as transições que saem dele.</p>
        <ul className="grid gap-3 sm:grid-cols-2">
          {ALERT_STATES.map((state) => (
            <li key={state} className={cn("rounded-2xl border p-4", STATE_META[state].tone, selected === state && "ring-2 ring-accent-soft")}>
              <button
                type="button"
                aria-pressed={selected === state}
                onClick={() => toggle(state)}
                className="flex w-full items-center gap-2 rounded text-left font-semibold text-fg"
              >
                <span aria-hidden className={cn("size-2 rounded-full", STATE_META[state].dot)} />
                {STATE_META[state].label}
                <span className="font-mono text-xs font-normal text-muted">{state}</span>
                {counts?.[state] !== undefined && <span className="ml-auto text-sm">{counts[state]} monitores</span>}
              </button>
              <ul className="mt-2 list-disc pl-6 text-sm text-fg/80">
                {Object.entries(TRANSITIONS[state]).map(([event, to]) => (
                  <li key={event}>
                    {EVENT_LABEL[event as keyof typeof EVENT_LABEL]} → {STATE_META[to as AlertState].label}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
