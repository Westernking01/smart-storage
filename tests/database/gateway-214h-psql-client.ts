// Test-only persistent psql bridge. Runtime modules always use bind parameters;
// this bridge encodes bound values as SQL literals for the local psql executable.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  GatewayPostgresClient,
  GatewayPostgresPool,
} from "../../src/lib/gateway/postgres-runtime.server";

export class PsqlTestClient implements GatewayPostgresClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private output = "";
  private diagnostic = "";
  private pending: {
    marker: string;
    resolve: (value: { rows: Record<string, unknown>[] }) => void;
    reject: (error: Error) => void;
    sql: string;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  constructor(
    user: string,
    passfile: string,
    database = "smart_storage_gateway_test",
    host = "127.0.0.1",
  ) {
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (key.startsWith("PG")) delete env[key];
    delete env.SMART_STORAGE_RUNTIME_PASSFILE;
    env.PGPASSFILE = passfile;
    env.PGCONNECT_TIMEOUT = "3";
    this.child = spawn(
      "C:/Program Files/PostgreSQL/17/bin/psql.exe",
      [
        "-X",
        "-w",
        "-qAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-h",
        host,
        "-p",
        "5432",
        "-U",
        user,
        "-d",
        database,
      ],
      { env },
    );
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.output += chunk.toString();
      const p = this.pending;
      if (!p || !this.output.includes(p.marker)) return;
      const value = this.output.slice(0, this.output.indexOf(p.marker)).trim();
      this.output = this.output
        .slice(this.output.indexOf(p.marker) + p.marker.length)
        .trimStart();
      this.pending = null;
      clearTimeout(p.timer);
      if (/AS allowed/i.test(p.sql))
        p.resolve({ rows: [{ allowed: value === "t" }] });
      else if (/AS (permit|receipt)/i.test(p.sql)) {
        const alias = /AS (permit|receipt)/i.exec(p.sql)![1].toLowerCase();
        try {
          p.resolve({
            rows: [{ [alias]: alias === "permit" ? JSON.parse(value) : value }],
          });
        } catch {
          p.reject(new Error("INVALID_DATABASE_RESULT"));
        }
      } else p.resolve({ rows: value ? [{ value }] : [] });
    });
    // Never emit raw SQL errors: they may include the submitted object path.
    this.child.stderr.on("data", (chunk: Buffer) => {
      const token = /ERROR:\s+([A-Z][A-Z_]{2,})\b/.exec(chunk.toString())?.[1];
      if (token) this.diagnostic = token;
    });
    this.child.stdin.on("error", () => this.reject("PSQL_INPUT_CLOSED"));
    this.child.on("error", () => this.reject("PSQL_PROCESS_FAILURE"));
    this.child.on("exit", () =>
      this.reject(
        "PSQL_REQUEST_REJECTED" +
          (this.diagnostic ? ":" + this.diagnostic : ""),
      ),
    );
  }
  private reject(reason: string) {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error(reason));
      this.pending = null;
    }
  }
  query(sql: string, values: unknown[] = []) {
    if (this.pending)
      return Promise.reject(new Error("CONCURRENT_CLIENT_QUERY"));
    if (this.child.exitCode !== null)
      return Promise.reject(new Error("CLOSED_CLIENT"));
    const rendered = sql.replace(/\$(\d+)/g, (_, n: string) => {
      const value = values[Number(n) - 1];
      if (value === null) return "NULL";
      if (typeof value === "number" && Number.isSafeInteger(value))
        return String(value);
      if (typeof value !== "string") throw new Error("INVALID_TEST_BIND");
      return "E'" + value.replaceAll("\\", "\\\\").replaceAll("'", "''") + "'";
    });
    return new Promise<{ rows: Record<string, unknown>[] }>(
      (resolve, reject) => {
        const marker = "query_" + randomUUID();
        const timer = setTimeout(() => {
          this.reject("PSQL_TIMEOUT");
          this.child.kill();
        }, 10000);
        this.pending = { marker, resolve, reject, sql, timer };
        this.child.stdin.write(rendered + ";\n\\echo " + marker + "\n");
      },
    );
  }
  release() {
    this.child.stdin.end("\\q\n");
  }
}
export function runtimePool(passfile: string): GatewayPostgresPool {
  return {
    connect: async () =>
      new PsqlTestClient("ss_gateway_runtime_test", passfile),
  };
}
