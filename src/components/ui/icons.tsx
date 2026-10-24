import type { SVGProps } from "react";

// Ícones de traço (24x24), decorativos: o significado sempre vem também em texto.
const base = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

const make = (path: string) =>
  function Icon(props: SVGProps<SVGSVGElement>) {
    return (
      <svg {...base} {...props}>
        <path d={path} />
      </svg>
    );
  };

export const MapIcon = make("M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14");
export const BellIcon = make("M6 8a6 6 0 0112 0c0 7 3 8 3 8H3s3-1 3-8M10 20a2 2 0 004 0");
export const PlusIcon = make("M12 5v14M5 12h14");
export const FlowIcon = make("M5 5h4v4H5zM15 5h4v4h-4zM10 15h4v4h-4zM7 9v2a2 2 0 002 2h6a2 2 0 002-2V9M12 13v2");
export const LayersIcon = make("M12 3l9 5-9 5-9-5zM3 13l9 5 9-5");
export const CheckIcon = make("M5 12l5 5 9-10");
export const WarnIcon = make("M12 4l9 16H3zM12 10v4M12 17.5v.01");
export const AlertIcon = make("M12 3a9 9 0 100 18 9 9 0 000-18zM12 8v5M12 16.5v.01");
export const HelpIcon = make("M12 3a9 9 0 100 18 9 9 0 000-18zM9.5 9.5a2.5 2.5 0 114 2c-.8.6-1.5 1-1.5 2M12 17v.01");
export const ChevronRightIcon = make("M9 6l6 6-6 6");
export const ActivityIcon = make("M3 12h4l3-8 4 16 3-8h4");
