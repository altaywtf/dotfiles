import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Effect, Exit } from "effect";
import { test, type TestContext } from "vite-plus/test";
import { checkTemporarySource } from "./temporary-source.ts";

function fixture(t: TestContext, checkoutExists: boolean) {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-temporary-source-"));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const checkout = join(root, "my checkout & co's");
  if (checkoutExists) mkdirSync(checkout);
  const units = join(home, ".config/systemd/user");
  mkdirSync(units, { recursive: true });
  const service = join(units, "dotfiles-software-update.service");
  writeFileSync(
    service,
    `ExecStart="/usr/bin/node" "${checkout}/maintenance/run.ts" software-update\n`,
  );
  const agents = join(home, "Library/LaunchAgents");
  mkdirSync(agents, { recursive: true });
  const plist = join(agents, "local.dotfiles.software-update.plist");
  writeFileSync(
    plist,
    `<string>${checkout.replaceAll("&", "&amp;").replaceAll("'", "&#39;")}/maintenance/run.ts</string>\n`,
  );
  return { home, service, plist };
}

const check = (home: string) =>
  Effect.runPromiseExit(checkTemporarySource(home).pipe(Effect.provide(NodeServices.layer)));

test("a temporary apply refuses a home maintained from an existing checkout path with spaces", async (t) => {
  const { home, service } = fixture(t, true);
  assert.equal(Exit.isFailure(await check(home)), true);
  rmSync(service);
  assert.equal(Exit.isFailure(await check(home)), true);
});

test("a temporary apply leaves units of a deleted clone in place", async (t) => {
  const { home, service, plist } = fixture(t, false);
  assert.equal(Exit.isSuccess(await check(home)), true);
  assert.ok(existsSync(service) && existsSync(plist));
});
