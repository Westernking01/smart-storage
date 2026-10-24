import { Client, Pool, type PoolConfig } from "pg";

import {
  PoolFailure,
  connectionCategory,
  connectionStage,
  type TimeoutStage,
  type FailureCategory,
} from "./pool-isolation-errors";

type Pending = { callback: (error: Error) => void };
type Internals = {
  _pendingQueue: Pending[];
  _pulseQueue: () => void;
  newClient: (pending: Pending) => void;
};
const implementation = Pool.prototype as unknown as Internals;

/** Uses the installed pg-pool queue. Internal hooks are pinned by lifecycle tests.
 * Admission happens before construction; no exception is thrown into a driver
 * callback. Any failed connection/removal poisons this entire qualification run.
 */
export function qualificationPool(
  config: PoolConfig,
  Driver: typeof Client = Client,
) {
  let constructions = 0;
  let halted = false;
  let category: FailureCategory | undefined;
  let stage: TimeoutStage = "UNKNOWN";
  const halt = (
    reason: FailureCategory = "POOL_LIFECYCLE_FAILED",
    source: TimeoutStage = "UNKNOWN",
  ) => {
    halted = true;
    if (!category) stage = source;
    category ??= reason;
  };
  const failure = () =>
    new PoolFailure(category ?? "POOL_LIFECYCLE_FAILED", stage);
  class ObservedClient extends Driver {
    constructor(options?: ConstructorParameters<typeof Client>[0]) {
      super(options);
      const connect = this.connect.bind(this);
      // pg-pool always uses the callback form. Latch failure before its callback
      // can remove the client and pulse the pending queue.
      this.connect = ((callback: (error: Error | null) => void) => {
        try {
          connect((error: Error | null) => {
            if (error) halt(connectionCategory(error), connectionStage(error));
            callback(error ? failure() : null);
          });
        } catch (error) {
          halt(connectionCategory(error), connectionStage(error));
          queueMicrotask(() => callback(failure()));
        }
      }) as Client["connect"];
      this.on("error", () => {
        halt();
      });
    }
  }
  class QualificationPool extends Pool {
    get constructions() {
      return constructions;
    }
    get failureCategory() {
      return category;
    }
    get halted() {
      return halted;
    }
    _pulseQueue() {
      if (halted && !this.ending) {
        const pending = (this as unknown as Internals)._pendingQueue.splice(0);
        for (const item of pending) item.callback(failure());
        return;
      }
      implementation._pulseQueue.call(this);
    }
    newClient(pending: Pending) {
      if (halted || constructions >= 2) {
        halt();
        pending.callback(failure());
        this._pulseQueue();
        return;
      }
      constructions++;
      try {
        implementation.newClient.call(this, pending);
      } catch {
        halt();
        pending.callback(failure());
        this._pulseQueue();
      }
    }
  }
  const pool = new QualificationPool({
    ...config,
    max: 2,
    idleTimeoutMillis: 0,
    maxUses: Infinity,
    maxLifetimeSeconds: 0,
    Client: ObservedClient,
  });
  pool.on("release", (error) => {
    if (error) halt();
  });
  pool.on("remove", () => {
    if (!pool.ending) halt();
  });
  // Keep idle errors contained. The next checkout will fail closed; the runner
  // checks halted before reporting success and closes this dedicated pool.
  pool.on("error", () => {
    halt();
  });
  return pool;
}
