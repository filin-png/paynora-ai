# Dependency & License Review (Phase 17)

A point-in-time review of this project's direct npm dependencies and
known vulnerabilities, generated 2026-09-04. Re-running this review
periodically (or wiring up GitHub's Dependabot alerts, if not already
enabled on this repository) is more reliable than treating this document
as permanently current — dependencies and advisories change continuously.

## License review — direct dependencies

Every direct dependency (production and dev) uses a permissive license.
No copyleft license (GPL, AGPL, LGPL) appears anywhere in this list, so
there is no license-compatibility concern with shipping PAYNORA as a
closed-source commercial product.

| Package | License |
| --- | --- |
| `@noble/curves` | MIT |
| `@noble/hashes` | MIT |
| `@prisma/adapter-pg` | Apache-2.0 |
| `@prisma/client` | Apache-2.0 |
| `bcryptjs` | BSD-3-Clause |
| `class-variance-authority` | Apache-2.0 |
| `clsx` | MIT |
| `lucide-react` | ISC |
| `marked` | MIT |
| `next` | MIT |
| `next-auth` | ISC |
| `nodemailer` | MIT-0 |
| `papaparse` | MIT |
| `pg` | MIT |
| `react` / `react-dom` | MIT |
| `tailwind-merge` | MIT |
| `zod` | MIT |
| `@tailwindcss/postcss`, `tailwindcss` | MIT |
| `@types/*` (bcryptjs, node, nodemailer, papaparse, pg, react, react-dom) | MIT |
| `dotenv` | BSD-2-Clause |
| `eslint`, `eslint-config-next` | MIT |
| `prisma` | Apache-2.0 |
| `tsx` | MIT |
| `typescript` | Apache-2.0 |
| `vitest` | MIT |

This is a manual review of each direct dependency's own `package.json`
`license` field — not a full transitive-tree audit, which is a
substantially larger surface (683 total packages including transitive
deps per `npm audit`'s dependency count) and typically only relevant for
license compliance if a transitive package's license is *more*
restrictive than its parent's declared terms, which is uncommon for the
well-established ecosystems (React, Next.js, Prisma) this project builds
on.

## Vulnerability review — `npm audit`

`npm audit` (2026-09-04) reports **5 high-severity** findings, **0**
critical/moderate/low. All five trace back to `prisma`'s own dev-tooling
dependency tree — none are in a package this application's *runtime*
(the deployed Next.js server) actually executes.

| Package | Advisory | Severity | Path | Real-world exposure in this app |
| --- | --- | --- | --- | --- |
| `deepmerge-ts` | Stack exhaustion merging recursive object graphs ([GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx)) | high | `prisma` → `@prisma/config` → `deepmerge-ts` | Prisma CLI's own config-merging internals, invoked only when a developer runs `prisma generate`/`migrate` locally — never reachable from the deployed app or from any request this app serves. |
| `@prisma/config` | (inherits the `deepmerge-ts` finding above) | high | `prisma` → `@prisma/config` | Same as above. |
| `mysql2` | Auth-plugin downgrade leaks plaintext credentials ([GHSA-3f6p-5ww8-9rcr](https://github.com/advisories/GHSA-3f6p-5ww8-9rcr)); decompression-bomb DoS ([GHSA-rgwj-5xj2-c3m3](https://github.com/advisories/GHSA-rgwj-5xj2-c3m3)) | high | `prisma` → `mysql2` | Bundled by Prisma CLI for its multi-database-provider support. This project's `DATABASE_URL` is always PostgreSQL (`prisma/schema.prisma`'s `provider = "postgresql"`) — the MySQL driver code path is never invoked, in dev or production. |
| `fast-uri` | Four host-confusion/SSRF-adjacent advisories in URI normalization ([GHSA-5jgf-p345-68v8](https://github.com/advisories/GHSA-5jgf-p345-68v8), [GHSA-f65p-4m7j-42xc](https://github.com/advisories/GHSA-f65p-4m7j-42xc), [GHSA-fph4-wmhf-6fwf](https://github.com/advisories/GHSA-fph4-wmhf-6fwf), [GHSA-jqff-g426-hqxp](https://github.com/advisories/GHSA-jqff-g426-hqxp)) | high | `prisma` → `@prisma/dev` → `@prisma/streams-local` → `ajv` → `fast-uri` | `ajv` uses `fast-uri` to resolve `$ref` URIs inside **Prisma's own JSON schemas**, not attacker-controlled input — this app never asks `ajv`/`fast-uri` to parse a URL from a request, a customer record, or any other untrusted source. |
| `prisma` (direct) | (inherits the two findings above via its own dependency tree) | high | `prisma` | The CLI package itself is a **devDependency** (`package.json`) — not part of the built Next.js server that actually runs in production; `next build && next start` never invokes it. |

**Assessment: no exploitable path from this app's actual runtime.** Every
finding above sits inside `prisma`'s CLI/dev-tooling dependency tree,
several layers removed from any code path this application's deployed
server executes or any input a real user/attacker can influence. The
severity ratings themselves are accurate for the *library in isolation*
(a real SSRF/credential-leak class of bug) — this assessment is about
*this project's* specific usage, not a claim that the underlying
libraries are safe in general.

### Why no fix was applied in this phase

`npm audit fix` (without `--force`) reports the safe path for these
findings would require Prisma to publish an updated release with newer
transitive dependencies — as of this review, the only resolution `npm`
itself offers is downgrading `prisma` from `7.9.1` to `6.19.3`
(`fixAvailable.isSemVerMajor: true` for every finding except the
deeply-nested `fast-uri` one). A major-version **downgrade** of the
Prisma CLI this project's entire migration history and `prisma.config.ts`
setup depends on is not a safe unattended fix — it would very likely
break schema/migration compatibility for a security exposure that isn't
actually reachable in this app. This phase deliberately did not run
`npm audit fix --force` or downgrade Prisma; that decision is left to a
deliberate, tested upgrade/downgrade decision, not an automated dependency
patch.

### Recommended follow-up (not done in this phase)

- Re-run `npm audit` after any future Prisma version bump (Prisma
  releases regularly; a newer 7.x or 8.x release will likely resolve the
  `@prisma/config`/`mysql2`/`fast-uri` chain without requiring a
  downgrade).
- If this repository has GitHub Dependabot alerts available, enable them
  — they track advisories continuously rather than only at a point-in-time
  manual review like this one.
