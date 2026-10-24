# Source boundaries

## Task 1.5 boundaries

lib/transfers contains browser-compatible manifest validation, checkpoints, IndexedDB staging, preparation, injectable mock-tested upload coordination, streaming restoration and output sinks. workers/local-transfer.worker.ts runs preparation and restoration off the UI thread. app/local-transfer and components/local-transfer.tsx provide the explicitly local-only demonstration. No provider adapter or production upload flow is enabled. Historical compression validation is imported by tests only.

- `app/`: App Router entry points, metadata and server layouts; global CSS imports only.
- `components/`: shared shell presentation and narrowly scoped interactive navigation/theme controls.
- `components/ui/`: domain-free native Button/IconButton, Input, Surface, Badge, Separator and Skeleton.
- `lib/`: low-level class composition and pure theme resolution/bootstrap.
- `hooks/`: client-side theme lifecycle and browser event subscriptions.
- `types/`: shared theme preference contract; keep feature-specific types within their feature.
- `styles/`: exact semantic tokens and foundational typography, states and responsive layout.

Create `features/` only for authorized product functionality (feature UI, hooks, types and domain logic co-located). Create `workers/` when bounded background processing begins. Integration adapters belong in `lib/` or the owning feature; schemas stay with their trust boundary. No empty directories or placeholder domain implementations are created. Routing composes features; shared primitives never import feature logic.

`components.json` prepares shadcn aliases and Tailwind v4 CSS-variable integration. `baseColor` is registry metadata; the actual palette is the custom neutral/jade CSS. No registry components have been generated. The small native primitives preserve shadcn-compatible semantic tokens without adding a compound widget dependency. CLI automatic Boxicons replacement remains unverified; inspect future generated output.

Server Components are the default. ThemeSelect, ShellNavigation and useTheme are client boundaries because they handle events/browser state; Boxicons forwardRef exports remain inside those boundaries. Directly import confirmed Boxicons subpaths, use currentColor and explicit 20 px dimensions (16 inline, 24 upload later). Hide redundant icons with aria-hidden; IconButton requires an accessible name independently of its SVG. No dynamic icon barrel wrapper is needed.

Input requires a visible associated label and described errors at its call site. Disabled buttons need a contextual explanation. Badge text describes status; Skeleton is decorative and never establishes progress. Surface is a semantic section: provide a heading or accessible name. Native controls retain keyboard behavior. Dialog/drawer composition, focus trapping and return-focus are deferred until a real workflow needs them.

AppShell accepts workspace children and an optional contextual details slot; no empty aside is rendered. At wide widths details can use a 320 px region with a 640 px minimum workspace. The interim narrow details slot stacks below the workspace; production file details must gain the documented modal drawer before feature use. Mobile/tablet navigation is a native disclosure, desktop navigation toggles 224/64 px widths for the current visit. Future navigation drawers and persisted collapse preferences require their own tests.

Theme preference is light/dark/system in localStorage under smart-storage-theme. The static prepaint script and client resolver share the same default/resolution contract; HTML hydration suppression is restricted to the deliberately mutated root attribute. Storage denial falls back to light on reload, while selection works in memory for the visit. System tracking occurs only for explicit system mode; storage events synchronize tabs. A future strict CSP must authorize the bootstrap with a nonce/hash; do not remove it and introduce a theme flash.

Task 1.6: lib/domain/file-metadata validates original display metadata and safe attachment hints; lib/domain/control-contracts defines strict bounded owner-free session input, decimal bigint bytes, states and explicit object-proof quality. These modules contain no provider SDK or network authority. Checkpoint metadata is optional/immutable and legacy-compatible; manifests are unchanged. Future server-only Auth/admin modules must be isolated and tested before cloud integration.
