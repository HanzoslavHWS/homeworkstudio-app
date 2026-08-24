"use client";

import { useEffect, useState } from "react";
import { clampToGridMm, INDIVIDUAL_GRID_MM } from "../../geometry/placement";

type PlotSizeInputProps = {
  label: string;
  value: number;
  onCommit: (value: number) => void;
};

export function PlotSizeInput({ label, value, onCommit }: PlotSizeInputProps) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  function commit() {
    const parsed = Number(draft);
    const next = draft.trim() !== "" && Number.isFinite(parsed) ? clampToGridMm(parsed) : value;
    setDraft(String(next));
    if (next !== value) onCommit(next);
  }

  return (
    <label className="coordinateField">
      <span className="coordinateAxis">{label}</span>
      <span className="coordinateInputWrap">
        <input
          type="number"
          inputMode="numeric"
          step={INDIVIDUAL_GRID_MM}
          min={INDIVIDUAL_GRID_MM}
          value={draft}
          aria-label={`${label} v milimetrech, krok ${INDIVIDUAL_GRID_MM} mm`}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            }
            if (event.key === "Escape") {
              setDraft(String(value));
              event.currentTarget.blur();
            }
          }}
        />
        <span className="coordinateUnit">mm</span>
      </span>
    </label>
  );
}
