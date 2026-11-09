/** Generate a new lowercase UUID v4. Not for use inside src/engine. */
export function newId(): string {
  return crypto.randomUUID().toLowerCase();
}

/** Case-insensitive key for ID comparison and Map keys. */
export function idKey(id: string): string {
  return id.toLowerCase();
}
