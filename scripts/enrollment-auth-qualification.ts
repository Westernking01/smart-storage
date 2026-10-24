import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { z } from "zod";
import { qualificationConfig } from "./publisher-tls-qualification";
import { postgresPublisherIdentityProbe } from "../src/lib/backend/development-publisher-postgres.server";

const origin = "https://fneuqneqaopkmpeevlqz.supabase.co";

const categories = [
  "CONFIGURATION_INVALID",
  "AUTH_REJECTED",
  "AUTH_REQUEST_FAILED",
  "AUTH_VALIDATION_FAILED",
  "IDENTITY_MISMATCH",
  "DATABASE_CONNECTION_FAILED",
  "DATABASE_CONTEXT_FAILED",
  "ENROLLMENT_DENIED",
  "CLEANUP_FAILED",
  "QUALIFICATION_FAILED",
] as const;
type Category = (typeof categories)[number];
class QualificationFailure extends Error {
  constructor(readonly category: Category) {
    super(category);
  }
}
// Never render arbitrary Error.message, provider fields, causes or stack traces.
export function qualificationFailureLine(error: unknown) {
  const category =
    error instanceof QualificationFailure && categories.includes(error.category)
      ? error.category
      : "QUALIFICATION_FAILED";
  return `FAIL: enrollment qualification [${category}]; stop without retry or activation.`;
}

// One password exchange; no refresh, persistence, redirects or request retries.
export function qualificationFetch(
  base: typeof fetch,
  userLimit = 4,
): typeof fetch {
  const counts = new Map<string, number>();
  return async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    const key = `${method.toUpperCase()} ${url.pathname}${url.search}`;
    const limits: Record<string, number> = {
      "POST /auth/v1/token?grant_type=password": 1,
      "GET /auth/v1/user": userLimit, // two fresh checks; getClaims may fall back to getUser
      "GET /auth/v1/.well-known/jwks.json": 1,
    };
    const count = (counts.get(key) ?? 0) + 1;
    if (
      url.origin !== origin ||
      url.hash ||
      url.username ||
      url.password ||
      !limits[key] ||
      count > limits[key]
    )
      throw Error("ENROLLMENT_AUTH_REQUEST_DENIED");
    counts.set(key, count);
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    // Installed SDK initializes Auth with the API key as Bearer. Publishable
    // keys belong in apikey, never in Authorization. Keep ordinary JWTs intact.
    const apiKey = headers.get("apikey");
    if (
      key === "POST /auth/v1/token?grant_type=password" &&
      apiKey?.startsWith("sb_publishable_") &&
      headers.get("authorization") === `Bearer ${apiKey}`
    )
      headers.delete("authorization");
    return base(input, {
      ...init,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
  };
}

export async function runEnrollmentQualification(
  auth: Parameters<typeof postgresPublisherIdentityProbe>[1] & {
    signInWithPassword: (credentials: {
      email: string;
      password: string;
    }) => Promise<{ error: unknown }>;
  },
  db: Parameters<typeof postgresPublisherIdentityProbe>[0] & {
    end: () => Promise<void>;
  },
  credentials: { email: string; password: string },
  expectedId: string,
) {
  let category: Category = "CONFIGURATION_INVALID";
  let mismatch = false;
  try {
    z.uuid().parse(expectedId);
    category = "AUTH_REQUEST_FAILED";
    const signedIn = await auth.signInWithPassword(credentials);
    if (signedIn.error) {
      const status = (signedIn.error as { status?: unknown }).status;
      if (status === 400 || status === 401 || status === 403)
        category = "AUTH_REJECTED";
      throw Error();
    }
    category = "AUTH_VALIDATION_FAILED";
    // Pin only a freshly verified Auth response. Expected ID never becomes claims.
    const boundAuth = {
      getSession: auth.getSession.bind(auth),
      getClaims: auth.getClaims.bind(auth),
      getUser: async (...args: Parameters<typeof auth.getUser>) => {
        const result = await auth.getUser(...args);
        if (result.error || !result.data.user) throw Error();
        if (result.data.user.id !== expectedId) {
          mismatch = true;
          throw Error();
        }
        return result;
      },
    };
    try {
      return await postgresPublisherIdentityProbe(db, boundAuth);
    } catch (error) {
      // The probe manufactures this fixed metadata after swallowing raw errors.
      const probeCategory = (error as { qualificationCategory?: unknown })
        ?.qualificationCategory;
      if (
        typeof probeCategory === "string" &&
        categories.includes(probeCategory as Category)
      )
        category = probeCategory as Category;
      if (mismatch && category !== "CLEANUP_FAILED")
        category = "IDENTITY_MISMATCH";
      throw Error();
    }
  } catch {
    throw new QualificationFailure(category);
  } finally {
    credentials.password = "";
    await db.end().catch(() => {
      throw new QualificationFailure("CLEANUP_FAILED");
    });
  }
}

if (process.argv[2] === "--enrollment-execute") {
  let configured = false;
  try {
    const config = qualificationConfig(process.env);
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
    if (
      !key.startsWith("sb_publishable_") ||
      process.env.NEXT_PUBLIC_SUPABASE_URL !== origin
    )
      throw Error();
    const expectedId = z
      .uuid()
      .parse(process.env.SMART_STORAGE_QUALIFICATION_USER_ID);
    const email = z
      .email()
      .parse(process.env.SMART_STORAGE_QUALIFICATION_EMAIL);
    const password = process.env.SMART_STORAGE_QUALIFICATION_PASSWORD;
    if (!password) throw Error();
    for (const name of [
      "SMART_STORAGE_DEV_CLOUD_DATABASE_URL",
      "SMART_STORAGE_QUALIFICATION_PASSWORD",
      "SMART_STORAGE_QUALIFICATION_EMAIL",
      "SMART_STORAGE_QUALIFICATION_USER_ID",
    ])
      delete process.env[name];
    const client = createClient(origin, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: qualificationFetch(fetch) },
    });
    const db = new Pool({ ...config, max: 1 });
    db.on("error", () => {});
    configured = true;
    await runEnrollmentQualification(
      client.auth,
      db,
      { email, password },
      expectedId,
    );
    console.log(
      "PASS: ordinary Auth identity, enrollment TRUE, read-only context and rollback cleanup verified; dedicated pool closed.",
    );
  } catch (error) {
    console.error(
      qualificationFailureLine(
        configured ? error : new QualificationFailure("CONFIGURATION_INVALID"),
      ),
    );
    process.exitCode = 1;
  }
}
