import { Client } from "pg";
import { expect, it } from "vitest";
import { qualificationPool } from "../../scripts/pool-isolation-lifecycle";

function driver(fail = 0, sync = false) {
  let created = 0,
    connects = 0,
    ends = 0;
  class OfflineClient extends Client {
    constructor(options?: ConstructorParameters<typeof Client>[0]) {
      super(options);
      const index = ++created;
      if (sync) throw Error("private-constructor-diagnostic");
      this.connect = ((cb: (err: Error | null) => void) => {
        connects++;
        process.nextTick(() =>
          cb(index === fail ? Error("private-connect-diagnostic") : null),
        );
      }) as Client["connect"];
      this.end = ((cb?: () => void) => {
        ends++;
        if (cb) process.nextTick(cb);
        else return Promise.resolve();
      }) as Client["end"];
    }
  }
  return { Driver: OfflineClient, counts: () => ({ created, connects, ends }) };
}
it("uses the installed pg-pool for healthy reuse, two clients and a queued third checkout", async () => {
  const f = driver();
  const pool = qualificationPool({ connectionTimeoutMillis: 1000 }, f.Driver);
  try {
    const a = await pool.connect();
    a.release();
    const reused = await pool.connect();
    expect(reused).toBe(a);
    reused.release();
    const [first, second] = await Promise.all([pool.connect(), pool.connect()]);
    const queued = pool.connect();
    expect(pool.waitingCount).toBe(1);
    first.release();
    const third = await queued;
    expect(third).toBe(first);
    second.release();
    third.release();
    expect(pool.halted).toBe(false);
    expect(pool.constructions).toBe(2);
  } finally {
    await pool.end();
  }
  expect(f.counts()).toEqual({ created: 2, connects: 2, ends: 2 });
});
it.each([1, 2])(
  "latches asynchronous connection failure %s before pg-pool pulses its queue",
  async (failure) => {
    const f = driver(failure);
    const pool = qualificationPool({ connectionTimeoutMillis: 1000 }, f.Driver);
    const results = await Promise.allSettled([
      pool.connect(),
      pool.connect(),
      pool.connect(),
    ]);
    for (const result of results) {
      if (result.status === "fulfilled") result.value.release(true);
      else expect(String(result.reason)).toBe("Error: DATABASE_CONNECT_FAILED");
    }
    expect(pool.halted).toBe(true);
    expect(pool.constructions).toBe(2);
    await expect(pool.connect()).rejects.toThrow("DATABASE_CONNECT_FAILED");
    await pool.end();
    expect(f.counts().created).toBe(2);
  },
);
it("does not replace even the first client after a failed connection", async () => {
  const f = driver(1);
  const pool = qualificationPool({}, f.Driver);
  await expect(pool.connect()).rejects.toThrow("DATABASE_CONNECT_FAILED");
  await expect(pool.connect()).rejects.toThrow("DATABASE_CONNECT_FAILED");
  await pool.end();
  expect(f.counts().created).toBe(1);
});
it("destroyed cleanup client rejects queued work before constructing a replacement", async () => {
  const f = driver();
  const pool = qualificationPool({}, f.Driver);
  const a = await pool.connect(),
    b = await pool.connect();
  const queued = pool.connect();
  const assertion = expect(queued).rejects.toThrow("POOL_LIFECYCLE_FAILED");
  a.release(true);
  await assertion;
  b.release(true);
  await pool.end();
  expect(f.counts().created).toBe(2);
});
it("contains a synchronous constructor failure", async () => {
  const f = driver(0, true);
  const pool = qualificationPool({}, f.Driver);
  await expect(pool.connect()).rejects.toThrow("POOL_LIFECYCLE_FAILED");
  await expect(pool.connect()).rejects.toThrow("POOL_LIFECYCLE_FAILED");
  await pool.end();
  expect(pool.constructions).toBe(1);
});
it("unqueryable release halts before the remove callback can pulse a queued replacement", async () => {
  const f = driver();
  const pool = qualificationPool({}, f.Driver);
  const a = await pool.connect(),
    b = await pool.connect();
  const queued = pool.connect();
  const assertion = expect(queued).rejects.toThrow("POOL_LIFECYCLE_FAILED");
  (a as unknown as { _queryable: boolean })._queryable = false;
  a.release();
  await assertion;
  b.release(true);
  await pool.end();
  expect(pool.constructions).toBe(2);
});
it("contains idle errors and refuses subsequent checkout", async () => {
  const f = driver();
  const pool = qualificationPool({}, f.Driver);
  const a = await pool.connect();
  a.release();
  a.emit("error", Error("private-idle-diagnostic"));
  await expect(pool.connect()).rejects.toThrow("POOL_LIFECYCLE_FAILED");
  await pool.end();
  expect(pool.constructions).toBe(1);
});
it("preserves enforced pool options", async () => {
  const pool = qualificationPool({
    max: 99,
    maxUses: 1,
    idleTimeoutMillis: 1,
    maxLifetimeSeconds: 1,
  });
  expect(pool.options).toMatchObject({
    max: 2,
    maxUses: Infinity,
    idleTimeoutMillis: 0,
    maxLifetimeSeconds: 0,
  });
  await pool.end();
});

it("denies an over-ceiling newClient call without invoking a third constructor or throwing", async () => {
  const f = driver();
  const pool = qualificationPool({}, f.Driver);
  const a = await pool.connect(),
    b = await pool.connect();
  let denied: Error | undefined;
  expect(() =>
    pool.newClient({
      callback: (error) => {
        denied = error;
      },
    }),
  ).not.toThrow();
  expect(denied?.message).toBe("POOL_LIFECYCLE_FAILED");
  expect(pool.constructions).toBe(2);
  expect(f.counts().created).toBe(2);
  a.release(true);
  b.release(true);
  await pool.end();
});

it("recognizes installed pg-pool queue timeout without replacing clients", async () => {
  const { vi } = await import("vitest");
  const { connectionCategory } =
    await import("../../scripts/pool-isolation-errors");
  vi.useFakeTimers();
  const f = driver();
  const pool = qualificationPool({ connectionTimeoutMillis: 5000 }, f.Driver);
  try {
    const a = await pool.connect(),
      b = await pool.connect();
    const timedOut = pool
      .connect()
      .catch((error: unknown) => connectionCategory(error));
    await vi.advanceTimersByTimeAsync(5000);
    expect(await timedOut).toBe("CONNECTION_TIMEOUT");
    a.release(true);
    b.release(true);
    expect(pool.constructions).toBe(2);
  } finally {
    await pool.end();
    vi.useRealTimers();
  }
});
it("recognizes installed pg-pool connection timer and latches timeout before servicing waiters", async () => {
  const { vi } = await import("vitest");
  const { connectionCategory } =
    await import("../../scripts/pool-isolation-errors");
  vi.useFakeTimers();
  class StalledClient extends Client {
    constructor(options?: ConstructorParameters<typeof Client>[0]) {
      super(options);
      this.connect = ((cb: (error: Error) => void) => {
        (
          this as unknown as { connection: { stream: { destroy: () => void } } }
        ).connection.stream.destroy = () => cb(Error("timeout expired"));
      }) as Client["connect"];
      this.end = ((cb?: () => void) => {
        if (cb) cb();
        else return Promise.resolve();
      }) as Client["end"];
    }
  }
  const pool = qualificationPool(
    { connectionTimeoutMillis: 5000 },
    StalledClient,
  );
  try {
    const requests = Promise.all(
      [pool.connect(), pool.connect(), pool.connect()].map((p) =>
        p.catch((error: unknown) => connectionCategory(error)),
      ),
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(await requests).toEqual(Array(3).fill("CONNECTION_TIMEOUT"));
    expect(pool.failureCategory).toBe("CONNECTION_TIMEOUT");
    expect(pool.constructions).toBe(2);
  } finally {
    await pool.end();
    vi.useRealTimers();
  }
});
