import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../app/api/track/route.js", import.meta.url), "utf8");

test("public tracking is rate bounded and visitor records have finite retention", () => {
  assert.match(source, /checkCriticalRateLimit\(request/);
  assert.match(source, /ipLimit:\s*600/);
  assert.match(source, /EXPIRE",\s*vkey,\s*String\(VISITOR_TTL_SECONDS\)/);
  assert.match(source, /ZREMRANGEBYSCORE",\s*INDEX/);
  assert.match(source, /EXPIRE",\s*vkey \+ ":pages"/);
  assert.match(source, /EXPIRE",\s*vkey \+ ":events"/);
});

test("anonymous checkout beacons cannot enroll arbitrary recall email addresses", () => {
  assert.match(source, /const cemail = email;/);
  assert.doesNotMatch(source, /validEmail\(meta\.email\)/);
});
