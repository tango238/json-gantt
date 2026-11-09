import { useEffect, useRef, useState, type KeyboardEvent } from "react";

/**
 * Text-like input that edits a local draft and commits on blur / Enter.
 * `commit` returns false to reject the draft (it is reverted and flagged invalid).
 * Escape reverts without committing; an unconfirmed draft is committed when the input unmounts
 * (e.g. the selection changes), unless it was reverted.
 */
export function CommitInput({
  value,
  commit,
  multiline,
  rows,
  type = "text",
  disabled,
  ariaLabel,
  testId,
  extra,
  commitOnChange,
}: {
  value: string;
  commit: (draft: string) => boolean | void;
  multiline?: boolean;
  rows?: number;
  type?: "text" | "number" | "date";
  disabled?: boolean;
  ariaLabel?: string;
  testId?: string;
  extra?: { min?: number; step?: number };
  /** Commit immediately on change when this returns true for the new draft (e.g. a complete date). */
  commitOnChange?: (draft: string) => boolean;
}) {
  const [draft, setDraftState] = useState(value);
  const [invalid, setInvalid] = useState(false);
  const draftRef = useRef(value);
  const valueRef = useRef(value);
  const dirtyRef = useRef(false);
  const badInputRef = useRef(false);
  const resyncRef = useRef(false);
  const commitRef = useRef(commit);
  commitRef.current = commit;
  valueRef.current = value;

  const setDraft = (v: string) => {
    draftRef.current = v;
    setDraftState(v);
  };

  useEffect(() => {
    draftRef.current = value;
    dirtyRef.current = false;
    setDraftState(value);
    setInvalid(false);
  }, [value]);

  // After a successful commit, show the (possibly normalised) stored value again.
  useEffect(() => {
    if (resyncRef.current) {
      resyncRef.current = false;
      draftRef.current = valueRef.current;
      setDraftState(valueRef.current);
    }
  });

  const apply = () => {
    const d = draftRef.current;
    if (!badInputRef.current && d === valueRef.current) {
      dirtyRef.current = false;
      return;
    }
    dirtyRef.current = false;
    if (badInputRef.current || commitRef.current(d) === false) {
      badInputRef.current = false;
      setDraft(valueRef.current);
      setInvalid(true);
    } else {
      setInvalid(false);
      resyncRef.current = true;
    }
  };

  useEffect(
    () => () => {
      if (dirtyRef.current && !badInputRef.current && draftRef.current !== valueRef.current) {
        dirtyRef.current = false;
        commitRef.current(draftRef.current);
      }
    },
    [],
  );

  const onChange = (e: { target: HTMLInputElement | HTMLTextAreaElement }) => {
    badInputRef.current = "validity" in e.target && e.target.validity.badInput;
    dirtyRef.current = true;
    setInvalid(false);
    setDraft(e.target.value);
    if (commitOnChange?.(e.target.value)) apply();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      badInputRef.current = false;
      dirtyRef.current = false;
      setDraft(valueRef.current);
      setInvalid(false);
      (e.target as HTMLElement).blur();
    } else if (e.key === "Enter" && !multiline) {
      e.preventDefault();
      apply();
    }
  };
  const common = {
    value: draft,
    disabled,
    "aria-label": ariaLabel,
    "data-testid": testId,
    className: invalid ? "invalid" : undefined,
    onBlur: apply,
    onKeyDown,
    onChange,
  };
  return multiline ? <textarea {...common} rows={rows ?? 4} /> : <input {...common} type={type} {...extra} />;
}

/** Subscribes to the native `change` event (fires when a slider / colour picker is released). */
export function useNativeChange<E extends HTMLInputElement>(handler: (value: string) => void) {
  const ref = useRef<E>(null);
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fn = () => latest.current(el.value);
    el.addEventListener("change", fn);
    return () => el.removeEventListener("change", fn);
  }, []);
  return ref;
}
