# Edictum

[![npm](https://img.shields.io/npm/v/@edictum/core?cacheSeconds=3600)](https://www.npmjs.com/package/@edictum/core)
[![License](https://img.shields.io/npm/l/@edictum/core?cacheSeconds=86400)](LICENSE)
[![Node](https://img.shields.io/node/v/@edictum/core?cacheSeconds=86400)](https://www.npmjs.com/package/@edictum/core)

Runtime contract enforcement for AI agent tool calls. TypeScript port of [edictum](https://github.com/edictum-ai/edictum) with full feature parity.

Prompts are suggestions. Contracts are enforcement.
The LLM cannot talk its way past a contract.

## The Problem

An agent says "I won't read sensitive files" -- then calls `readFile(".env")` and leaks your API keys.

Prompt engineering doesn't fix this. You need enforcement at the tool-call layer.

## Without Edictum / With Edictum

**Without** -- the agent reads your secrets:

```typescript
// Agent decides to read .env
const result = await readFile(".env");
// => "OPENAI_API_KEY=sk-abc123..."
```

**With** -- the call is denied before it executes:

```typescript
import { Edictum, EdictumDenied } from "@edictum/core";

const guard = Edictum.fromYaml("contracts.yaml");

try {
  const result = await guard.run("readFile", { path: ".env" }, readFile);
} catch (e) {
  if (e instanceof EdictumDenied) {
    console.log(e.reason);
    // => "Sensitive file '.env' denied."
  }
}
```

**The contract** -- `contracts.yaml`:

```yaml
apiVersion: edictum/v1
kind: ContractBundle
metadata:
  name: file-safety
defaults:
  mode: enforce
contracts:
  - id: block-sensitive-reads
    type: pre
    tool: readFile
    when:
      args.path:
        contains_any: [".env", ".secret", "credentials", ".pem", "id_rsa"]
    then:
      effect: deny
      message: "Sensitive file '{args.path}' denied."
```

Contracts are YAML. Enforcement is deterministic -- no LLM in the evaluation path, just pattern matching against tool names and arguments. The agent cannot bypass a matched contract.

## Install

Requires Node 22+.

```bash
pnpm add @edictum/core
```

YAML contract parsing requires `js-yaml` as an optional peer dependency:

```bash
pnpm add @edictum/core js-yaml
```

## Packages

| Package | Description |
|---------|-------------|
| [`@edictum/core`](packages/core) | Pipeline, contracts, audit, session, YAML engine. Zero runtime deps. |
| [`@edictum/vercel-ai`](packages/vercel-ai) | Vercel AI SDK adapter |
| [`@edictum/openai-agents`](packages/openai-agents) | OpenAI Agents SDK adapter |
| [`@edictum/claude-sdk`](packages/claude-sdk) | Claude Agent SDK adapter |
| [`@edictum/langchain`](packages/langchain) | LangChain.js adapter |
| [`@edictum/openclaw`](packages/openclaw) | OpenClaw adapter |
| [`@edictum/server`](packages/server) | Server SDK -- HTTP client, SSE hot-reload, audit sink |

## Works With Your Framework

```typescript
// Vercel AI SDK -- callbacks for generateText / streamText
import { VercelAIAdapter } from "@edictum/vercel-ai";
const adapter = new VercelAIAdapter(guard);
const { experimental_onToolCallStart, experimental_onToolCallFinish } =
  adapter.asCallbacks();

// OpenAI Agents SDK -- input/output guardrails
import { OpenAIAgentsAdapter } from "@edictum/openai-agents";
const adapter = new OpenAIAgentsAdapter(guard);
const { inputGuardrail, outputGuardrail } = adapter.asGuardrails();

// Claude Agent SDK -- pre/post tool use hooks
import { ClaudeAgentSDKAdapter } from "@edictum/claude-sdk";
const adapter = new ClaudeAgentSDKAdapter(guard);
const { preToolUse, postToolUse } = adapter.toSdkHooks();

// LangChain.js -- middleware for ToolNode
import { LangChainAdapter } from "@edictum/langchain";
const adapter = new LangChainAdapter(guard);
const { wrapToolCall } = adapter.asMiddleware();
```

Adapters are thin wrappers. All governance logic lives in the pipeline.

## What You Can Do

**Contracts** -- four types covering the full tool call lifecycle:

- **Preconditions** deny dangerous calls before execution
- **Postconditions** scan tool output -- warn, redact PII, or deny
- **Session contracts** cap total calls, per-tool calls, and retry attempts
- **Sandbox contracts** allowlist file paths, commands, and domains

**Programmatic contracts:**

```typescript
import { Edictum, Verdict } from "@edictum/core";
import type { Precondition } from "@edictum/core";

const noRm: Precondition = {
  tool: "Bash",
  check: async (envelope) => {
    if (envelope.bashCommand?.includes("rm -rf"))
      return Verdict.fail("Cannot run rm -rf");
    return Verdict.pass();
  },
};

const guard = new Edictum({ contracts: [noRm] });
```

**Principal-aware enforcement** -- role-gate tools with claims and `env.*` context.

**Callbacks** -- `onDeny` / `onAllow` for logging, alerting, or approval workflows.

**Observe mode** -- log what would be denied without blocking, then switch to enforce.

## Edictum Console

Optional self-hostable operations console. Contract management, live hot-reload via SSE, human-in-the-loop approvals, audit event feeds, and fleet monitoring.

```typescript
import { ServerClient } from "@edictum/server";

const client = new ServerClient({
  baseUrl: "http://localhost:8000",
  apiKey: "edk_production_...",
  agentId: "my-agent",
});
```

See [edictum-console](https://github.com/edictum-ai/edictum-console) for deployment.

## Security

This is a security product. See [SECURITY.md](SECURITY.md) for vulnerability reporting.

Every security boundary has bypass tests. Every error path fails closed. Every input used in storage keys is validated.

## License

MIT -- see [LICENSE](LICENSE).

## Ecosystem

- **[edictum](https://github.com/edictum-ai/edictum)** -- Python core library (PyPI: `edictum`)
- **[edictum-ts](https://github.com/edictum-ai/edictum-ts)** -- TypeScript core library (this repo)
- **[edictum-go](https://github.com/edictum-ai/edictum-go)** -- Go core library
- **[edictum-console](https://github.com/edictum-ai/edictum-console)** -- Self-hostable server for contract management
- **[Documentation](https://docs.edictum.ai)**
