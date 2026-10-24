/** Only call with a freshly verified provider getUser response; never decoded cookies. */
export function ordinaryIdentity(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const u = value as Record<string, unknown>;
  return typeof u.id === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      u.id,
    ) &&
    u.role === "authenticated" &&
    u.is_anonymous !== true &&
    typeof u.email_confirmed_at === "string" &&
    Number.isFinite(Date.parse(u.email_confirmed_at))
    ? u.id
    : null;
}
