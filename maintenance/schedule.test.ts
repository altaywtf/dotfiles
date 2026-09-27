import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { recordEnrollment } from "./schedule.ts";

test("disabling marks the schedule stopped until it is enabled again", (t) => {
  const home = mkdtempSync(join(tmpdir(), "dotfiles-schedule."));
  t.onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  const marker = join(home, ".local/state/dotfiles/updates/software-update.disabled");
  recordEnrollment("run", home);
  assert.equal(existsSync(marker), false);
  recordEnrollment("disable", home);
  recordEnrollment("status", home);
  assert.equal(existsSync(marker), true);
  recordEnrollment("enable", home);
  assert.equal(existsSync(marker), false);
});
