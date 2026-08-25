export function createSharedTaskRegistry<Key, Value>() {
  const tasks = new Map<Key, Promise<Value>>();

  return {
    run(key: Key, task: () => Promise<Value>) {
      const existing = tasks.get(key);
      if (existing) return existing;
      const promise = task().catch((error) => {
        if (tasks.get(key) === promise) tasks.delete(key);
        throw error;
      });
      tasks.set(key, promise);
      return promise;
    },

    clear() {
      tasks.clear();
    },

    size() {
      return tasks.size;
    },
  };
}
