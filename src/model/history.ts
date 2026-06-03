/** Undo/redo stack. Push a snapshot BEFORE each mutation. */
export class History<T> {
  private past: T[] = [];
  private future: T[] = [];

  push(snapshot: T): void {
    this.past.push(snapshot);
    this.future = [];
    if (this.past.length > 100) this.past.shift();
  }

  undo(current: T): T | null {
    if (!this.past.length) return null;
    this.future.push(current);
    return this.past.pop()!;
  }

  redo(current: T): T | null {
    if (!this.future.length) return null;
    this.past.push(current);
    return this.future.pop()!;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }
}
