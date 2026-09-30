import { spawnSync } from "node:child_process";
import { accessSync } from "node:fs";

export type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export type CommandOptions = {
  output?: "capture" | "discard";
  input?: "inherit" | "pipe";
  timeoutMs?: number;
  maxBuffer?: number;
  // Fail instead of substituting U+FFFD for bytes that are not UTF-8.
  strictUtf8?: boolean;
};
export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: CommandOptions,
) => CommandResult;

export function runCommand(
  command: string,
  args: readonly string[],
  options: CommandOptions = {},
): CommandResult {
  const output = options.output === "discard" ? "ignore" : "pipe";
  const result = spawnSync(command, [...args], {
    stdio: [options.input ?? "inherit", output, output],
    timeout: options.timeoutMs ?? 30_000,
    killSignal: "SIGKILL",
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
  });
  const stderr = result.stderr?.toString("utf8") ?? "";
  if (!options.strictUtf8) {
    return {
      status: result.status,
      stdout: result.stdout?.toString("utf8") ?? "",
      stderr,
      error: result.error,
    };
  }
  try {
    const stdout = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout ?? undefined);
    return { status: result.status, stdout, stderr, error: result.error };
  } catch (cause) {
    return {
      status: result.status,
      stdout: "",
      stderr,
      error: result.error ?? new Error(`${command} output is not valid UTF-8`, { cause }),
    };
  }
}

export function canAccess(path: string, mode: number): boolean {
  try {
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
}

export type AuditDependencies = {
  command?: CommandRunner;
  env?: NodeJS.ProcessEnv;
  uid?: number;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
};

export function runPolicyCommand(
  command: string,
  args: readonly string[],
  options: CommandOptions = {},
): CommandResult {
  return runCommand(command, args, { ...options, input: "pipe" });
}
