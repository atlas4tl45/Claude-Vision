import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const MIN_TOKEN_LENGTH = 32;

function digest(s: string): Buffer {
  // Hash both sides so the comparison is constant-time regardless of length.
  return createHash("sha256").update(s, "utf8").digest();
}

/** Constant-time check of an `Authorization: Bearer <token>` header value. */
export function checkBearer(header: string | undefined, expectedToken: string): boolean {
  if (!expectedToken || expectedToken.length < MIN_TOKEN_LENGTH) return false;
  if (typeof header !== "string") return false;
  const m = /^Bearer[ ]+(\S+)\s*$/i.exec(header);
  if (!m) return false;
  return timingSafeEqual(digest(m[1]), digest(expectedToken));
}

export function isAuthorized(req: IncomingMessage, expectedToken: string): boolean {
  return checkBearer(req.headers["authorization"], expectedToken);
}
