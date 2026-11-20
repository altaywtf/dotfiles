export type RawCommandResult = {
  status: number;
  stdout: string;
  stderr: string;
  error?: Error;
  timedOut?: boolean;
};

export type CommandRunner = (
  command: string,
  args: ReadonlyArray<string>,
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number | null },
) => Promise<RawCommandResult>;
