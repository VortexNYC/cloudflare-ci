// Minimal runtime stand-ins for the cloudflare:workers module. Only the
// members src/ actually touches are implemented; workerd supplies the rest
// in production.
export type StorageLike = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options?: { prefix?: string }): Promise<Map<string, T>>;
};

export class DurableObject<Env = unknown> {
  constructor(
    protected ctx: { storage: StorageLike },
    protected env: Env
  ) {}
}
