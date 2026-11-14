/**
 * Fila serial controlada para processamento de notas sem concorrencia de escrita,
 * adaptada de `src/promiseQueue.ts` (`obsidian-git`).
 */

export interface EnqueueOptions {
  /** Chave de deduplicacao opcional (ex.: caminho normalizado NFC) para evitar enfileiramento duplicado. */
  key?: string | undefined;
}

export class SerialPromiseQueue {
  private tail: Promise<void> = Promise.resolve();
  private readonly pendingKeys = new Set<string>();
  private activeCount = 0;

  constructor(private readonly minIntervalMs: number = 0) {}

  get size(): number {
    return this.activeCount;
  }

  hasKey(key: string): boolean {
    return this.pendingKeys.has(key);
  }

  enqueue<T>(task: () => Promise<T>, options: EnqueueOptions = {}): Promise<T | undefined> {
    const key = options.key;
    if (key && this.pendingKeys.has(key)) {
      return Promise.resolve(undefined);
    }

    if (key) {
      this.pendingKeys.add(key);
    }
    this.activeCount += 1;

    const run = async (): Promise<T> => {
      try {
        const result = await task();
        if (this.minIntervalMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.minIntervalMs));
        }
        return result;
      } finally {
        this.activeCount = Math.max(0, this.activeCount - 1);
        if (key) {
          this.pendingKeys.delete(key);
        }
      }
    };

    const next = this.tail.then(run, run);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async onIdle(): Promise<void> {
    await this.tail;
  }
}
