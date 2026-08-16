# Admin login + admin pages — worker-ready plan (A1–A5)

Prepared 2026-08-15. Structure mirrors [`tasks/fortel2-worker-plan.md`](fortel2-worker-plan.md)
and [`tasks/hosting-worker-plan.md`](hosting-worker-plan.md): verified state, task
tree with model/order, file ownership, the commit contract, decisions.

**The ask.** Sign in to the SettlementOS UI with a username and password instead of
pasting an API key, and add admin pages that change the password and show the mock
coins and the wallets. One login grants full (OPERATOR) access; finer authorization
is a later phase and is deliberately **not** designed here.

**This touches an authorization boundary.** Password auth is the one surface where a
plausible-looking mistake hands over the whole system, so §5 and §6 carry more weight
than usual for a UI task. Read both before dispatching.

---

## 0. Verified state (checked 2026-08-15 against `origin/main`)

| Claim | State | Evidence |
|---|---|---|
| Identity is API-key only | **True** | `lib/auth.ts` — raw key → sha256 → `ApiKey` row → `Principal`. No user or password model anywhere in `prisma/schema.prisma` |
| The browser session already exists | **True** | `POST /api/auth/login` sets the httpOnly `sos_key` cookie (`app/api/auth/login/route.ts`); `currentPrincipal()` reads it for server components (`lib/session.ts`) |
| That login endpoint is already rate-limited by address | **True** | `beginWrite(req, null)` → `rateLimitKey()` IP fallback; it is the only principal-less write, by design |
| Cookie flags are already right | **True** | `sessionCookieOptions()` — httpOnly, sameSite lax, secure in production, 7-day max age |
| Balances for coins **and** wallets already exist server-side | **True** | `GET /api/balances` returns treasury + per-entity balances per network per token, gated to OPERATOR/REVIEWER, degrading to a per-network `error` string on RPC failure |
| Contract addresses are already resolvable | **True** | `loadDeployments()` / `networkContracts(networkId)` in `lib/chain.ts`; `mmfAddress()` returns `undefined` where no fund is deployed |
| Pages gate themselves | **True, and an invariant** | AGENTS.md — a server component reads Prisma directly with no `Request`, so tenant/role gating lives in the page (`currentPrincipal()` + `<AuthRequired>`), not in a shared route guard |
| No `/admin` route exists | **True** | `app/` holds api, compliance, docs, entities, liquidity, login, payments |

**Reuse, not rebuild.** A3 and A4 are largely a UI over `GET /api/balances` plus
deployment metadata. Anyone writing fresh chain reads for them has taken a wrong turn.

---

## 1. Task tree

```
A1  password login + admin shell        [strongest · first, blocks A2]
 ├─ A2  change-password page            [strong · after A1]
 ├─ A3  admin: mock coins               [cheap · parallel with A1]
 └─ A4  admin: wallets                  [strong · parallel with A1]
A5  seed + deploy wiring (env, secret file, runbook)   [cheap · after A1]
```

| ID | Owns | Model / order | Notes |
|---|---|---|---|
| **A1** | credential model, verify, session exchange, `/login` form, `/admin` shell | strongest · first | **DONE** — PR [#77](https://github.com/StephenForte/settlementos/pull/77), merged 2026-08-15. **AD1, AD2, AD3** resolved; AD3 took option 1 (`ADMIN_API_KEY` in env) |
| **A2** | change-password page + route | strong · after A1 | **Reviewed, approved** — PR [#78](https://github.com/StephenForte/settlementos/pull/78). **AD4 resolved: ACCEPT** |
| **A3** | `/admin/coins` | cheap · parallel | Read-only view over existing data |
| **A4** | `/admin/wallets` | strong · parallel | Cheap-looking, but §6 trap 1 lives here |
| **A5** | `.env.example`, `render.yaml`, runbook | cheap · after A1 | No app code |

A3 and A4 need only the existing OPERATOR gate, so they do **not** wait for A1 —
they mount under `/admin` once A1's shell lands, and until then they are reachable
at their own routes. If A3/A4 run before A1 merges, they gate with
`currentPrincipal()` + `isPlatformRole` directly, exactly as `/liquidity` does today.

---

## 2. File ownership

| File / area | Owner | Notes |
|---|---|---|
| `prisma/schema.prisma` | **A1 only** | One new model. A migration, not just `db push` — see §6 trap 4 |
| `lib/admin-auth.ts` (new) | A1 | Credential verify + seed. Framework-free, like `lib/auth.ts` |
| `app/api/auth/session/route.ts` (new) | A1 | The password → cookie exchange |
| `app/api/auth/login/route.ts` | **A1 only** | Existing API-key exchange — **leave working**, see AD4 |
| `app/login/page.tsx` | A1 | |
| `app/admin/layout.tsx`, `app/admin/page.tsx` | A1 | The shell + OPERATOR gate every admin page inherits |
| `app/admin/password/`, `app/api/admin/password/route.ts` | A2 | |
| `app/admin/coins/` | A3 | |
| `app/admin/wallets/` | A4 | |
| `lib/auth.ts`, `lib/session.ts` | **nobody** | Do not modify. A1 adds a *parallel* credential path; it must not alter how a principal is resolved, or every route, page, test and the MCP server inherit the change |
| `.env.example`, `render.yaml`, `tasks/runbooks/render-deploy.md` | A5 | |
| this plan | **planner only** | |

**Hot zone:** `app/admin/layout.tsx` is created by A1 and imported by A2–A4. If A3/A4
start before A1 merges they must not create it — they render their own page-level gate
and A1's shell absorbs them. Two tasks creating the same layout is the one collision
this plan expects.

---

## 3. Commit and merge contract

*Include verbatim in every worker prompt.*

- **Branch:** `feat/<task-slug>` from `origin/main` at the moment you start.
- **Allowed to touch:** exactly your ownership row. Anything else, stop and say so.
- **Never touch:** `lib/auth.ts`, `lib/session.ts`, `app/api/mcp/`, `chain/`, `.env`.
- **Gate — all four:**
  ```
  npx tsc --noEmit && npm run lint && npm test && npm run build
  ```
  Baseline at time of writing: **594 passed / 64 files**. Report before → after.
- **Never push to `main`.** PR only. You open it; you do not merge it.

Handback report as in the other plans, plus for A1/A2 a **SECURITY NOTES** field:
what an attacker gets from a stolen cookie, a leaked DB dump, and 10,000 login
attempts.

---

## 4. Integration order

```
A1 ──▶ A2
A3, A4 ──┐ (independent; merge order irrelevant)
A5 ──────┴─▶ after A1
```

---

## 5. Decisions

Append-only. Pre-assigned: **AD1–AD3** → A1, **AD4** → A2 (optional).

### AD1 — the credential lives in the database, seeded from env

*Pre-assigned to A1. Decided by the planner; the worker implements it.*

The request said the secret would live in `.env` locally and a Render Secret File in
production. That is right for a **fixed** secret and wrong here, because A2 changes the
password from a web page and an app cannot rewrite a Render Secret File. So:

- A new table holds `username` + a password **hash** + `updatedAt`. One row.
- `ADMIN_USERNAME` and `ADMIN_PASSWORD` in env are the **bootstrap**: on first boot, if
  no row exists, seed it from them. If a row exists, env is ignored — otherwise a
  changed password silently reverts on the next deploy, which is worse than not
  supporting change at all.
- Env therefore holds the *initial* password, not the current one. Say so in
  `.env.example`, or the next operator will change it there and wonder why nothing
  happened.

### AD2 — password hashing is `scrypt`, never `hashKey()`

*Pre-assigned to A1.*

`lib/auth.ts` hashes API keys with a bare sha256, and that is **correct for API keys**:
they are 192 bits of `randomBytes`, so there is no dictionary to run and no preimage an
attacker can steer. A password is none of those things. Reusing `hashKey()` here — the
obvious move, since it is right there and already imported — would make a stolen
database dump trivially crackable.

Use `scrypt` from `node:crypto` with a per-row random salt. No new dependency, and the
project's minimal-dependency posture is worth keeping on the one path where a supply
chain compromise is worst. Compare with `timingSafeEqual`, never `===`.

### AD3 — a password session mints the same `sos_key` cookie

*Pre-assigned to A1. The recommendation, with the fork stated.*

The value of this design is that **nothing downstream changes**. `authenticate()`,
`currentPrincipal()`, every route guard, tenant scoping, and the MCP server all keep
resolving a principal from `sos_key` exactly as today. A successful password login
looks up an OPERATOR `ApiKey` and sets that cookie.

Which key? Two options, and the worker picks:

1. **Env-provided raw key** (`ADMIN_API_KEY` in `.env` / Render Secret File) — matches
   what was asked for, and the raw key never has to be stored, since only its hash is
   in the DB. Cost: a reseed (`npm run setup`) invalidates it and the env must be
   updated in lockstep.
2. **A dedicated `ApiKey` row** minted at seed time and looked up by label. Survives a
   reseed. Cost: the raw key must be stored somewhere to be settable as a cookie, which
   reintroduces exactly the storage problem the sha256-only design avoids.

**Recommendation: option 1.** It keeps "only hashes in the DB" true, which is a stated
invariant, and the reseed coupling is a documented operational step rather than a
security property. Write AD3 either way.

The alternative shape — a second cookie and a second identity path — is **rejected**,
not deferred: two ways to become a principal is how one of them ends up not getting a
fix. The MCP gotcha in AGENTS.md ("MCP is not a second identity path") is the same rule.

### AD4 — a password change does NOT evict live sessions (ACCEPTED)

*Resolved by A2, 2026-08-15. Verified by the reviewer, not merely accepted.*

The `sos_key` cookie holds the `ADMIN_API_KEY` raw key, not a password-derived
token, so updating the password hash cannot invalidate a session that already
exists. Real eviction would mean rewriting the env / Render Secret File value,
which the app cannot do, or minting a new `ApiKey` row — which would reintroduce
storing a raw key and break AD3's "only hashes in the DB".

**Accepted:** the password gates **new logins only**. An existing session stays
valid for the remainder of its 7-day `maxAge`. The change-password page, its form,
its success message, and the admin index all say so — the option this decision
rules out is leaving it undocumented, not leaving it unfixed.

**Measured, 2026-08-15:** a cookie minted before a password change still resolves
to an OPERATOR principal after it. The accepted risk is a tested fact rather than
an assumption with a decision number attached.

**Consequence for a real deployment:** evicting sessions means rotating
`ADMIN_API_KEY` — the env value *and* the corresponding `ApiKey` row — not calling
this endpoint. Anyone treating "change the password" as an incident-response
containment step should read that sentence twice.

---

## 5a. Verification record

What was checked and how, so a later reader does not have to re-derive it.

### A1 — PR #77, merged 2026-08-15
Gate re-run in an isolated clone: **606 → 612 passed**. Migration re-proven forward
on populated data (seeded an `Entity`, applied `20260815000000_admin_credential`,
row survived). Probes: an ENTITY or REVIEWER `ADMIN_API_KEY` cannot be minted into a
session (500, no cookie); env does not override an existing credential row; an empty
`ADMIN_PASSWORD` seeds nothing. Mutations confirmed each probe bites.

**One finding recorded rather than fixed:** the empty-password protection is enforced
in the *route*, not in `lib/admin-auth.ts` — removing the lib-level guard changes no
behaviour. Two guards exist; only the route's is load-bearing for authentication.

**Bugbot finding (username seed/login trim mismatch) — real, reproduced, fixed in
`ff13d8b`.** A padded `ADMIN_USERNAME` seeded a username no submitted string could
match (the route trims, so neither the padded nor the trimmed form authenticated),
and AD1 made it permanent. Worse than reported: `ensureAdminCredential()` runs before
verification, so *any* login attempt — including a stranger's failed one — writes the
bad row. Fix trims at the seed boundary only; a row already written padded stays
unreachable and recovery is deleting it (now documented in `.env.example`).

### A2 — PR #78, reviewed 2026-08-15
Gate re-run: **612 → 620 passed**. Probes: a session minted before a password change
still authenticates after it (AD4, above); the audit chain stays `valid` with the new
`admin.password_changed` action and neither password appears in the event; a wrong
`current_password` leaves hash and salt byte-identical; REVIEWER, ENTITY and anonymous
callers are all refused with the row untouched.

**Atomicity proven, not accepted:** a throw injected inside the `$transaction` after
the audit call rolled the password change back — 500, hash and salt unchanged.

**Better than specified:** the route reads with `findUnique({ id: ADMIN_CREDENTIAL_ID })`
as well as writing by it, so a read cannot find one row while the write targets another.

**Open divergence (fail-closed, not urgent):** `lib/admin-auth.ts` locates the row with
`findFirst()` (any id) while the A2 route uses `findUnique({ id: "admin" })`. A row under
a different id would authenticate at login but 500 on password change. Collapse to one
accessor when that file is next open.

## 6. Standing traps

1. **`accountsFor(networkId)` returns signing material.** The overlay stores the
   treasury as an inline `privateKey` on some networks. A wallets page that spreads
   that object into props ships a private key to the browser. **Select `.address`
   explicitly, field by field** — never pass the accounts object, never `JSON.stringify`
   it into a prop, and never `console.log` it in a server component. `server-only`
   does **not** save you here: the leak is a server component serialising a value into
   client props, which is exactly what that marker permits.
2. **Do not weaken the login rate limit.** `POST /api/auth/login` is address-keyed
   because it has no principal yet, and the address is read per `TRUSTED_PROXY_HOPS`
   from the *right* of `x-forwarded-for` — the leftmost entry is attacker-controlled
   (AGENTS.md gotcha). A password endpoint is a brute-force target in a way an API-key
   endpoint is not, so the new route reuses the same limiter and the same key function.
3. **The login error must stay generic and identical.** Unknown username, wrong
   password, and malformed body all answer the same 401. The existing route's comment
   explains why for keys; it is more important for usernames, which are guessable.
4. **There is no migrations directory habit here — but there is a migrations path.**
   Local dev syncs with `prisma db push` inside `npm run setup`; the deployed path is
   `npm run db:deploy` (`prisma migrate deploy`), and `prisma/migrations/` exists with
   the Postgres init. A new model needs a **migration**, or Render deploys will not
   have the table. Do not rely on `db push` alone.
5. **Seeded API keys are printed once and never recoverable.** If the operator key is
   the session key (AD3 option 1), an operator who loses it re-runs `npm run setup` —
   which **wipes the database**. Make the failure mode a clear error message, not a
   silent 401 loop.
6. **`GET /api/balances` returns 503 with instructions when chains are not up.** That
   is deliberate operator UX, not an error to swallow. Admin pages surface it as-is.
