#!/usr/bin/env node

// PreToolUse hook for Claude Code and Codex: blocks `git worktree add|move`
// into ~/projects. Installed standalone, so it imports only node: builtins.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const home = process.env.HOME || homedir();
const projects = join(home, "projects");
const allowed = [join(projects, "openclaw/openclaw/.worktrees")];
const harnessFolders = ["~/.claude/worktrees", "~/.codex/worktrees", "~/.t3/worktrees"];

const unresolved = Symbol("unresolved");
type Word = string | typeof unresolved;

// Splits a shell command into simple commands of words. Quotes are honoured;
// any word with a substitution other than $HOME is unresolved.
function simpleCommands(source: string): Word[][] {
  const commands: Word[][] = [];
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
          word += source[index + 1];
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
    } else if (/[;&|\n()]/.test(char)) {
      endCommand();
      index += 1;
    } else if (/\s/.test(char)) {
      endWord();
      index += 1;
    } else {
      if (char === "~" && !started && (source[index + 1] ?? "/").match(/[/\s;&|]/)) word += home;
      else word += char;
      started = true;
      index += 1;
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

function worktreeTargets(command: string, startCwd: string): string[] {
  const targets: string[] = [];
  let cwd: Word = startCwd;
  for (const words of simpleCommands(command)) {
    let index = 0;
    while (
      typeof words[index] === "string" &&
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] as string)
    )
      index += 1;
    const [name, ...rest] = words.slice(index);
    if (name === "cd" || name === "pushd") {
      cwd = rest[0] === undefined ? home : under(cwd, rest[0]);
      continue;
    }
    if (typeof name !== "string" || basename(name) !== "git") continue;
    let base: Word = cwd;
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
        if (addValueOptions.has(word)) next += 1;
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
  if (typeof command !== "string" || !command.includes("worktree")) return;
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
