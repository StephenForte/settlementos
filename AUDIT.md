# SettlementOS Security, Accuracy, and Maintainability Audit

**Date:** 2026-07-09  
**Scope:** Read-only review of application/API code, Prisma schema, Solidity contracts, deployment scripts, configuration, and tests.  
**Status:** No application code was changed as part of this audit.

## Executive summary

SettlementOS is suitable as a closed local demo, but is not safe to expose publicly or use with valuable assets yet. The largest gaps are unauthenticated API access, non-atomic settlement execution, money arithmetic based on JavaScript numbers, and an audit log that is not independently tamper-proof.

The project clearly labels itself as a testnet demo with mock assets. The findings below focus on the work needed to evolve it toward an operational site.

## Semgrep baseline findings — reviewed and accepted (2026-08-10)

CI's Semgrep job (`semgrep ci` with `SEMGREP_APP_TOKEN`, Pro Code + Supply Chain)
reports **"Current version has 4 findings"** while still exiting green because
PR runs are **diff scans** — "Findings: 0 (0 blocking)" means zero *new*
findings in the changed files, not a clean project. The baseline four are
**Supply Chain (SCA) reachability** findings on `package-lock.json`, not Code
(SAST) rules: the same CI log re-scans the baseline with "4 Supply Chain rules"
and "No code rules to run."

Local reproduction (this triage):

- `semgrep scan --config auto` over the full git tree → **0 Code findings**
  (community registry; matches that the baseline is not a Code finding set).
- Enumerating Semgrep Cloud's exact `check_id` strings requires
  `SEMGREP_APP_TOKEN` / Semgrep Cloud (`steve-labs` org) and was **not** done.
  Mapping Semgrep's "4 findings" / "4 Supply Chain rules" (from the CI log) onto
  the four packages below is an **inference** from that log plus the lockfile
  advisory set — not a reading of Semgrep's output, and not a claim about which
  Semgrep rule or severity filter produced the count. Stable identifiers used
  here are GHSA IDs from `npm audit --json`.
- The table lists the four packages that carry **moderate-or-higher**
  advisories, **deduped by package** (3 high + 1 moderate): `adm-zip` (high),
  `serialize-javascript` (high RCE; also carries moderate CPU-DoS
  `GHSA-qj8w-gfj5-8c6v`, listed once), `tmp` (high path traversal), and `uuid`
  (moderate). These are **not** "four High" advisories. Five further distinct
  advisories in the same lockfile — one additional moderate already noted on
  `serialize-javascript`, plus four **low** (`cookie` `GHSA-pxg6-pf52-xh8x`,
  `diff` `GHSA-73rr-hh4g-fpgx`, `elliptic` `GHSA-848j-6mx2-7j84`, and a second
  `tmp` `GHSA-52f5-9888-hmc6`) — are equally transitive under `hardhat@2.29.0`
  and are covered by the same accept decision (Dependency advisories section).

| Advisory | Package (lockfile) | Location | Disposition |
|---|---|---|---|
| `GHSA-xcpc-8h2w-3j85` | `adm-zip@0.4.16` | `package-lock.json:3921` | **ACCEPTED** — transitive under `hardhat@2.29.0` (devDependency). Hostile ZIP → memory blow-up in the Hardhat toolchain; we compile our own contracts; never ships in the Next.js runtime. No non-breaking patch on Hardhat 2.x (see Dependency advisories section). |
| `GHSA-5c6j-r48x-rmvq` | `serialize-javascript@6.0.2` | `package-lock.json:9052` | **ACCEPTED** — via `hardhat` → `mocha`. RCE requires feeding hostile input into mocha's serializer; not on the application attack surface. Same package also has moderate `GHSA-qj8w-gfj5-8c6v` (CPU DoS); listed once. Fix path is Hardhat 3 (breaking). |
| `GHSA-ph9p-34f9-6g65` | `tmp@0.0.33` | `package-lock.json:9799` | **ACCEPTED** — via `hardhat` → `solc`. Path traversal in a temp-dir helper used by the Solidity compiler toolchain; local/dev only. |
| `GHSA-w5hq-g745-h8pq` | `uuid@8.3.2` | `package-lock.json:10171` | **ACCEPTED** — direct transitive of `hardhat` (**moderate**, not high). Buffer bounds issue in unused v3/v5/v6 APIs of a devDependency; not imported by app/runtime code. |

No `nosemgrep` suppressions were added. Remediation is the Hardhat 3 migration
(deliberately deferred — see the Dependency advisories section below); do not
treat a green Semgrep diff check as "baseline reviewed" without this record.

## Dependency advisories — reviewed and accepted (2026-08-10)

`npm audit` on this tree (2026-08-10) reports **17 vulnerabilities: 11 low,
2 moderate, 4 high** (0 critical). Patchhog / similar "clean scan" statuses that
pass when nothing is auto-fixable high/critical are not a substitute for this
review.

**Root cause (single):** every advisory is transitive under `hardhat@2.29.0`
(a `devDependency`). Verified with `npm ls <pkg> --all` for representative
leaves — `adm-zip`, `serialize-javascript`, `tmp`, `uuid`, `cookie` — each path
roots at `hardhat`. Nothing in the tree reaches the Next.js runtime bundle.

**Why there is no patch on the current major:** `hardhat@2.29.0` is the last 2.x
release. npm's own remediation text is: fix available via
`npm audit fix --force` / Will install `hardhat@3.12.0`, which is a breaking
change. There is no 2.x bump that clears the graph.

**Blast radius of the alternative (Hardhat 3 now):** Hardhat 3 is an ESM/TS-first
rewrite. This repo's Hardhat surface is `hardhat.config.cjs` +
`hardhat.config.polygon.cjs`, a vitest fixture that boots two nodes on
9545/9546, and deploy scripts that read `chain/artifacts/`. Migrating as a
security drive-by would put the full test suite and both deploy paths at risk
for a toolchain that never ships.

**Exposure being accepted:** a **dev-only** compile/test toolchain. Concrete
highs include `serialize-javascript` RCE (requires hostile input into mocha)
and `tmp` / `adm-zip` issues inside solc/Hardhat helpers — we compile our own
contracts; untrusted artifact input is not an application threat model here.

**Decision:** **accept; do not migrate now.** Do not run `npm audit fix` or
`npm audit fix --force` for this class of finding. Revisit when Hardhat 3 is
worth doing on its own merits (tooling/ESM migration), not as a security fix
for a non-runtime dependency graph.

## Findings

### P0 — API access permits data disclosure and settlement actions

Every API route currently lacks authentication, tenant scoping, and authorization. A caller can read all entities, wallets, payments, compliance results, audit events, treasury balances, and the full reconciliation CSV. A caller can also approve/reject compliance reviews and execute settlements using the server's operator key.

Relevant code:

- `app/api/payments/route.ts`
- `app/api/payments/[id]/route.ts`
- `app/api/payments/[id]/review/route.ts`
- `app/api/balances/route.ts`
- `app/api/reconciliation/route.ts`

Recommended remediation:

1. Add authenticated identities and enforce authorization on every route.
2. Define explicit roles such as operator, compliance reviewer, and entity user.
3. Enforce entity/tenant-level access controls for every read and write.
4. Record the authenticated principal as the audit actor; do not accept reviewer identity from the request body.
5. Add API rate limits, request-size limits, and idempotency keys for write operations.

### P0 — Public-chain activity is externally visible

Base Sepolia transactions and ERC-20 transfers make wallet addresses, amounts, and timing publicly visible. The UI also links records to public explorer pages. This conflicts with a literal requirement that data never leave the project boundary.

Recommended remediation:

1. Treat all public-chain metadata as public.
2. Never put PII, invoice references, internal payment identifiers, or sensitive business data in calldata or events.
3. Document the privacy model and require explicit acknowledgement from users.
4. Evaluate whether an off-chain ledger, private network, or privacy-preserving design is required for the intended product.

### P1 — Concurrent execution can corrupt lifecycle state and liquidity accounting

Payment execution uses read-then-write transitions without conditional atomic updates. Two simultaneous requests can both pass compliance or liquidity checks. This can duplicate compliance checks, release another execution's reservation, and leave a payment with an incorrect terminal status.

Relevant code:

- `app/api/payments/[id]/execute/route.ts`
- `lib/executor.ts`
- `lib/routing.ts`

Recommended remediation:

1. Execute payments through a durable job/queue with a per-payment lease.
2. Use compare-and-swap updates, such as `WHERE id = ? AND status = ?`, for every transition.
3. Reserve liquidity in the same database transaction that claims the payment execution lease.
4. Give every externally triggered write an idempotency key.
5. Add concurrent-execution integration tests.

### P1 — Failure after source settlement can strand funds

After `settlePayment` releases source assets to the treasury, a failed destination payout only marks the payment as failed. The refund path runs only before source settlement. A recipient may therefore not receive the destination leg while the sender's source assets have already been released to treasury.

Relevant code:

- `lib/executor.ts` — source settlement and exception/refund handling

Recommended remediation:

1. Design an explicit settlement saga with compensating actions for every irreversible step.
2. Add a treasury-funded source-asset refund mechanism for post-settlement failures.
3. Reconcile on-chain facts before retries; do not infer state only from the database.
4. Add alerting and an operator repair workflow for partial settlements.
5. Test a destination payout failure after source-chain settlement.

### P1 — Monetary validation and liquidity arithmetic are unsafe

The API accepts values such as scientific notation and `Infinity`. JPY fractions and excess decimal precision are silently truncated, while quoting and liquidity calculations use JavaScript `Number`, which cannot safely represent all financial values.

Relevant code:

- `app/api/payments/route.ts`
- `lib/assets.ts`
- `lib/routing.ts`
- `lib/fx.ts`

Recommended remediation:

1. Accept only a strict, canonical decimal string format.
2. Validate currency-specific precision before persisting or quoting an amount.
3. Reject excess precision rather than truncating it.
4. Represent fiat values as integer minor units or a fixed-precision decimal type.
5. Use bigint/fixed-point arithmetic for liquidity, fees, FX, and on-chain conversion.

### P1 — The audit log is not independently tamper-proof

Audit events are written separately from the state changes they describe. The hash-chain implementation has no explicit cross-request serialization or external anchor. Anyone with database write access could rewrite and rehash the audit history.

Relevant code:

- `lib/audit.ts`
- `prisma/schema.prisma`

Recommended remediation:

1. Write each domain change and its audit event atomically in the same transaction.
2. Use an explicit serialization strategy for hash-chain appends.
3. Restrict database write access and use a database appropriate for operational concurrency.
4. Periodically sign or anchor audit-chain roots outside the primary database.
5. Treat the current hash chain as tamper-evident only against unsophisticated or accidental modification, not as immutable evidence.

### P1 — Testnet key custody is unnecessarily broad

The Base Sepolia deployment file retains treasury and entity private keys. Entity wallets grant unlimited token allowances to the settlement contract. Git ignore rules prevent accidental commits, but server or backup compromise would expose these keys.

Relevant code:

- `scripts/deploy-base-sepolia.mjs`
- `lib/chain.ts`

Recommended remediation:

1. Use a managed signer/KMS or hardware-backed signing service for operator and treasury keys.
2. Never retain customer/entity private keys in application-accessible files.
3. Use exact, short-lived approvals rather than unlimited allowances.
4. Separate deployment credentials from runtime credentials.
5. Rotate or revoke all testnet keys and approvals before reusing any environment for broader access.

### P2 — Defensive web controls are absent

The Next configuration has no security headers. API routes lack schema validation, rate limiting, pagination, bounded inputs, and consistent generic error handling. The execute endpoint returns raw internal errors to callers.

Relevant code:

- `next.config.ts`
- `app/api/payments/[id]/execute/route.ts`

Recommended remediation:

1. Add a content security policy and standard security headers.
2. Introduce centralized request schema validation and size limits.
3. Return safe error codes/messages to clients; log detailed errors only on the server.
4. Add rate limits and abuse monitoring.
5. Paginate all collection endpoints and CSV exports.

### P2 — Several paths will degrade with data volume

The balances endpoint performs serial RPC calls for each token and holder. Audit verification reads the entire audit history on every audit-page load. Reconciliation loads all payments into memory and creates a new audit event on every download.

Relevant code:

- `app/api/balances/route.ts`
- `app/api/audit/route.ts`
- `app/api/reconciliation/route.ts`
- `lib/audit.ts`

Recommended remediation:

1. Batch balance reads with multicall or bounded parallelism.
2. Paginate list and export operations; use streaming exports for large reconciliations.
3. Verify audit history incrementally from signed checkpoints.
4. Cache non-sensitive balance and integrity results for a short time.
5. Consider whether a CSV download itself should be an audited event, since high download volume can inflate the chain.

## Additional correctness and design observations

- `POST /api/entities` does not validate roles, wallet addresses, network IDs, corridor structure, or field lengths.
- The entity creation route uses `local-anvil`, which is not part of the current network registry; this can cause an unintended wallet fallback.
- Selecting a non-recommended route does not fully refresh the stored fee breakdown, so displayed gas/bridge-fee details can become inaccurate.
- The current `MockERC20` deliberately allows permissionless minting. This is appropriate only for the stated demo/testnet use case.
- `PaymentSettlement` is centrally controlled by its admin/operator. That may be a valid product choice, but it needs explicit operational controls, monitoring, and key-management policy before real-value use.

## Suggested refactor plan

1. **Identity and policy layer**
   - Introduce authentication, RBAC, tenant scoping, and centralized API authorization.
   - Make audit actors come from authenticated identity.

2. **Payment lifecycle service**
   - Move route handlers to thin adapters over one lifecycle service.
   - Use conditional transitions, execution leases, idempotency keys, and an outbox/job pattern.

3. **Money and quoting module**
   - Create one canonical money type built on fixed precision/bigint.
   - Prohibit `Number` for persisted values, FX computation, and liquidity accounting.

4. **Chain custody boundary**
   - Mark chain/key modules explicitly server-only.
   - Move signing to managed custody and minimize approval scope.

5. **Audit and reconciliation boundary**
   - Atomically persist business event plus audit event.
   - Add signed/anchored checkpoints and a controlled reconciliation export service.

6. **Schema and testing**
   - Use typed enums for statuses, roles, currencies, and risk states.
   - Add tests for authorization, cross-tenant isolation, invalid decimal inputs, duplicate requests, concurrent execution, and post-settlement failures.

## Verification performed

- TypeScript typecheck: passed.
- ESLint: passed.
- Prisma schema validation: passed.
- Offline production dependency audit: no known vulnerabilities reported.
- `npm test`: blocked during global setup by a Prisma schema-engine error before tests run.
- `npm run build`: blocked in this environment because `next/font/google` attempts to fetch Geist fonts from Google. This is also an external build-time network dependency.

## Recommended remediation order

1. Authentication, authorization, tenant isolation, and safe error handling.
2. Atomic/idempotent lifecycle execution and liquidity reservation.
3. Post-settlement compensation and reconciliation design.
4. Fixed-precision monetary model and strict input validation.
5. Key custody and approval minimization.
6. Audit integrity anchoring, security headers, scalability, and test-suite repair.
