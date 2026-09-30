// Stand-in for @cloudflare/sandbox's getSandbox. Tests drive destroy
// behavior through __hooks.onDestroy — undefined resolves immediately,
// a function may throw or hang to simulate a wedged teardown.
export const __hooks: {
  destroyed: string[];
  onDestroy: ((name: string) => Promise<void> | void) | undefined;
} = {
  destroyed: [],
  onDestroy: undefined,
};

export function getSandbox(_ns: unknown, name: string) {
  return {
    destroy: async () => {
      __hooks.destroyed.push(name);
      await __hooks.onDestroy?.(name);
    },
  };
}
