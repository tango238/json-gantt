const raw = import.meta.glob("./fixtures/*.jsonl", { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;

/** Lines of fixtures/<name>.jsonl. */
export function fixtureLines(name: string): string[] {
  const text = raw[`./fixtures/${name}.jsonl`];
  if (text === undefined) throw new Error(`missing fixture ${name}`);
  return text.split("\n").filter((l, i, a) => !(i === a.length - 1 && l === ""));
}
