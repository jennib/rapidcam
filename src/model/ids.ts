/** Monotonic id generation, namespaced by prefix (e.g. "ent", "con", "dim"). */

const counters: Record<string, number> = {};

export function nextId(prefix: string): string {
  counters[prefix] = (counters[prefix] ?? 0) + 1;
  return `${prefix}${counters[prefix]}`;
}

export function updateCounter(id: string): void {
  const match = id.match(/^([a-zA-Z]+)(\d+)$/);
  if (match) {
    const prefix = match[1];
    const num = parseInt(match[2], 10);
    if (!counters[prefix] || counters[prefix] < num) {
      counters[prefix] = num;
    }
  }
}
