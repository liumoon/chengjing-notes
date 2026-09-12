// JSDOM uses an opaque origin by default, which disables Web Storage.
// Give tests a deterministic in-memory storage without changing app behavior.
if (typeof globalThis.localStorage === "undefined") {
  const values = new Map<string, string>();
  const storage = {} as Storage;
  Object.defineProperties(storage, {
    length: {
      configurable: true,
      enumerable: false,
      get: () => values.size,
    },
    clear: {
      configurable: true,
      enumerable: false,
      value: () => {
        for (const key of values.keys()) delete (storage as Record<string, unknown>)[key];
        values.clear();
      },
    },
    getItem: {
      configurable: true,
      enumerable: false,
      value: (key: string) => (values.has(key) ? values.get(key)! : null),
    },
    key: {
      configurable: true,
      enumerable: false,
      value: (index: number) => [...values.keys()][index] ?? null,
    },
    removeItem: {
      configurable: true,
      enumerable: false,
      value: (key: string) => {
        values.delete(key);
        delete (storage as Record<string, unknown>)[key];
      },
    },
    setItem: {
      configurable: true,
      enumerable: false,
      value: (key: string, value: string) => {
        const normalizedKey = String(key);
        const normalizedValue = String(value);
        values.set(normalizedKey, normalizedValue);
        Object.defineProperty(storage, normalizedKey, {
          configurable: true,
          enumerable: true,
          value: normalizedValue,
          writable: true,
        });
      },
    },
  });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  if (typeof window !== "undefined") Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
}
