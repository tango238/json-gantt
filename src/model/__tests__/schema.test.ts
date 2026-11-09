import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

const load = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const schema = load("../../../schema/gantt.schema.json");
const sample = load("../../../schema/examples/sample.json");

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

function mutate(f: (d: any) => void) {
  const d = structuredClone(sample);
  f(d);
  return validate(d);
}

describe("gantt.schema.json", () => {
  it("sample.json is valid", () => {
    expect(validate(sample)).toBe(true);
  });
  it("rejects version 2", () => {
    expect(mutate((d) => (d.version = 2))).toBe(false);
  });
  it("rejects progress 101", () => {
    expect(mutate((d) => (d.tasks.find((t: any) => t.progress !== undefined).progress = 101))).toBe(false);
  });
  it("rejects invalid start date", () => {
    expect(mutate((d) => (d.tasks.find((t: any) => t.start).start = "2023-13-01"))).toBe(false);
  });
  it("rejects missing tasks", () => {
    expect(mutate((d) => delete d.tasks)).toBe(false);
  });
  it("accepts unknown fields on a task", () => {
    expect(mutate((d) => (d.tasks[0].custom = 1))).toBe(true);
  });
});
