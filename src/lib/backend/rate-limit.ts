/** Process-local abuse ceiling only; shared deployment-wide limiter is a release gate. */
export class AuthLimiter {
  private counters = new Map<string, { count: number; until: number }>();
  allow(key: string, now = Date.now()) {
    for (const [k, v] of this.counters)
      if (v.until <= now) this.counters.delete(k);
    const global = this.counters.get("global") ?? {
      count: 0,
      until: now + 60000,
    };
    const subject = this.counters.get(key) ?? { count: 0, until: now + 300000 };
    if (global.count >= 60 || subject.count >= 8 || this.counters.size >= 1000)
      return false;
    global.count++;
    subject.count++;
    this.counters.set("global", global);
    this.counters.set(key, subject);
    return true;
  }
}
