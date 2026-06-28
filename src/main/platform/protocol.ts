/**
 * Channel protocol version + compatibility (PRD §5.3).
 *
 * The channel is a cross-process message protocol between two *peers* — two
 * instances of this same app, asymmetric only by launch time and possibly app
 * version (e.g. an old window still running after an upgrade). It is NOT a
 * client↔host relationship: either peer can be the older one, so compatibility
 * is evaluated symmetrically and the older end is always the limiting factor.
 *
 * The protocol version is **independent of the app version** (`app.getVersion()`)
 * — the wire format changes far more slowly than the app, often not at all
 * across app majors. It is `MAJOR.MINOR`:
 *  - **MAJOR** differs → incompatible. The contract changed; messages would be
 *    misunderstood. A sender must NOT write to a different-major owner.
 *  - **MINOR** is additive/forward-compatible within a major. A newer minor only
 *    ADDS optional fields / message types; consumers ignore unknown fields,
 *    default missing ones, and skip unknown `type`s — so any minor pairing
 *    interoperates (the older end simply does less).
 *
 * Both ends advertise their version: the owner records its version in
 * `owner.json` (so a launching peer checks compatibility BEFORE sending), and
 * every message carries the sender's version (so the receiver can validate each
 * one and surface a stray incompatible message instead of failing silently).
 */

/** This build's channel protocol version. Bump MAJOR only on a breaking change. */
export const PROTOCOL = { major: 1, minor: 0 } as const;

/** Wire form, e.g. "1.0". */
export const PROTOCOL_VERSION = `${PROTOCOL.major}.${PROTOCOL.minor}`;

export interface Version {
  readonly major: number;
  readonly minor: number;
}

/** Parse a "MAJOR.MINOR" string; null if malformed. */
export function parseVersion(s: unknown): Version | null {
  if (typeof s !== 'string') return null;
  const m = /^(\d+)\.(\d+)$/.exec(s);
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

/**
 * Two protocol versions interoperate iff they share a MAJOR. Minor differences
 * are always compatible (additive-only discipline); the direction matters only
 * for how much the older end can act on, which the consumer handles by
 * ignoring unknown fields/types — not by a version gate.
 */
export function isCompatible(a: Version, b: Version): boolean {
  return a.major === b.major;
}

/** Convenience: is the peer version string compatible with this build's protocol? */
export function isCompatibleWith(peer: unknown): boolean {
  const v = parseVersion(peer);
  return v !== null && isCompatible(PROTOCOL, v);
}
