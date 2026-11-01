import { readFileSync } from "node:fs";
import type { ClientMessage } from "../../protocol/generated/protocol.ts";

// Validates inbound client frames against protocol/schema/protocol.v1.json at
// runtime, so the schema stays the single source of truth. Supports the same
// subset the TS generator does.

type Schema = Record<string, any>;

const schema: Schema = JSON.parse(
  readFileSync(new URL("../../protocol/schema/protocol.v1.json", import.meta.url), "utf8"),
);
const defs: Record<string, Schema> = schema.$defs;

const clientDefByType = new Map<string, Schema>();
for (const member of defs.ClientMessage.oneOf as Schema[]) {
  const def = defs[member.$ref.replace("#/$defs/", "")];
  clientDefByType.set(def.properties.type.const, def);
}

function check(value: unknown, s: Schema, path: string, errors: string[]): void {
  if (s.$ref) return check(value, defs[s.$ref.replace("#/$defs/", "")], path, errors);
  if ("const" in s) {
    if (value !== s.const) errors.push(`${path} must be ${JSON.stringify(s.const)}`);
    return;
  }
  if (s.enum) {
    if (!s.enum.includes(value)) errors.push(`${path} must be one of ${s.enum.join(", ")}`);
    return;
  }
  if (s.oneOf) {
    const ok = (s.oneOf as Schema[]).some((sub) => {
      const e: string[] = [];
      check(value, sub, path, e);
      return e.length === 0;
    });
    if (!ok) errors.push(`${path} matches no allowed shape`);
    return;
  }
  switch (s.type) {
    case "string":
      if (typeof value !== "string") errors.push(`${path} must be a string`);
      else if (s.minLength !== undefined && value.length < s.minLength) errors.push(`${path} is too short`);
      return;
    case "integer":
      if (!Number.isInteger(value)) errors.push(`${path} must be an integer`);
      else if (s.minimum !== undefined && (value as number) < s.minimum) errors.push(`${path} must be >= ${s.minimum}`);
      return;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) errors.push(`${path} must be a number`);
      return;
    case "boolean":
      if (typeof value !== "boolean") errors.push(`${path} must be a boolean`);
      return;
    case "array":
      if (!Array.isArray(value)) errors.push(`${path} must be an array`);
      else if (s.items) value.forEach((v, i) => check(v, s.items, `${path}[${i}]`, errors));
      return;
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        errors.push(`${path} must be an object`);
        return;
      }
      const obj = value as Record<string, unknown>;
      for (const key of s.required ?? []) {
        if (!(key in obj)) errors.push(`${path}.${key} is required`);
      }
      const props: Record<string, Schema> = s.properties ?? {};
      for (const [key, v] of Object.entries(obj)) {
        if (props[key]) check(v, props[key], `${path}.${key}`, errors);
        else if (s.additionalProperties === false) errors.push(`${path}.${key} is not allowed`);
      }
      return;
    }
  }
}

/** Validate any value against a named $defs entry. Returns error strings (empty when valid). */
export function validateAgainst(defName: string, value: unknown): string[] {
  const def = defs[defName];
  if (!def) throw new Error(`Unknown schema definition ${defName}`);
  const errors: string[] = [];
  check(value, def, "$", errors);
  return errors;
}

export type ValidationResult =
  | { ok: true; message: ClientMessage }
  | { ok: false; code: "bad_request" | "unsupported_version"; error: string; reqId?: string };

export function validateClientMessage(data: unknown): ValidationResult {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, code: "bad_request", error: "Frame must be a JSON object" };
  }
  const obj = data as Record<string, unknown>;
  const reqId = typeof obj.reqId === "string" ? obj.reqId : undefined;
  if (obj.v !== schema["x-protocol-version"]) {
    return { ok: false, code: "unsupported_version", error: `Unsupported protocol version ${String(obj.v)}; server speaks v${schema["x-protocol-version"]}`, reqId };
  }
  const def = typeof obj.type === "string" ? clientDefByType.get(obj.type) : undefined;
  if (!def) return { ok: false, code: "bad_request", error: `Unknown message type ${JSON.stringify(obj.type)}`, reqId };
  const errors: string[] = [];
  check(obj, def, "$", errors);
  if (errors.length) return { ok: false, code: "bad_request", error: errors.join("; "), reqId };
  return { ok: true, message: obj as ClientMessage };
}
