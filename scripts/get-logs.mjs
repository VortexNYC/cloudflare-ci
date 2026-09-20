import { env } from "node:process";

const accountId =
  env.CLOUDFLARE_ACCOUNT_ID ?? "31bfc2c14a28e0a39e8b9e3c556a18be";
const workflowName = "cloudflare-ci";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      args.json = true;
    } else if (arg.startsWith("--instance=")) {
      args.instance = arg.slice("--instance=".length);
    } else if (arg.startsWith("--step=")) {
      args.step = arg.slice("--step=".length);
    } else if (arg === "--instance") {
      args.instance = argv[++i];
    } else if (arg === "--step") {
      args.step = argv[++i];
    } else if (!arg.startsWith("-")) {
      if (!args.instance) args.instance = arg;
      else if (!args.step) args.step = arg;
    }
  }
  return args;
}

function usage() {
  console.error(
    "Usage: node scripts/get-logs.mjs <instance-id> [step] [--step deploy] [--json]"
  );
  console.error(
    "       INSTANCE_ID and STEP can also be set via environment variables."
  );
  process.exit(1);
}

const args = parseArgs(process.argv);
const token = env.CLOUDFLARE_API_TOKEN;
const instanceId = args.instance ?? env.INSTANCE_ID;
const step = args.step ?? env.STEP ?? "proof";
const rawJson = args.json || process.argv.includes("--json");

if (!token || !instanceId) {
  usage();
}

const url =
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/` +
  `workflows/${workflowName}/instances/${instanceId}/step` +
  `?name=${encodeURIComponent(step)}&type=step`;

const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

if (!res.ok) {
  console.error(`HTTP ${res.status}`);
  process.exit(1);
}

const contentType = res.headers.get("content-type") ?? "";
if (contentType.includes("application/json")) {
  const data = await res.json();
  if (!data.success) {
    console.error(data.errors);
    process.exit(1);
  }
  if (rawJson) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const output = data.result?.output;
    if (output && typeof output === "object") {
      console.log(`--- ${step} exit code: ${output.exitCode} ---`);
      if (output.logs?.stdout) process.stdout.write(output.logs.stdout);
      if (output.logs?.stderr) process.stderr.write(output.logs.stderr);
    } else {
      console.log(output);
    }
  }
} else {
  const reader = res.body?.getReader();
  if (!reader) {
    console.error("No response body");
    process.exit(1);
  }
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    process.stdout.write(decoder.decode(value, { stream: true }));
  }
}
