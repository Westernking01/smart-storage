interface Reply {
  id: number;
  event?: string;
  error?: string;
  name?: string;
  result?: unknown;
  [key: string]: unknown;
}
interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
export class Harness {
  worker: Worker;
  sequence = 0;
  pending = new Map<number, Pending>();
  events: Reply[] = [];
  onEvent?: (event: Reply) => void;
  gaps: number[] = [];
  heap: number[] = [];
  interval: ReturnType<typeof setInterval>;
  lastTick = performance.now();
  constructor() {
    this.worker = new Worker("/worker.js", { type: "module" });
    this.worker.onmessage = ({ data }: MessageEvent<Reply>) => {
      if (data.event) {
        this.events.push(data);
        if (this.events.length > 1024) this.events.shift();
        this.onEvent?.(data);
        return;
      }
      const p = this.pending.get(data.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(data.id);
      if (data.error) {
        const error = new Error(data.error);
        error.name = data.name ?? "Error";
        p.reject(error);
      } else p.resolve(data.result);
    };
    this.worker.onerror = () => this.close("Worker error");
    this.interval = setInterval(() => {
      const now = performance.now();
      this.gaps.push(now - this.lastTick);
      if (this.gaps.length > 4096) this.gaps.shift();
      this.lastTick = now;
      const memory = (
        performance as Performance & { memory?: { usedJSHeapSize: number } }
      ).memory;
      if (memory) {
        this.heap.push(memory.usedJSHeapSize);
        if (this.heap.length > 4096) this.heap.shift();
      }
    }, 20);
  }
  call<T>(
    method: string,
    args: Record<string, unknown> = {},
    transfer: Transferable[] = [],
  ): Promise<T> {
    if (this.pending.size >= 4)
      return Promise.reject(new Error("Control queue limit"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close("Worker timeout");
      }, 60_000);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.worker.postMessage({ id, method, args }, transfer);
    });
  }
  cancel() {
    this.worker.postMessage({ id: 0, method: "cancel", args: {} });
  }
  resetMeasurements() {
    this.events = [];
    this.gaps = [];
    this.heap = [];
    this.lastTick = performance.now();
  }
  close(reason = "Worker terminated") {
    this.worker.terminate();
    clearInterval(this.interval);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
const harness = new Harness();
(globalThis as unknown as { spike: Harness }).spike = harness;
const status = document.querySelector("#status")!;
harness.call("init").then(
  (value) => {
    status.textContent = JSON.stringify(value);
  },
  (error) => {
    status.textContent = String(error);
  },
);
