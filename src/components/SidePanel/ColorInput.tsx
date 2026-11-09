import { useEffect, useState } from "react";
import { useNativeChange } from "./fields";

/**
 * Colour picker that commits once when the picker is closed (native `change`).
 * While picking, the displayed colour is local state; it resyncs to `value` afterwards.
 */
export function ColorInput({ value, label, onCommit }: { value: string; label: string; onCommit: (c: string) => void }) {
  const [shown, setShown] = useState(value.toLowerCase());
  useEffect(() => setShown(value.toLowerCase()), [value]);
  const ref = useNativeChange<HTMLInputElement>((v) => {
    if (v.toLowerCase() !== value.toLowerCase()) onCommit(v.toUpperCase());
    else setShown(value.toLowerCase());
  });
  return (
    <input
      ref={ref}
      type="color"
      value={shown}
      onChange={(e) => setShown(e.target.value)}
      aria-label={label}
      className="color-input"
    />
  );
}
