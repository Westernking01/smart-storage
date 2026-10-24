export const failureCategories = [
  "AUTH_REJECTED",
  "ISOLATION_FAILED",
  "IDENTITY_OR_ENROLLMENT_FAILED",
  "POOL_LIFECYCLE_FAILED",
  "DATABASE_CONNECT_FAILED",
  "CONNECTION_TIMEOUT",
  "CLEANUP_FAILED",
] as const;
export type FailureCategory = (typeof failureCategories)[number];
export const timeoutStages = [
  "CONNECTION_ESTABLISHMENT",
  "CHECKOUT_QUEUE",
  "UNKNOWN",
] as const;
export const timeoutPhases = ["SEQUENTIAL", "CONCURRENT", "UNKNOWN"] as const;
export type TimeoutStage = (typeof timeoutStages)[number];
export type TimeoutPhase = (typeof timeoutPhases)[number];
export class PoolFailure extends Error {
  constructor(
    readonly category: FailureCategory,
    readonly stage: TimeoutStage = "UNKNOWN",
    readonly phase: TimeoutPhase = "UNKNOWN",
  ) {
    super(category);
  }
}
export function connectionStage(error: unknown): TimeoutStage {
  if (error instanceof PoolFailure)
    return timeoutStages.includes(error.stage) ? error.stage : "UNKNOWN";
  const message = error instanceof Error ? error.message : "";
  if (message === "timeout exceeded when trying to connect")
    return "CHECKOUT_QUEUE";
  if (
    [
      "timeout expired",
      "Connection terminated due to connection timeout",
    ].includes(message)
  )
    return "CONNECTION_ESTABLISHMENT";
  return "UNKNOWN";
}
export function categoryOf(error: unknown): FailureCategory {
  return error instanceof PoolFailure &&
    failureCategories.includes(error.category)
    ? error.category
    : "POOL_LIFECYCLE_FAILED";
}
export function dominant(
  a: FailureCategory,
  b: FailureCategory,
): FailureCategory {
  return failureCategories.indexOf(a) >= failureCategories.indexOf(b) ? a : b;
}
// Only called at a connect boundary. Exact installed-driver timeout strings,
// never substring matching, SQL timeout inference, or output of raw messages.
export function connectionCategory(error: unknown): FailureCategory {
  if (error instanceof PoolFailure) return categoryOf(error);
  const message = error instanceof Error ? error.message : "";
  return [
    "timeout expired",
    "Connection terminated due to connection timeout",
    "timeout exceeded when trying to connect",
  ].includes(message)
    ? "CONNECTION_TIMEOUT"
    : "DATABASE_CONNECT_FAILED";
}
export function failureLine(error?: unknown) {
  const category = categoryOf(error);
  if (category !== "CONNECTION_TIMEOUT") return `FAIL: ${category}`;
  const phase =
    error instanceof PoolFailure && timeoutPhases.includes(error.phase)
      ? error.phase
      : "UNKNOWN";
  return `FAIL: CONNECTION_TIMEOUT STAGE=${connectionStage(error)} PHASE=${phase}`;
}
// Parent launcher trusts only an entire fixed record, never an arbitrary child
// message, Error.message, metadata or partial match within a stack trace.
export function childFailureLine(stderr: string, timedOut = false) {
  if (timedOut) return "FAIL: CLEANUP_FAILED";
  for (const stage of timeoutStages)
    for (const phase of timeoutPhases) {
      const line = failureLine(
        new PoolFailure("CONNECTION_TIMEOUT", stage, phase),
      );
      if (stderr === line + "\n" || stderr === line + "\r\n") return line;
    }
  return failureCategories.some(
    (category) =>
      stderr === `FAIL: ${category}\n` || stderr === `FAIL: ${category}\r\n`,
  )
    ? stderr.trim()
    : "FAIL: POOL_LIFECYCLE_FAILED";
}
