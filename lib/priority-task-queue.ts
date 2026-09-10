type Job<T> = {
  key: string;
  priority: number;
  limit: number;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  promise: Promise<T>;
};

// Running work is shared, never interrupted when a reader joins a background job.
export function createPriorityTaskQueue<T>() {
  const jobs = new Map<string, Job<T>>();
  const pending: Job<T>[] = [];
  let active = 0;
  function drain() {
    pending.sort((a, b) => b.priority - a.priority);
    while (pending.length && active < pending[0].limit) {
      const job = pending.shift()!;
      active++;
      const finish = () => {
        active--;
        jobs.delete(job.key);
        drain();
      };
      void Promise.resolve().then(job.run).then(
        (value) => { finish(); job.resolve(value); },
        (error) => { finish(); job.reject(error); },
      );
    }
  }
  function enqueue(key: string, priority: number, limit: number, run: () => Promise<T>, force = false): Promise<T> {
      const existing = jobs.get(key);
      if (existing && force) return existing.promise.catch(() => undefined).then(() => enqueue(key, priority, limit, run));
      if (existing) {
        existing.priority = Math.max(existing.priority, priority);
        drain();
        return existing.promise;
      }
      let resolve!: Job<T>["resolve"];
      let reject!: Job<T>["reject"];
      const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
      const job = { key, priority, limit: Math.max(1, Math.min(6, limit)), run, resolve, reject, promise };
      jobs.set(key, job);
      pending.push(job);
      drain();
      return promise;
  }
  return { run: enqueue, has: (key: string) => jobs.has(key) };
}
