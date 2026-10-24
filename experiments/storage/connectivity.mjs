import { readConfiguration, audit } from "./config-audit.mjs";

// Read-only preparation probe. No upload, user creation, signing or object mutation.
async function main() {
  const safety = audit();
  if (
    safety.exposedFiles.length ||
    safety.serviceReferences.length ||
    safety.clientBundleExposure.length ||
    safety.publicHasPrivilegedValue ||
    safety.variables.some((item) => !item.formatValid)
  ) {
    console.log(
      JSON.stringify({
        executed: false,
        reason: "Configuration safety gate failed",
      }),
    );
    process.exitCode = 1;
    return;
  }
  const config = readConfiguration();
  const url = new URL("/auth/v1/settings", config.NEXT_PUBLIC_SUPABASE_URL);
  const response = await fetch(url, {
    headers: { apikey: config.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    /* Do not print response contents. */
  }
  const expectedAuthShape = Boolean(
    body &&
    typeof body === "object" &&
    typeof body.disable_signup === "boolean" &&
    body.external &&
    typeof body.external === "object",
  );
  console.log(
    JSON.stringify(
      {
        executed: true,
        operation: "GET Auth settings using public key",
        status: response.status,
        expectedAuthShape,
        publicKeyAcceptedForThisEndpoint: response.ok && expectedAuthShape,
        completeConfigurationVerified: false,
      },
      null,
      2,
    ),
  );
  if (!response.ok || !expectedAuthShape) process.exitCode = 1;
  if (
    response.ok &&
    expectedAuthShape &&
    process.argv.includes("--inspect-bucket")
  ) {
    // Explicit read-only bucket inspection; never use this credential for uploads/tests.
    const key = config.SUPABASE_SERVICE_ROLE_KEY;
    const headers = { apikey: key };
    if (!key.startsWith("sb_secret_")) headers.Authorization = `Bearer ${key}`;
    const bucketResponse = await fetch(
      new URL(
        "/storage/v1/bucket/smart-storage-feasibility",
        config.NEXT_PUBLIC_SUPABASE_URL,
      ),
      {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      },
    );
    let bucket = null;
    try {
      bucket = await bucketResponse.json();
    } catch {
      /* No raw response logging. */
    }
    const found =
      bucketResponse.ok && bucket?.id === "smart-storage-feasibility";
    const notFound =
      bucketResponse.status === 404 || String(bucket?.statusCode) === "404";
    console.log(
      JSON.stringify(
        {
          operation:
            "GET exact feasibility bucket using server-only administrative credential",
          status: bucketResponse.status,
          found,
          notFound,
          public: found ? bucket.public : null,
          fileSizeLimitBytes:
            found && Number.isSafeInteger(bucket.file_size_limit)
              ? bucket.file_size_limit
              : null,
          configuredMimeRestrictions: found
            ? Array.isArray(bucket.allowed_mime_types)
            : null,
          policiesVerified: false,
        },
        null,
        2,
      ),
    );
  }
}
main().catch((error) => {
  const code = error?.cause?.code;
  console.log(
    JSON.stringify({
      executed: true,
      completed: false,
      reason: "Network or parsing failure; response details suppressed",
      networkCode: /^[A-Z0-9_]+$/.test(code || "") ? code : null,
    }),
  );
  process.exitCode = 1;
});
