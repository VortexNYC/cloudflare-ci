// Test bootstrap: registers in-thread module hooks so src/*.ts run under
// node --test without the workerd runtime. Runtime-only imports are swapped
// for lightweight shims; extensionless relative imports (./env) resolve to
// .ts sources.
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const shimDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "shims");
const SHIMS = new Map([
  ["cloudflare:workers", "cloudflare-workers.ts"],
  ["@cloudflare/sandbox", "sandbox.ts"],
  ["@cloudflare/ci", "ci.ts"],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const shim = SHIMS.get(specifier);
    if (shim) {
      return {
        url: pathToFileURL(path.join(shimDir, shim)).href,
        shortCircuit: true,
      };
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        (specifier.startsWith("./") || specifier.startsWith("../")) &&
        !path.extname(specifier)
      ) {
        return nextResolve(specifier + ".ts", context);
      }
      throw error;
    }
  },
});
