import { lstatSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export type PathSource =
  | { kind: "path"; path: string }
  | { kind: "home-dotfiles"; exclude?: readonly string[] }
  | {
      kind: "files";
      path: string;
      maxDepth?: number;
      namePrefix?: string;
      pathPattern?: RegExp;
      skipDirectories?: readonly string[];
      ignoreDirectoryLinks?: boolean;
    };

type WalkOptions = { skipDirectories?: ReadonlySet<string>; ignoreDirectoryLinks?: boolean };

type SkippedPath = (path: string) => void;

export function homePath(home: string, path: string): string {
  return path.startsWith("/") ? path : join(home, path);
}

function present(path: string, skipped: SkippedPath): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) skipped(path);
    return false;
  }
}

function discoveredFile(path: string, skipped: SkippedPath): boolean {
  try {
    if (statSync(path).isFile()) return true;
  } catch {}
  skipped(path);
  return false;
}

function linkedDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function walkFiles(
  root: string,
  maxDepth = Number.POSITIVE_INFINITY,
  skipped: SkippedPath,
  options: WalkOptions = {},
): string[] {
  if (!present(root, skipped)) return [];
  try {
    const info = statSync(root);
    if (info.isFile()) return [root];
    if (!info.isDirectory()) {
      skipped(root);
      return [];
    }
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory())
        return maxDepth > 0 && !options.skipDirectories?.has(entry.name)
          ? walkFiles(path, maxDepth - 1, skipped, options)
          : [];
      if (entry.isFile()) return [path];
      // Follow file links; directory links are reported instead of recursively
      // expanding arbitrary trees or cycles outside the selected audit scope.
      if (!entry.isSymbolicLink()) return [];
      if (options.ignoreDirectoryLinks && linkedDirectory(path)) return [];
      return discoveredFile(path, skipped) ? [path] : [];
    });
  } catch {
    skipped(root);
    return [];
  }
}

export function resolveSources(
  home: string,
  sources: readonly PathSource[],
  skipped: SkippedPath,
): string[] {
  const paths = sources.flatMap((source) => {
    if (source.kind === "path") {
      const path = homePath(home, source.path);
      if (!present(path, skipped)) return [];
      try {
        const info = statSync(path);
        if (info.isFile() || info.isDirectory()) return [path];
      } catch {}
      skipped(path);
      return [];
    }
    if (source.kind === "home-dotfiles") {
      const excluded = new Set(source.exclude ?? []);
      try {
        return readdirSync(home, { withFileTypes: true })
          .filter((entry) => entry.name.startsWith(".") && !excluded.has(entry.name))
          .filter(
            (entry) =>
              entry.isFile() ||
              (entry.isSymbolicLink() && discoveredFile(join(home, entry.name), skipped)),
          )
          .map((entry) => join(home, entry.name));
      } catch {
        skipped(home);
        return [];
      }
    }
    const root = homePath(home, source.path);
    return walkFiles(root, source.maxDepth ?? Number.POSITIVE_INFINITY, skipped, {
      skipDirectories: new Set(source.skipDirectories),
      ignoreDirectoryLinks: source.ignoreDirectoryLinks,
    })
      .filter(
        (path) => source.namePrefix === undefined || basename(path).startsWith(source.namePrefix),
      )
      .filter((path) => source.pathPattern === undefined || source.pathPattern.test(path));
  });
  return [...new Set(paths)].sort();
}
