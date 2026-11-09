import ja from "./ja.json";

export type Params = Record<string, string | number>;

function lookup(key: string): string | undefined {
  let cur: unknown = ja;
  for (const part of key.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === "string" ? cur : undefined;
}

/** Translate a dot-separated key; `{name}` placeholders are replaced from params. */
export function t(key: string, params?: Params): string {
  const raw = lookup(key);
  if (raw === undefined) {
    if (import.meta.env?.DEV) console.warn(`[i18n] missing key: ${key}`);
    return key;
  }
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}
