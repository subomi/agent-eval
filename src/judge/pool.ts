/**
 * Minimal promise pool: at most `limit` tasks run concurrently, excess tasks
 * queue FIFO. The judge wraps every model call in this so metric code can
 * fire evaluations freely without overwhelming the provider.
 */
export class PromisePool {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`PromisePool limit must be a positive integer, got ${limit}`);
    }
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    // Hand the slot directly to the next waiter (keeps `active` accurate even
    // when new run() calls race the release).
    const next = this.waiting.shift();
    if (next) {
      next();
    } else {
      this.active -= 1;
    }
  }
}
