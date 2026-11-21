import { dirname, isAbsolute, join, resolve } from "node:path";

export const gitIdentitiesPath = ".config/git/identities";

export const includeIfPathArgs = [
  "--null",
  "--get-regexp",
  String.raw`^includeif\..*\.path$`,
] as const;

export function resolveGitPath(home: string, configFile: string, value: string): string {
  if (value === "~") {
    return home;
  }
  if (value.startsWith("~/")) {
    return join(home, value.slice(2));
  }
  return isAbsolute(value) ? value : resolve(dirname(configFile), value);
}

export function parseIncludeIfPaths(
  home: string,
  configFile: string,
  output: string,
): ReadonlyArray<string> {
  return output
    .split("\0")
    .filter((entry) => entry.includes("\n"))
    .map((entry) => entry.slice(entry.indexOf("\n") + 1))
    .filter((value) => value !== "")
    .map((value) => resolveGitPath(home, configFile, value));
}
