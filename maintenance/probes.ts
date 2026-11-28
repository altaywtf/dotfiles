import { Predicate } from "effect";
import type { Schema } from "effect";
import { sanitizeDiagnostic } from "../lib/diagnostics.ts";
import { spawn } from "node:child_process";
import type { CommandRunner, RawCommandResult } from "./command.ts";

type ProbeStatus = "ok" | "failed" | "timed_out" | "unavailable";

export type ProbeResult<Value = Schema.Json> = {
  status: ProbeStatus;
  required: boolean;
  duration_ms: number;
  value?: Value;
  error?: string;
};

export type Probe = {
  id: string;
  command: string;
  args: ReadonlyArray<string>;
  required: boolean;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  allowedStatuses?: ReadonlyArray<number>;
  parse: (result: RawCommandResult) => Schema.Json;
};

const defaultTimeoutMs = 15_000;

export function probe(
  id: string,
  command: string,
  args: ReadonlyArray<string>,
  parse: Probe["parse"],
  options: Partial<Pick<Probe, "required" | "timeoutMs" | "env" | "allowedStatuses">> = {},
): Probe {
  return { id, command, args, parse, required: options.required ?? true, ...options };
}

export async function runProbe(
  spec: Probe,
  context: { cwd: string; env: NodeJS.ProcessEnv },
  runner: CommandRunner,
): Promise<ProbeResult> {
  const started = performance.now();
  const cwd = spec.env?.DOTFILES_CHECKOUT || context.cwd;
  const env = { ...context.env, ...spec.env };
  delete env.DOTFILES_CHECKOUT;

  const result = await runner(spec.command, spec.args, {
    cwd,
    env,
    timeoutMs: spec.timeoutMs ?? defaultTimeoutMs,
  });

  const duration_ms = Math.round(performance.now() - started);

  if (result.timedOut) {
    return {
      status: "timed_out",
      required: spec.required,
      duration_ms,
      error: `timed out after ${spec.timeoutMs ?? defaultTimeoutMs}ms`,
    };
  }

  if (Predicate.hasProperty(result.error, "code") && result.error.code === "ENOENT") {
    return {
      status: "unavailable",
      required: spec.required,
      duration_ms,
      error: `${spec.command} is unavailable`,
    };
  }

  const allowed = spec.allowedStatuses ?? [0];

  if (result.error || !allowed.includes(result.status)) {
    const diagnostic = sanitizeDiagnostic(result.stderr || result.error?.message || result.stdout);

    return {
      status: "failed",
      required: spec.required,
      duration_ms,
      error: diagnostic || `exit ${result.status}`,
    };
  }

  try {
    return { status: "ok", required: spec.required, duration_ms, value: spec.parse(result) };
  } catch (error) {
    return {
      status: "failed",
      required: spec.required,
      duration_ms,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function runProcess(
  command: string,
  args: ReadonlyArray<string>,
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number | null; signal?: AbortSignal },
): Promise<RawCommandResult> {
  return new Promise((finish) => {
    if (options.signal?.aborted) {
      finish({ status: 1, stdout: "", stderr: "", error: new Error("maintenance probe canceled") });

      return;
    }

    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout: Array<Buffer> = [];
    const stderr: Array<Buffer> = [];
    let settled = false;
    let timedOut = false;
    let canceled = false;
    let exited = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let exitStatus: number | null = null;

    const complete = (result: RawCommandResult) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      options.signal?.removeEventListener("abort", cancel);
      child.stdout.destroy();
      child.stderr.destroy();

      if (timedOut) {
        child.unref();
      }

      finish(canceled ? { ...result, error: new Error("maintenance probe canceled") } : result);
    };

    const cancel = () => {
      if (settled || canceled) {
        return;
      }

      canceled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(drainTimer);

      const drain = () => {
        drainTimer = setTimeout(
          () =>
            complete({
              status: exitStatus ?? 1,
              stdout: Buffer.concat(stdout).toString(),
              stderr: Buffer.concat(stderr).toString(),
              timedOut,
            }),
          200,
        );
      };

      if (exited) {
        drain();
      } else {
        child.once("exit", drain);
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 200);
      }
    };

    options.signal?.addEventListener("abort", cancel, { once: true });

    if (options.timeoutMs !== null) {
      timer = setTimeout(() => {
        timedOut = true;
        killTimer = setTimeout(() => {
          drainTimer = setTimeout(() => {
            complete({
              status: exitStatus ?? 1,
              stdout: Buffer.concat(stdout).toString(),
              stderr: Buffer.concat(stderr).toString(),
              timedOut,
            });
          }, 200);
          child.kill("SIGKILL");
        }, 200);
        child.kill("SIGTERM");
      }, options.timeoutMs);
    }

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) =>
      complete({
        status: 127,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
        error,
        timedOut,
      }),
    );
    child.on("exit", (status) => {
      exitStatus = status;
      exited = true;

      if (canceled) {
        clearTimeout(killTimer);
      }
    });
    child.on("close", (status) =>
      complete({
        status: status ?? 1,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
        timedOut,
      }),
    );
  });
}
