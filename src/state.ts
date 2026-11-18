// Durable local state: the Agent Link cursor and recently processed event ids (dedupe across restarts).
// A small JSON file (OpenClaw keeps conversation history itself, keyed by channel + sender).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MAX_IDS = 5000;

type Shape = { cursor: number; processed: string[] };

export class LinkState {
  private cursorValue = 0;
  private ids = new Set<string>();
  private order: string[] = [];

  constructor(private readonly path: string | null) {
    if (!path) return;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Shape>;
      this.cursorValue = Number(raw.cursor ?? 0) || 0;
      for (const id of raw.processed ?? []) this.remember(id);
    } catch {
      /* first run */
    }
  }

  cursor(): number {
    return this.cursorValue;
  }

  setCursor(seq: number): boolean {
    if (seq <= this.cursorValue) return false;
    this.cursorValue = seq;
    this.flush();
    return true;
  }

  seen(id: string): boolean {
    return this.ids.has(id);
  }

  markProcessed(id: string): void {
    if (this.ids.has(id)) return;
    this.remember(id);
    this.flush();
  }

  private remember(id: string): void {
    this.ids.add(id);
    this.order.push(id);
    while (this.order.length > MAX_IDS) this.ids.delete(this.order.shift()!);
  }

  private flush(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ cursor: this.cursorValue, processed: this.order } satisfies Shape));
    renameSync(tmp, this.path);
  }
}
