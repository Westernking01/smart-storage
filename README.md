Current local lifecycle (2026-10-17): Supabase Auth/PostgreSQL remain the identity and accounting control plane; encoded blocks use the gateway-controlled local volume. The opt-in authenticated upload/download/restore implementation and runtime prerequisites are in [local volume lifecycle](docs/local-volume-lifecycle.md). Cloud transfers remain disabled; ADR-041 remains open. Earlier direct-Supabase-Storage architecture statements below are historical.

# Smart Storage

## Current Phase 2 implementation - 2026-10-14

Phase 2 local secure-backend development is explicitly authorized. This supersedes historical phase prohibitions below while preserving their evidence. Auth, owner-only metadata, local migrations, transactional reservations and account-scoped staging are implemented. Real Supabase behavior and multi-connection races remain unverified. Backend defaults disabled; cloud transfers remain disabled; ADR-041 remains unresolved. No remote resources or old experiment/private state were accessed or changed. See docs/phase-2-spec.md and supabase/README.md.

Current Task 1.6: CONDITIONAL architecture readiness. Local filename/MIME checkpoint metadata and strict control contracts are implemented; working compression/restoration preserved. [Phase 2 specification and decision gates](docs/phase-2-spec.md) defines Auth, local schema/RLS, metadata and control-plane work ready for separate authorization. Real cloud transfers remain blocked by ADR-041/provider evidence; no real experiment state or Supabase requests were accessed. Earlier status sections are historical.

## Current Task 1.5 — local feasibility

Reusable durable staging and exact restoration are available at /local-transfer. Run npm.cmd run dev and open http://localhost:3000/local-transfer. This demonstration supports the existing 32 MiB experimental format and makes no provider requests. Task 1.5 is PARTIAL; [current evidence and remaining gates](docs/feasibility/staging-restoration.md) supersede historical status below. The previous provider experiment remains permanently stopped pending separate recovery authorization. ADR-041 and Task 1.6 architecture approval remain open.

**Upload less. Store smarter. Save data.**

Documentation foundation for a personal cloud storage service that applies lossless compression on the user's device before direct uploads. Compression savings depend on content; archives, media, and encrypted files often yield little benefit.

Phase 0 documentation is preserved. Tasks 1.1/1.2 foundation checks pass; Task 1.3A repaired dependency installation. Task 1.3B completed an isolated bounded Chromium compression proof of concept under experiments/compression. Production features remain unimplemented; hash/block/codec choices and resource budgets are provisional. See [the feasibility report](docs/feasibility/compression-spike.md) and [harness commands](experiments/compression/README.md). Task 1.4 local/documentation storage investigation is complete. Task 1.4A verified development configuration and read-only connectivity; actual upload/security validation awaits approved bucket/identity/policy setup and Task 1.4B execution. Hard per-reservation enforcement remains a release blocker. See [storage feasibility](docs/feasibility/storage-tus-spike.md). Stop before Task 1.4B/1.5/Phase 2; approval is required.

Task 1.4A update: development isolation is user-confirmed; public-key Auth connectivity passed. The feasibility bucket was not found. Draft setup/policies and a disabled provider matrix are prepared; no remote resources or write tests ran. See [development setup](docs/feasibility/supabase-dev-setup.md). Approval is required before bucket/users/policies or Task 1.4B. Earlier missing-configuration findings describe Task 1.4 history.

## Local development

Use Node >=22.12 and <25 (verified host: 24.12.0) with **npm 11.13.0** for dependency installation/lock changes. Dependencies and packageManager are pinned in package.json/package-lock.json; packageManager alone does not enforce npm. A portable pinned CLI invocation is `npx --yes npm@11.13.0 ci`, then `npm run dev`. Task 1.3A verified the equivalent locally installed npm 11.13.0 CLI, without changing global npm 11.6.2; its exact command is in the repair report. On Windows systems that block npm.ps1, use npm.cmd/npx.cmd instead.

Checks: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`, `npm run build`, then `npm run test:e2e`. Playwright uses a production server on 127.0.0.1:3100 and requires a prior build plus its compatible Chromium binary. Install that browser with `npx playwright install chromium` when needed and authorized. The initial shell requires no environment values; .env.example documents future placeholders only.

For a reviewed existing Chromium installation, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to its absolute executable path before running E2E; the configuration accepts this optional override without hardcoding a machine path. Task 1.1 smoke passed on installed Chromium 149.0.7827.55 (revision 1228), rather than Playwright 1.64's default revision 1248. A project-local browser cache can be selected using `PLAYWRIGHT_BROWSERS_PATH` for both installation and testing; .cache is ignored. Other browsers and full-product compatibility remain unverified.

Task 1.3A reran type checking, lint, formatting, build, 6 unit tests and 6 browser regressions successfully. The new audit still reports five high development lint-chain entries from the braces advisory; production-only audit reports zero. ESLint 9 is peer-compatible but deprecated upstream. See [progress and limitations](docs/12-PROGRESS.md). Task 1.3B remains complete within its bounded scope; Task 1.4 has local-model evidence only, with provider/security gates unpassed.

Application code lives in src/app, src/components, src/lib, src/hooks, src/types and src/styles; tests live in tests/unit and tests/e2e. See [source boundaries](src/README.md) for planned features/workers growth and the shadcn icon review policy. Do not run generators over the existing documentation. This workspace initially had no Git repository; .gitignore prepares version-control exclusions without creating a commit or remote.

## Documentation map

Read [AGENTS.md](AGENTS.md) first, then the product, architecture, decisions, and current progress. Consult subsystem specifications before changing that subsystem.

| Document                                               | Purpose                                                                      |
| ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| [01-PRD](docs/01-PRD.md)                               | Requirements, scope, acceptance and metrics                                  |
| [02-ARCHITECTURE](docs/02-ARCHITECTURE.md)             | Boundaries, flows, lifecycle and recovery                                    |
| [03-TECH-STACK](docs/03-TECH-STACK.md)                 | Compatibility, provider evidence and verification gates                      |
| [04-DATABASE](docs/04-DATABASE.md)                     | Conceptual schema, ownership and accounting                                  |
| [05-COMPRESSION-ENGINE](docs/05-COMPRESSION-ENGINE.md) | Versioned format, sampling, checksums and memory                             |
| [06-UPLOAD-SYSTEM](docs/06-UPLOAD-SYSTEM.md)           | TUS transport, sessions, resume and finalization                             |
| [07-UI-UX](docs/07-UI-UX.md)                           | Screens, accessibility and honest progress                                   |
| [08-SECURITY](docs/08-SECURITY.md)                     | Authorization, abuse controls and threat model                               |
| [09-ROADMAP](docs/09-ROADMAP.md)                       | Phases 0–9 with completion gates                                             |
| [10-TESTING](docs/10-TESTING.md)                       | Traceable functional and operational verification                            |
| [11-DECISIONS](docs/11-DECISIONS.md)                   | Accepted boundaries, proposed design and deferred work                       |
| [12-PROGRESS](docs/12-PROGRESS.md)                     | Completed work, risks and next approval                                      |
| [13-DESIGN-SYSTEM](docs/13-DESIGN-SYSTEM.md)           | Premium visual direction, themes, Boxicons, layout and reference-review gate |

Design finalization: the approved premium light-default direction with proposed neutral/jade tokens and optional dark theme now have exact tokens, typography, component geometry and responsive rules. Official @boxicons/react is mandatory; Lucide and generic template aesthetics are prohibited. All four supplied images are preserved in docs/references and analyzed in 13-DESIGN-SYSTEM, with reference 3 as primary dashboard inspiration. Design documentation is finalized and the light-default reference synthesis is approved; exact tokens and implementation evidence remain open. Folder layouts are future concepts; the MVP remains a flat file list.

## Design baseline

The proposed MVP uses Next.js on Vercel for UI and small control requests, Supabase Auth/PostgreSQL for identity and metadata, and a private Supabase Storage bucket for encoded block objects. Browser workers compress bounded blocks using gzip or preserve raw bytes. TUS transfers each object independently. Database publication follows provider object verification; restoring a file verifies its original byte content in the browser.

This is a reviewable proposal, not proof of provider or browser behavior. Numerical limits are provisional product targets in the specifications. Sources were reviewed on 2026-10-09; recheck them against the chosen account, runtime and browser versions before adopting implementation limits.

## Phase 2.1 readiness review - 2026-10-14

Local review is CONDITIONAL. Numeric manifest types corrected; five Storage predicates and execution/search-path boundaries exercised in disposable PostgreSQL with synthetic Auth/Storage helpers. Live provider semantics and independent-connection races remain unverified. See [readiness plan](docs/phase-2-provider-readiness.md) for the proposed bounded fresh-project manifest, target/mailbox/secret requirements and separate setup/test/cleanup approvals. No cloud connection/change or old private-state access occurred. ADR-041 unresolved; transfers disabled.
