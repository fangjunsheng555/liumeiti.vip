// The order-lookup verification code is stored under a Redis key built from a
// normalized query (whitespace removed, upper-cased), so two spellings that
// normalize to the same value address the same code. Every other check on that
// code — the record it is compared against, and the client-side guard that
// decides whether a pending code still belongs to the field — has to use this
// same form. Anything stricter finds the code and then rejects it, which no
// retry can recover from: each attempt issues a new code and fails identically.
//
// Order numbers are what make this matter. They are 22 characters of
// upper-case hex that customers hand-type or paste out of an email, so mobile
// auto-capitalisation and a wrapped line routinely change the raw string
// between requesting a code and entering it. Addresses arrive from autofill in
// one stable form and rarely drift.
export function canonicalOrderQuery(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 80)
    .replace(/\s+/g, "")
    .toUpperCase();
}
