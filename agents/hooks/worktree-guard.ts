#!/usr/bin/env node

// PreToolUse hook for Claude Code and Codex: blocks `git worktree add|move`
// into ~/projects. Installed standalone, so it imports only node: builtins.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const home = process.env.HOME || homedir();
const user = process.env.USER || userInfo().username;
const projects = join(home, "projects");
const allowed = [join(projects, "openclaw/openclaw/.worktrees")];
const harnessFolders = ["~/.claude/worktrees", "~/.codex/worktrees", "~/.t3/worktrees"];

const unresolved = Symbol("unresolved");
type Word = string | typeof unresolved;

// Splits a shell command into simple commands of words. Quotes are honoured,
// here-document bodies are skipped, and any word with a substitution other
// than $HOME is unresolved.
function simpleCommands(source: string): Word[][] {
  const commands: Word[][] = [];
  const heredocs: { delimiter: string; stripTabs: boolean }[] = [];
  let words: Word[] = [];
  let word = "";
  let started = false;
  let dynamic = false;
  const endWord = () => {
    if (started) words.push(dynamic ? unresolved : word);
    word = "";
    started = false;
    dynamic = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  const variable = (index: number): [string | undefined, number] => {
    const match = /^\$(?:\{HOME\}|HOME(?![A-Za-z0-9_]))/.exec(source.slice(index));
    return match ? [home, index + match[0].length] : [undefined, index + 1];
  };
  for (let index = 0; index < source.length;) {
    const char = source[index];
    if (char === "\\" && index + 1 < source.length) {
      if (source[index + 1] !== "\n") {
        word += source[index + 1];
        started = true;
      }
      index += 2;
    } else if (char === "'") {
      const end = source.indexOf("'", index + 1);
      const stop = end === -1 ? source.length : end;
      word += source.slice(index + 1, stop);
      started = true;
      index = stop + 1;
    } else if (char === '"') {
      started = true;
      index += 1;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === "\\" && index + 1 < source.length) {
          if (source[index + 1] !== "\n") word += source[index + 1];
          index += 2;
        } else if (source[index] === "$" || source[index] === "`") {
          const [value, next] = source[index] === "$" ? variable(index) : [undefined, index + 1];
          if (value === undefined) dynamic = true;
          else word += value;
          index = next;
        } else {
          word += source[index];
          index += 1;
        }
      }
      index += 1;
    } else if (char === "$" || char === "`") {
      const [value, next] = char === "$" ? variable(index) : [undefined, index + 1];
      if (value === undefined) dynamic = true;
      else word += value;
      started = true;
      index = next;
    } else if (source.startsWith("<<", index) && !source.startsWith("<<<", index)) {
      endWord();
      const match = /^<<(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|([^\s;&|<>()]+))/.exec(
        source.slice(index),
      );
      if (match) {
        heredocs.push({
          delimiter: match[2] ?? match[3] ?? match[4].replaceAll("\\", ""),
          stripTabs: match[1] === "-",
        });
        index += match[0].length;
      } else index += 2;
    } else if (char === "(" || char === ")") {
      endCommand();
      commands.push([char]);
      index += 1;
    } else if (char === "&" && (source[index + 1] === ">" || /^\d*[<>]$/.test(word))) {
      word += char;
      started = true;
      index += 1;
    } else if (/[;&|\n]/.test(char)) {
      endCommand();
      index += 1;
      if (char === "\n") {
        for (const { delimiter, stripTabs } of heredocs.splice(0)) {
          while (index < source.length) {
            const end = source.indexOf("\n", index);
            const line = source.slice(index, end === -1 ? source.length : end);
            index = end === -1 ? source.length : end + 1;
            if ((stripTabs ? line.replace(/^\t+/, "") : line) === delimiter) break;
          }
        }
      }
    } else if (char === "#" && !started) {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
    } else if (/\s/.test(char)) {
      endWord();
      index += 1;
    } else {
      const tilde =
        char === "~" && !started
          ? /^~([A-Za-z0-9._-]*)(?=[/\s;&|)]|$)/.exec(source.slice(index))
          : null;
      if (tilde && (tilde[1] === "" || tilde[1] === user)) {
        word += home;
        index += tilde[0].length;
      } else {
        word += char;
        index += 1;
      }
      started = true;
    }
  }
  endCommand();
  return commands;
}

const gitValueOptions = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const addValueOptions = new Set(["-b", "-B", "--reason"]);

function under(base: Word, path: Word | undefined): Word {
  if (path === undefined || path === unresolved || base === unresolved) return unresolved;
  return resolve(base, path);
}

const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;
const redirection = /^\d*(?:[<>]&?|>>|&>>?)(.*)$/;
const launchers = new Set(["builtin", "command", "exec", "nohup", "sudo", "time"]);
const shells = new Set(["bash", "dash", "sh", "zsh"]);
const launcherValues: Record<string, string> = { exec: "a", sudo: "CDghprtuU" };

// Drops leading assignments and launchers such as `env` or `command`.
function unwrap(words: Word[]): { words: Word[]; chdir: Word | undefined } {
  let index = 0;
  let chdir: Word | undefined;
  const skip = (test: (word: string) => boolean) => {
    while (typeof words[index] === "string" && test(words[index] as string)) index += 1;
  };
  for (;;) {
    skip((word) => assignment.test(word));
    const operator =
      typeof words[index] === "string" ? redirection.exec(words[index] as string) : null;
    if (operator) {
      index += operator[1] ? 1 : 2;
      continue;
    }
    const name = typeof words[index] === "string" ? basename(words[index] as string) : undefined;
    if (name === "env") {
      index += 1;
      while (typeof words[index] === "string") {
        const word = words[index] as string;
        if (/^-C$|^--chdir$/.test(word)) {
          chdir = words[index + 1];
          index += 2;
        } else if (word.startsWith("--chdir=")) {
          chdir = word.slice("--chdir=".length);
          index += 1;
        } else if (/^-[uS]$|^--(?:unset|split-string)$/.test(word)) index += 2;
        else if (word.startsWith("-") || assignment.test(word)) index += 1;
        else break;
      }
    } else if (name !== undefined && launchers.has(name)) {
      index += 1;
      const valued = launcherValues[name] ?? "";
      while (typeof words[index] === "string" && (words[index] as string).startsWith("-")) {
        const word = words[index] as string;
        if (name === "sudo" && (word === "-D" || word === "--chdir")) chdir = words[index + 1];
        const long = /^--(?:user|group|chdir|close-from|host|prompt|role|type|other-user)$/;
        index +=
          (word.length === 2 && valued.includes(word[1])) || (name === "sudo" && long.test(word))
            ? 2
            : 1;
      }
    } else return { words: words.slice(index), chdir };
  }
}

function worktreeTargets(command: string, startCwd: string): string[] {
  const targets: string[] = [];
  let cwd: Word = startCwd;
  let previous: Word = unresolved;
  const pushed: Word[] = [];
  const scopes: Word[] = [];
  for (const words of simpleCommands(command)) {
    if (words.length === 1 && words[0] === "(") {
      scopes.push(cwd);
      continue;
    }
    if (words.length === 1 && words[0] === ")") {
      cwd = scopes.pop() ?? cwd;
      continue;
    }
    const unwrapped = unwrap(words);
    const [name, ...rest] = unwrapped.words;
    const here = unwrapped.chdir === undefined ? cwd : under(cwd, unwrapped.chdir);
    if (name === "popd") {
      previous = cwd;
      cwd = pushed.pop() ?? unresolved;
      continue;
    }
    if (name === "cd" || name === "pushd") {
      if (name === "pushd") pushed.push(cwd);
      let at = 0;
      while (typeof rest[at] === "string" && /^-[LPe@]+$/.test(rest[at] as string)) at += 1;
      if (rest[at] === "--") at += 1;
      const next =
        rest[at] === undefined ? home : rest[at] === "-" ? previous : under(cwd, rest[at]);
      previous = cwd;
      cwd = next;
      continue;
    }
    if (typeof name === "string" && shells.has(basename(name))) {
      const flag = rest.findIndex(
        (word) => typeof word === "string" && /^-[a-z]*c[a-z]*$/.test(word),
      );
      const script = flag === -1 ? undefined : rest[rest[flag + 1] === "--" ? flag + 2 : flag + 1];
      if (typeof script === "string" && here !== unresolved)
        targets.push(...worktreeTargets(script, here));
      continue;
    }
    if (typeof name !== "string" || basename(name) !== "git") continue;
    let base: Word = here;
    let at = 0;
    for (; at < rest.length; at += 1) {
      const word = rest[at];
      if (word === unresolved || !word.startsWith("-")) break;
      if (gitValueOptions.has(word)) {
        if (word === "-C") base = under(base, rest[at + 1]);
        at += 1;
      }
    }
    if (rest[at] !== "worktree") continue;
    const action = rest[at + 1];
    if (action !== "add" && action !== "move") continue;
    const positional: Word[] = [];
    for (let next = at + 2; next < rest.length; next += 1) {
      const word = rest[next];
      if (word === "--") {
        positional.push(...rest.slice(next + 1));
        break;
      }
      if (typeof word === "string" && word.startsWith("-")) {
        if (addValueOptions.has(word) || /^-[a-zA-Z]*[bB]$/.test(word)) next += 1;
        continue;
      }
      positional.push(word);
    }
    const path = positional[action === "add" ? 0 : 1];
    if (path === undefined) continue;
    // Paths built from variables or substitutions are not judged.
    if (path === unresolved || (base === unresolved && !isAbsolute(path))) continue;
    targets.push(base === unresolved ? path : resolve(base, path));
  }
  return targets;
}

function canonical(path: string): string {
  let existing = resolve(path);
  const missing: string[] = [];
  while (!existsSync(existing) && dirname(existing) !== existing) {
    missing.unshift(basename(existing));
    existing = dirname(existing);
  }
  return join(realpathSync(existing), ...missing);
}

function inside(child: string, parent: string): boolean {
  const path = relative(canonical(parent), canonical(child));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function main(): void {
  let input: { tool_input?: { command?: unknown }; cwd?: unknown };
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  const command = input.tool_input?.command;
  if (typeof command !== "string") return;
  const cwd = typeof input.cwd === "string" && isAbsolute(input.cwd) ? input.cwd : process.cwd();
  const folders = harnessFolders.join(", ");
  for (const target of worktreeTargets(command, cwd)) {
    const exempt = allowed.some(
      (root) => inside(target, root) && canonical(target) !== canonical(root),
    );
    if (inside(target, projects) && !exempt) {
      process.stderr.write(
        `Blocked: ${target} is under ~/projects. Worktrees live in the running harness's folder: ${folders}. The only exception is ~/projects/openclaw/openclaw/.worktrees/.\n`,
      );
      process.exit(2);
    }
  }
}

main();
