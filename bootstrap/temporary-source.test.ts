import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Effect, Exit } from "effect";
import { test, type TestContext } from "vite-plus/test";
import { reconcileTemporarySource } from "./temporary-source.ts";

function fixture(t: TestContext, checkoutExists: boolean) {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-temporary-source-"));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const checkout = join(root, "checkout");
  if (checkoutExists) mkdirSync(checkout);
  const units = join(home, ".config/systemd/user");
  mkdirSync(units, { recursive: true });
  const service = join(units, "dotfiles-software-update.service");
  writeFileSync(
    service,
    `ExecStart="/usr/bin/node" "${checkout}/maintenance/run.ts" software-update\n`,
  );
  writeFileSync(join(units, "dotfiles-software-update.timer"), "[Timer]\n");
  return { home, service, timer: join(units, "dotfiles-software-update.timer") };
}

const reconcile = (home: string) =>
  Effect.runPromiseExit(
    reconcileTemporarySource(home, false).pipe(Effect.provide(NodeServices.layer)),
  );

test("a temporary apply refuses a home maintained from an existing checkout", async (t) => {
  const { home, service } = fixture(t, true);
  assert.equal(Exit.isFailure(await reconcile(home)), true);
  assert.ok(existsSync(service));
});

test("a temporary apply removes updater units left by a deleted clone", async (t) => {
  const { home, service, timer } = fixture(t, false);
  assert.equal(Exit.isSuccess(await reconcile(home)), true);
  assert.equal(existsSync(service), false);
  assert.equal(existsSync(timer), false);
});
