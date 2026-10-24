import { expect, it } from "vitest";
import {
  PoolFailure,
  categoryOf,
  childFailureLine,
  connectionCategory,
  connectionStage,
  dominant,
  failureCategories,
  failureLine,
} from "../../scripts/pool-isolation-errors";
it.each(failureCategories)("renders only the fixed %s record", (category) => {
  const error = new PoolFailure(category);
  const expected =
    category === "CONNECTION_TIMEOUT"
      ? "FAIL: CONNECTION_TIMEOUT STAGE=UNKNOWN PHASE=UNKNOWN"
      : `FAIL: ${category}`;
  expect(failureLine(error)).toBe(expected);
  expect(childFailureLine(failureLine(error) + "\n")).toBe(expected);
});
it.each([
  Error("postgresql://secret/token/user"),
  { category: "AUTH_REJECTED" },
  new PoolFailure("private-token" as never),
])("does not render raw or forged metadata", (error) => {
  expect(categoryOf(error)).toBe("POOL_LIFECYCLE_FAILED");
  expect(failureLine(error)).toBe("FAIL: POOL_LIFECYCLE_FAILED");
});
it.each([
  "FAIL: DATABASE_CONNECT_FAILED\nError: private\n",
  "private\nFAIL: CLEANUP_FAILED\n",
  "FAIL: UNKNOWN\n",
  "FAIL: AUTH_REJECTED\n\n",
  "postgresql://private",
])("rejects nonexact child output", (line) => {
  expect(childFailureLine(line)).toBe("FAIL: POOL_LIFECYCLE_FAILED");
});
it("gives cleanup uncertainty priority over an earlier child category", () => {
  expect(childFailureLine("FAIL: AUTH_REJECTED\n", true)).toBe(
    "FAIL: CLEANUP_FAILED",
  );
  for (const category of failureCategories)
    expect(dominant(category, "CLEANUP_FAILED")).toBe("CLEANUP_FAILED");
  expect(dominant("DATABASE_CONNECT_FAILED", "POOL_LIFECYCLE_FAILED")).toBe(
    "DATABASE_CONNECT_FAILED",
  );
});
it.each([
  "timeout expired",
  "Connection terminated due to connection timeout",
  "timeout exceeded when trying to connect",
])("recognizes installed connect timeout %s", (message) => {
  expect(connectionCategory(Error(message))).toBe("CONNECTION_TIMEOUT");
});
it("does not infer connection timeout from SQL timeouts or private text", () => {
  expect(connectionCategory(Error("Query read timeout"))).toBe(
    "DATABASE_CONNECT_FAILED",
  );
  expect(connectionCategory(Error("secret timeout expired secret"))).toBe(
    "DATABASE_CONNECT_FAILED",
  );
});

it.each(["CONNECTION_ESTABLISHMENT", "CHECKOUT_QUEUE", "UNKNOWN"] as const)(
  "preserves only allowlisted timeout stage %s through the parent",
  (stage) => {
    const line = failureLine(
      new PoolFailure("CONNECTION_TIMEOUT", stage, "CONCURRENT"),
    );
    expect(childFailureLine(line + "\n")).toBe(line);
    expect(childFailureLine(line + " token secret\n")).toBe(
      "FAIL: POOL_LIFECYCLE_FAILED",
    );
  },
);
it("localizes only exact connect timeout evidence", () => {
  expect(connectionStage(Error("timeout expired"))).toBe(
    "CONNECTION_ESTABLISHMENT",
  );
  expect(
    connectionStage(Error("Connection terminated due to connection timeout")),
  ).toBe("CONNECTION_ESTABLISHMENT");
  expect(
    connectionStage(Error("timeout exceeded when trying to connect")),
  ).toBe("CHECKOUT_QUEUE");
  expect(connectionStage(Error("Query read timeout"))).toBe("UNKNOWN");
  const line = failureLine(
    new PoolFailure(
      "CONNECTION_TIMEOUT",
      "private" as never,
      "account" as never,
    ),
  );
  expect(line).toBe("FAIL: CONNECTION_TIMEOUT STAGE=UNKNOWN PHASE=UNKNOWN");
});
