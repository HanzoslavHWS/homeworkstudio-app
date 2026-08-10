import { useEffect, useState } from "react";

type CoordinateInputProps = {
  axis: "X" | "Y";
  value: number;
  disabled: boolean;
  onCommit: (value: number) => boolean;
};

export function CoordinateInput({
  axis,
  value,
  disabled,
  onCommit,
}: CoordinateInputProps) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  function commit() {
    const nextValue = Number(draft);

    if (draft.trim() === "" || !Number.isFinite(nextValue) || !onCommit(nextValue)) {
      setDraft(String(value));
    }
  }

  return (
    <label className="coordinateField">
      <span className="coordinateAxis">{axis}</span>
      <span className="coordinateInputWrap">
        <input
          type="number"
          inputMode="numeric"
          step="1"
          value={draft}
          disabled={disabled}
          aria-label={`Souřadnice ${axis} v milimetrech`}
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
