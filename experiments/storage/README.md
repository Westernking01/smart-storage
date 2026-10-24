# Task 1.4 local storage protocol probe

Run from the repository root:

`node node_modules/vitest/vitest.mjs run --config experiments/storage/vitest.config.ts`

This suite is an artificial TUS-shaped loopback HTTP model, not a Supabase emulator or provider security test. It has no credentials, SDK, cloud endpoint, RLS, real token expiry, durable storage or production imports. The adapter rejects external URLs and redirects. Resources are allocated directly by the test: POST creation and real provider empty-object acceptance are untested. Node fetch is used; browser CORS and refresh are untested. Client restart uses identical retained bytes, not durable browser recovery. Modeled partial commits do not establish provider PATCH atomicity.

At most one server/object is active. Largest fixture is 8 MiB; other objects are tiny. No file fixtures are written. Closing each server releases connections and the in-memory object; this is local disposal, not provider deletion. The retry budget is bounded. Offset recovery, attempted/confirmed accounting, final short chunks and encoded-byte round trips are exercised over HTTP. The quota and no-upsert cases are explicitly conceptual counterexamples/models.

Do not adapt this probe into production code or point it at Supabase. Provider prerequisites and the separate security validation matrix are in [the report](../../docs/feasibility/storage-tus-spike.md). No provider testing, policy creation, migrations or SDK installation is authorized by this fallback.

Task 1.4A adds `config-audit.mjs` (boolean-only local checks), `connectivity.mjs` (GET Auth settings only; optional exact-bucket read), a guarded SQL proposal under setup and a disabled provider-plan.json. Connectivity is a preparation read, not a provider upload/security test. The optional `--inspect-bucket` uses the administrative credential only inside Node for a single bucket metadata read; it must never be used to test user ownership. See [setup and approval steps](../../docs/feasibility/supabase-dev-setup.md). Do not run the SQL or provider write scenarios without subsequent explicit approval. No remote executor or SDK is installed.
