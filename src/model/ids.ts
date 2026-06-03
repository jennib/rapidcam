/** Monotonic id generation, namespaced by prefix (e.g. "ent", "con", "dim"). */

const counters: Record<string, number> = {};

export function nextId(prefix: string): string {
  counters[prefix] = (counters[prefix] ?? 0) + 1;
  return `${prefix}${counters[prefix]}`;
}
