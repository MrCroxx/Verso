export function createLatestTaskRegistry<Key>() {
  const tasks = new Map<Key, symbol>();

  return {
    start(key: Key, replace = false) {
      if (!replace && tasks.has(key)) return null;
      const token = Symbol("task");
      tasks.set(key, token);
      return token;
    },

    isCurrent(key: Key, token: symbol) {
      return tasks.get(key) === token;
    },

    finish(key: Key, token: symbol) {
      if (tasks.get(key) !== token) return false;
      tasks.delete(key);
      return true;
    },

    cancel(key: Key) {
      return tasks.delete(key);
    },

    cancelAll() {
      tasks.clear();
    },
  };
}
