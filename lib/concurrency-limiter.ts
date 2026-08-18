type Waiter = {
  limit: number;
  resolve: () => void;
  signal?: AbortSignal;
  abort?: () => void;
};

function cancellationReason(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The queued task was cancelled.", "AbortError");
}

export function createConcurrencyLimiter() {
  let active = 0;
  const queue: Waiter[] = [];

  function drain() {
    while (queue.length > 0 && active < queue[0].limit) {
      const waiter = queue.shift();
      if (!waiter) return;
      active += 1;
      if (waiter.signal && waiter.abort) waiter.signal.removeEventListener("abort", waiter.abort);
      waiter.resolve();
    }
  }

  return {
    async run<T>(requestedLimit: number, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      const normalizedLimit = Number.isFinite(requestedLimit) ? Math.round(requestedLimit) : 4;
      const limit = Math.min(6, Math.max(1, normalizedLimit));
      if (signal?.aborted) throw cancellationReason(signal);
      if (queue.length > 0 || active >= limit) {
        await new Promise<void>((resolve, reject) => {
          const waiter: Waiter = { limit, resolve, signal };
          if (signal) {
            waiter.abort = () => {
              const index = queue.indexOf(waiter);
              if (index < 0) return;
              queue.splice(index, 1);
              reject(cancellationReason(signal));
              drain();
            };
            signal.addEventListener("abort", waiter.abort, { once: true });
          }
          queue.push(waiter);
        });
      } else {
        active += 1;
      }

      try {
        if (signal?.aborted) throw cancellationReason(signal);
        return await task();
      } finally {
        active -= 1;
        drain();
      }
    },
  };
}
