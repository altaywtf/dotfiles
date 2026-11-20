#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { NodeServices } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CommandRunner } from "../lib/command.ts";
import { fail, runMain } from "../lib/program.ts";

export type AuditScope = "repo" | "mscp" | "host" | "workstation" | "devbox";
export type AuditFormat = "text" | "json";

type Result = { error?: Error; status: number | null };
type Runner = (command: string, args: string[]) => Result;

const repoRoot = resolve(import.meta.dirname, "..");
const Arguments = Schema.Tuple([
  Schema.Literals(["repo", "mscp", "host", "workstation", "devbox"]),
  Schema.Literals(["text", "json"]),
]);

export function auditCommand(scope: AuditScope, format: AuditFormat): [string, string[]] {
  const script = scope === "mscp" ? "repo" : scope;
  const args = scope === "repo" ? ["--skip-mscp"] : [];
  if (format === "json") {
    args.push("--json");
  }
  return [process.execPath, [resolve(repoRoot, `audit/${script}.ts`), ...args]];
}

export function runAudit(
  scope: AuditScope,
  format: AuditFormat,
  run: Runner = defaultRunner,
): number {
  const [command, args] = auditCommand(scope, format);
  const result = run(command, args);
  if (result.error) {
    process.stderr.write(`FAILED: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

function defaultRunner(command: string, args: string[]): Result {
  return spawnSync(command, args, { cwd: repoRoot, stdio: "inherit" });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const program = Effect.gen(function* () {
    const [scope, format] = yield* Schema.decodeUnknownEffect(Arguments)(
      process.argv.slice(2),
    ).pipe(
      Effect.mapError(
        () => new Error("Usage: audit/run.ts <repo|mscp|host|workstation|devbox> <text|json>"),
      ),
    );
    const runner = yield* CommandRunner;
    const [command, args] = auditCommand(scope, format);
    const result = yield* runner.run(command, args, {
      cwd: repoRoot,
      output: "inherit",
      stdin: "inherit",
    });
    if (result.status !== 0)
      return yield* fail(`${scope} audit exited ${result.status}`, result.status);
  }).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer));
  runMain(program);
}
