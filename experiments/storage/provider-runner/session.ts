import { USERS } from "./manifest.js";
export function sessionLifetime(token: string, now = Date.now()) {
  try {
    const c = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
    );
    return {
      remainingSeconds: Number.isSafeInteger(c.exp)
        ? Math.floor((c.exp * 1000 - now) / 1000)
        : null,
      issuedLifetimeSeconds:
        Number.isSafeInteger(c.exp) && Number.isSafeInteger(c.iat)
          ? c.exp - c.iat
          : null,
    };
  } catch {
    return { remainingSeconds: null, issuedLifetimeSeconds: null };
  }
}
export function expiredOrdinarySession(
  token: string,
  actor: "A" | "B",
  now = Date.now(),
): boolean {
  try {
    const c = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
    );
    return (
      c.role === "authenticated" &&
      c.sub === USERS[actor].id &&
      Number.isSafeInteger(c.exp) &&
      c.exp * 1000 <= now
    );
  } catch {
    return false;
  }
}
export function usableSession(
  token: string,
  actor: "A" | "B",
  now = Date.now(),
  margin = 30_000,
): boolean {
  try {
    const c = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
    );
    return (
      c.role === "authenticated" &&
      c.sub === USERS[actor].id &&
      Number.isSafeInteger(c.exp) &&
      c.exp * 1000 > now + margin
    );
  } catch {
    return false;
  }
}
