import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("DD011B active Owner device still requires AAL2 re-challenge before continue", () => {
  const source = readFileSync(new URL("../src/shared/backend/security-bootstrap-ui.js", import.meta.url), "utf8");
  const ownerRechallenge = source.indexOf('if (status.isOwner && state.mfa?.currentLevel !== "aal2")');
  const activeDevice = source.indexOf("if (status.device?.active)");

  assert.ok(ownerRechallenge >= 0, "Owner AAL1 re-challenge guard must exist");
  assert.ok(activeDevice > ownerRechallenge, "Owner AAL1 guard must run before active-device continue state");
  assert.match(
    source,
    /if \(status\.isOwner && state\.mfa\?\.currentLevel !== "aal2"\) \{[\s\S]*?renderOwnerBootstrap\(profile\);[\s\S]*?return;/
  );
  assert.match(source, /data-dd011b-owner-mfa-challenge/);
  assert.match(source, /Verify Owner 2FA/);
  assert.match(source, /trước khi truy cập Admin hoặc bootstrap workstation/);
});
