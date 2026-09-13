# @harness/script-sdk

Dependency-free helper for wrapper scripts driven by the YouTube Operations Harness. A wrapper script is a
small `.mjs` file that an operations project owns (e.g. `fixtures/ops-project-footage/executors/wrappers/*.mjs`);
the harness's script executor spawns it as a child process for one stage attempt, with the workspace directory
and identifiers passed in as `HARNESS_*` environment variables. The wrapper talks back to the harness only
through files in that workspace (`stage-request.json` in, `stage-result.json`/`progress.json` out), stdout JSON
lines for structured logs, and the `harness op …` CLI for external-operation bookkeeping. This package wraps
that file protocol so a wrapper script does not have to hand-roll it.

It is a plain JavaScript ESM package (`src/index.js` + a hand-written `src/index.d.ts`) with no dependencies
beyond Node builtins and no build step, so a fixture can `import` it straight from source.

## Install

This package is not published to a public registry. Inside this monorepo, add `"@harness/script-sdk":
"workspace:*"` to the consuming package's dependencies (see `fixtures/ops-project-footage/package.json`).
An ops project copied out of `project-template/` (see `docs/runbooks/wrap-a-channel.md`) is not part of the
monorepo workspace, so its `package.json` instead points a `link:` dependency at wherever that machine
checked out this repo, e.g. `"@harness/script-sdk": "link:../YOUTUBE_OPERATIONS_HARNESS/packages/script-sdk"`
— `pnpm install` then symlinks the package in without copying it (there is no build step, so edits to
`src/index.js` take effect immediately).

## Example wrapper

```js
#!/usr/bin/env node
import { start } from "@harness/script-sdk";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ctx = await start();
const narration = ctx.input("narration");
const outPath = join(ctx.workspace, "output", "narration.wav");

const r = spawnSync("tts-cli", ["--in", narration, "--out", outPath, "--voice", String(ctx.options.voice)]);
if (r.status !== 0) {
  await ctx.fail("transient", "tts-cli failed", { code: r.status });
  process.exit(0);
}

await ctx.out.file("output/narration.wav", { type: "voice_track" });
ctx.log.info("rendered narration");
await ctx.done({ cost_usd: 0.01 });
```

## API

| Member | Description |
| --- | --- |
| `start(opts?)` | Reads `stage-request.json` from `HARNESS_WORKSPACE` (or `opts.workspace`/`opts.env`), returns a `ScriptContext`. |
| `ctx.request` | The parsed stage request (`StageRequestLike`). |
| `ctx.workspace` | Absolute path to the stage workspace directory. |
| `ctx.options` | `request.options`. |
| `ctx.sources` | `request.source_items`. |
| `ctx.input(typeOrPath)` | Absolute path to the first input matching `type` exactly, else matching `path` exactly or as a path suffix after `/`; throws if none matches. |
| `ctx.inputs(type)` | Absolute paths of every input with the given `type`. |
| `ctx.hasInput(type)` | Whether any input has the given `type`. |
| `ctx.source(i)` | The source item at index `i`; throws if out of range. |
| `ctx.hasResource(name)` | Whether `request.resources` includes `name`. |
| `ctx.out.file(rel, { type, mime? })` | Declares a file under the workspace (usually `output/…`) as an output, checksumming it. `mime` is accepted for readability but **ignored**: the artifact's mime type comes from the workflow stage definition's `outputs[].mime_type` (`mimeTypesFor(def)` in `packages/core/src/orchestration/request.ts`), never from the script. |
| `ctx.out.dir(rel, { type })` | Declares a directory as one output: the checksum is the canonical digest of its file listing, matching `@harness/core`'s `directoryDigest(listDirectoryFiles(dir))` byte-for-byte. |
| `ctx.out.clear()` | Empties and recreates `output/` and forgets any declared outputs (used before retrying inside the same attempt). |
| `ctx.heartbeat({ percent?, message? })` | Writes `progress.json` in the workspace. |
| `ctx.log.info/warn/error(msg, data?)` | Writes one JSON line (`{ level, msg, ...data }`) to stdout. |
| `ctx.done({ cost_usd?, wall_seconds?, external_operations? })` | Writes `stage-result.json` with `outcome: "succeeded"` and the declared outputs. |
| `ctx.fail(kind, message, details?)` | Writes `stage-result.json` with `outcome: "failed"` (`kind` is `"transient" \| "result" \| "contract"`). |
| `ctx.unknown(message, external_operations?)` | Writes `stage-result.json` with `outcome: "unknown"` for when the script cannot tell if the underlying work happened (e.g. lost connection to a provider mid-call). |
| `ctx.op.intent/confirm/lost(...)` | Shells out to `harness op …` (via `HARNESS_CLI_ARGV`) to record an external operation's lifecycle. |
| `directoryListing(dir)` | Standalone helper: the same file listing + checksum algorithm `ctx.out.dir` uses, exported for callers that need it directly. |

## Exit code convention

`ctx.done()`, `ctx.fail()`, and `ctx.unknown()` all set the process exit code to `0` after writing
`stage-result.json` — the outcome of the stage is read from that file, not from the process exit code. A wrapper
script exiting with a non-zero code *without* having written a result (a crash, an uncaught exception, a killed
process) is what the executor treats as a transient failure of the attempt itself.

## `HARNESS_*` environment variables

Set by the script executor (`packages/executors/src/script-executor.ts`) for each attempt:

- `HARNESS_WORKSPACE` — absolute path to the stage's workspace directory, containing `stage-request.json` and
  the `input/`/`output/` trees.
- `HARNESS_PROJECT` — the operations project directory, used as the default `--project` for `ctx.op.*` CLI calls.
- `HARNESS_RUN_ID`, `HARNESS_STAGE_RUN_ID`, `HARNESS_ATTEMPT_ID`, `HARNESS_STAGE_KEY` — identifiers for the
  current run/stage/attempt, duplicated from the stage request for convenience.
- `HARNESS_FENCING_TOKEN` — the attempt's fencing token; required by `ctx.op.*` so the harness can detect a
  stale/duplicate operation call from a superseded attempt.
- `HARNESS_CLI_ARGV` — a JSON array giving the command (and leading args) to invoke the harness CLI, e.g.
  `["node", "/path/to/harness/cli.js"]`; `ctx.op.*` spawns this synchronously.

## `ctx.op.*`

Some stages perform an operation against an external provider (uploading a video, calling a paid API) that
must not be silently repeated if the attempt is retried. `ctx.op.intent/confirm/lost` record that lifecycle
through the harness CLI (`harness op intent|confirm|lost`) so the controller can reconcile it if the attempt's
process dies mid-call: `intent` before starting the external call, `confirm` once it succeeds with the
provider's own reference, and `lost` if the script can no longer tell whether it succeeded (in which case the
wrapper should usually finish with `ctx.unknown(...)` rather than `ctx.fail(...)`).
