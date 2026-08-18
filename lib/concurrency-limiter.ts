type Waiter = {
  limit: number;
  resolve: () => void;
};

export function createConcurrencyLimiter() {
  let active = 0;
  const queue: Waiter[] = [];

  function drain() {
    while (queue.length > 0 && active < queue[0].limit) {
      const waiter = queue.shift();
      if (!waiter) return;
      active += 1;
      waiter.resolve();
    }
  }

  return {
    async run<T>(requestedLimit: number, task: () => Promise<T>): Promise<T> {
      const normalizedLimit = Number.isFinite(requestedLimit) ? Math.round(requestedLimit) : 4;
      const limit = Math.min(6, Math.max(1, normalizedLimit));
      if (queue.length > 0 || active >= limit) {
        await new Promise<void>((resolve) => queue.push({ limit, resolve }));
      } else {
        active += 1;
      }

      try {
        return await task();
      } finally {
        active -= 1;
        drain();
      }
    },
  };
}
