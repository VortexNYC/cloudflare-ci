// Stand-in for @cloudflare/ci. The pipeline under test calls the protected
// `pipeline` method directly, so only the base class shape is needed.
export class CIWorkflow<TProvider = unknown, TBindings = unknown> {
  protected env: TBindings;
  constructor(_ctx: unknown, env: TBindings) {
    this.env = env;
  }
}
