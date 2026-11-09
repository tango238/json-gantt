import { idKey } from "../../model/id";
import { memo } from "react";
import { COLORS } from "./constants";
import type { ArrowLayout } from "./layout";

interface Props {
  arrows: readonly ArrowLayout[];
  selectedId: string | null;
  selectedDependency: { succId: string; predId: string } | null;
  onSelectDependency: (dep: { succId: string; predId: string }) => void;
}

function ArrowsImpl({ arrows, selectedId, selectedDependency, onSelectDependency }: Props) {
  const sel = selectedId !== null ? idKey(selectedId) : null;
  const dep = selectedDependency;
  return (
    <g className="arrows">
      {arrows.map((a, i) => {
        const isDep =
          dep !== null &&
          idKey(dep.succId) === idKey(a.succId) &&
          idKey(dep.predId) === idKey(a.predId);
        const related = sel !== null && (idKey(a.succId) === sel || idKey(a.predId) === sel);
        // A violation (red) outranks the selection highlight (blue); the selection still shows via stroke width.
        const color = a.violated ? COLORS.arrowViolated : related || isDep ? COLORS.selection : COLORS.arrow;
        return (
          <g key={`${a.succId}|${a.predId}|${i}`} data-succ-id={a.succId} data-pred-id={a.predId}>
            <path d={a.d} fill="none" stroke={color} strokeWidth={isDep ? 2 : 1.2} />
            <polygon points={a.head} fill={color} />
            <path
              d={a.d}
              fill="none"
              stroke="transparent"
              strokeWidth={8}
              style={{ cursor: "pointer" }}
              onClick={(e) => {
                e.stopPropagation();
                onSelectDependency({ succId: a.succId, predId: a.predId });
              }}
            />
          </g>
        );
      })}
    </g>
  );
}

export const Arrows = memo(ArrowsImpl);
