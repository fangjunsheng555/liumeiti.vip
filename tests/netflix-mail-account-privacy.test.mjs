import test from "node:test";
import assert from "node:assert/strict";
import {
  protectNetflixMailAccountEmails,
  revealNetflixMailAccountEmails,
} from "../app/api/netflix-code/_store.js";

test("Netflix mail account addresses are encrypted at rest and recoverable only by the server", () => {
  const previous = process.env.NETFLIX_CODE_ENCRYPTION_KEY;
  process.env.NETFLIX_CODE_ENCRYPTION_KEY = "test-only-netflix-code-encryption-key-2026";
  try {
    const accountEmailPayload = protectNetflixMailAccountEmails([
      "JuanDavidsandoval1@outlook.es",
      "juandavidsandoval1@outlook.es",
    ]);
    assert.ok(accountEmailPayload?.iv);
    assert.doesNotMatch(JSON.stringify(accountEmailPayload), /juandavidsandoval1/i);
    assert.deepEqual(revealNetflixMailAccountEmails({ accountEmailPayload }), [
      "juandavidsandoval1@outlook.es",
    ]);
  } finally {
    if (previous === undefined) delete process.env.NETFLIX_CODE_ENCRYPTION_KEY;
    else process.env.NETFLIX_CODE_ENCRYPTION_KEY = previous;
  }
});

test("legacy Netflix mail events without encrypted addresses remain readable", () => {
  assert.deepEqual(revealNetflixMailAccountEmails({ accountHints: ["ju******@outlook.es"] }), []);
});
