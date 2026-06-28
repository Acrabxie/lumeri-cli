// PKCE (RFC 7636) + state generation for the OAuth authorization-code flow.
import { createHash, randomBytes } from "node:crypto";

export function base64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// code_verifier: 64 random bytes → base64url (well within the 43–128 char range).
// code_challenge: base64url(SHA-256(verifier)), method S256.
export function generatePkce() {
  const verifier = base64url(randomBytes(64));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

export function randomState() {
  return base64url(randomBytes(32));
}
