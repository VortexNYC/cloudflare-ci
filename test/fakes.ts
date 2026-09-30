// Shared fakes for the DO-level unit tests.
export const DO_DEATH =
  "Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.";

export type FakeStorage = {
  map: Map<string, unknown>;
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options?: { prefix?: string }): Promise<Map<string, T>>;
};

export function makeStorage(): FakeStorage {
  const map = new Map<string, unknown>();
  return {
    map,
    async get<T>(key: string) {
      return map.get(key) as T | undefined;
    },
    async put(key: string, value: unknown) {
      map.set(key, value);
    },
    async delete(key: string) {
      return map.delete(key);
    },
    async list<T>(options?: { prefix?: string }) {
      const out = new Map<string, T>();
      for (const [key, value] of map) {
        if (!options?.prefix || key.startsWith(options.prefix)) {
          out.set(key, value as T);
        }
      }
      return out;
    },
  };
}
