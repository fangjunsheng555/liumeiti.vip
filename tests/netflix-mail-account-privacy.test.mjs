import test from "node:test";
import assert from "node:assert/strict";
import {
  protectNetflixMailAccountEmails,
  protectNetflixMailResult,
  revealNetflixMailAccountEmails,
  revealNetflixMailResult,
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

test("only accepted Netflix events expose their decrypted result to the admin route", () => {
  const previous = process.env.NETFLIX_CODE_ENCRYPTION_KEY;
  process.env.NETFLIX_CODE_ENCRYPTION_KEY = "test-only-netflix-code-encryption-key-2026";
  try {
    const codePayload = protectNetflixMailResult("0707");
    const link = "https://www.netflix.com/account/travel/verify?token=test";
    const linkPayload = protectNetflixMailResult(link);
    const householdLink = "https://www.netflix.com/account/update-primary-location?nftoken=test";
    assert.doesNotMatch(JSON.stringify(codePayload), /0707/);
    assert.doesNotMatch(JSON.stringify(linkPayload), /travel\/verify/);
    assert.equal(revealNetflixMailResult({ accepted: true, kind: "code", payload: codePayload }), "0707");
    assert.equal(revealNetflixMailResult({ accepted: true, kind: "link", payload: linkPayload }), link);
    assert.equal(revealNetflixMailResult({ accepted: true, kind: "household", payload: protectNetflixMailResult(householdLink) }), householdLink);
    assert.equal(revealNetflixMailResult({ accepted: false, kind: "code", payload: codePayload }), "");
    assert.equal(revealNetflixMailResult({ accepted: true, kind: "link", payload: protectNetflixMailResult("https://example.com/account/travel/verify?token=test") }), "");
  } finally {
    if (previous === undefined) delete process.env.NETFLIX_CODE_ENCRYPTION_KEY;
    else process.env.NETFLIX_CODE_ENCRYPTION_KEY = previous;
  }
});
