# Runbook: deploy SettlementOS to Render

**When:** You need a public URL so a bank can click through a live Base Sepolia
demo. Local chains are not involved — the rail is Base Sepolia (contracts
already adopted); the DB is Postgres on `?schema=settlementos`.

**Not this:** `npm run setup` — that wipes the database and refuses any
non-localhost `DATABASE_URL`. On Render the seed path is `npm run seed:demo`.

**Postgres version pin (16):** the Render database was deliberately created at
Postgres **16** (not Render's default 18) so it matches local
`postgresql@16` and CI's `postgres:16` service. Migrations were authored and
tested against 16. Move all three together or none — do not bump Render alone.
See AGENTS.md "Run & verify".

**Region pin (`oregon`):** `render.yaml` sets `region: oregon` because the
internal database URL only resolves for a service in the same region as
`settlementos-db`. Do not omit the key and rely on Render's default.

---

## 0. Inventory (what the service needs)

| Name | Secret? | Where | What breaks without it |
|---|---|---|---|
| `DATABASE_URL` | **yes** | Env var (`sync: false` in blueprint) | App cannot start / Prisma fails. Must include `?schema=settlementos`. |
| `AUDIT_ANCHOR_KEY` | **yes** | Env var (`sync: false`) | App runs, but `verifyAuditChain()` reports `anchored: false` (weaker INTACT). Required for the demo claim. |
| `DEPLOYER_PRIVATE_KEY` | **yes** | Env var (`sync: false`) | Operator cannot sign escrow/settle/MMF txs (overlay `privateKeyEnv`). |
| Secret File `deployments.base-sepolia.json` | **yes** | Dashboard → Secret Files → `/etc/secrets/deployments.base-sepolia.json` | `loadDeployments()` finds no networks → payments cannot use Base Sepolia; seed creates entities without wallets. **Never commit this file.** |
| `SETTLEMENTOS_CHAIN_DIR` | no | Env (`/etc/secrets`) | Without it, lib/chain still falls back to `/etc/secrets` for overlays; set it explicitly so path resolution matches the blueprint. |
| `BASE_SEPOLIA_RPC_URL` | no (public default) | Env | Falls back to `https://sepolia.base.org`. Flaky public RPC → slow/failed reads. |
| `FORTEL2_SEPOLIA_RPC_URL` | no (Access hostname) | Env (`https://fortel2-write.ente.ltd`) | ForteL2 writes 403 without this + the Access token. Never `VITE_*`. |
| `FORTEL2_SEPOLIA_READ_RPC_URL` | no | Env (`http://fortel2-replica:10000`) | Balance/display reads. Never point at ente.ltd — replica has no Access. Public replica `https://fortel2-replica-rpc.onrender.com` is for the explorer/browser, not this server-side path. |
| `NEXT_PUBLIC_FORTEL2_EXPLORER_URL` | no | Env (`https://settlementos-explorer-ihgo.onrender.com`) | ForteL2 escrow/settle hashes link into the explorer. Inlined at `next build` — a value change needs a rebuild. Empty string disables. |
| `CF_ACCESS_CLIENT_ID` | **yes** | Env var (`sync: false`) | ForteL2 write hostname rejects unauthenticated calls (403 Access HTML). Render only. |
| `CF_ACCESS_CLIENT_SECRET` | **yes** | Env var (`sync: false`) | Pair with `CF_ACCESS_CLIENT_ID`. Never commit; never `VITE_*`. |
| `ADMIN_USERNAME` | **yes** | Env var (`sync: false`) | Password login 500s until set. **Bootstrap only** — seeds `AdminCredential` on the first login after the table is empty; ignored forever after. Cannot finish wiring until after §1.5; see §1.6. |
| `ADMIN_PASSWORD` | **yes** | Env var (`sync: false`) | Pair with `ADMIN_USERNAME`. Initial password only, not the live one. |
| `ADMIN_API_KEY` | **yes** | Env var (`sync: false`) | Read on every successful password login (becomes the `sos_key` cookie). Must be the raw OPERATOR key whose hash is already in `ApiKey`. That key is printed **once** by the first `npm run seed:demo` — do not set this before §1.5. See §1.6. |
| `TRUSTED_PROXY_HOPS` | no | Env (`1`) | Login IP rate-limit may key on a client-spoofable `X-Forwarded-For` entry. |
| `NODE_VERSION` | no | Env (`22.23.1`) | Wrong Node → build/runtime mismatch with local/CI. |

Never commit `.env`, the overlay, a connection string, or any private key.

---

## 1. First-time setup (operator — Dashboard)

Do these in order. Expected output is in italics after each step.

### 1.1 Merge the PR and note the commit SHA

1. Merge `feat/render-deploy` (or the PR that lands this runbook) to `main`.
2. Copy the merge commit SHA (full 40 hex chars), e.g. from
   `git rev-parse origin/main` after fetch.
3. *You will compare this SHA to `RENDER_GIT_COMMIT` after deploy (trap A).*

### 1.2 Create / link the Blueprint

1. Render Dashboard → **New** → **Blueprint**.
2. Connect the `settlementos` GitHub repo; select branch `main`.
3. Confirm Render reads `render.yaml` and proposes service `settlementos`
   (runtime node, plan starter, 1 instance).
4. When prompted for `sync: false` secrets, paste:
   - `DATABASE_URL` — same shared Postgres as chainbank, **with**
     `?schema=settlementos` (schema isolation ≠ credential isolation — see §7).
   - `AUDIT_ANCHOR_KEY` — generate once: `openssl rand -hex 32` (store offline).
   - `DEPLOYER_PRIVATE_KEY` — the Base Sepolia operator key already in local `.env`
     (never paste into chat/logs).
   - `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` — Cloudflare Access
     service token for `fortel2-write` (policy `settlementos`). Never `VITE_*`.
   - `ADMIN_USERNAME` / `ADMIN_PASSWORD` / `ADMIN_API_KEY` — **leave unset**.
     `ADMIN_API_KEY` cannot be set correctly until `npm run seed:demo` has
     printed the OPERATOR key (§1.5). Password login 500s until §1.6.
5. Apply / create. *First build starts. It may fail until the Secret File exists
   — that is OK if the failure is "No deployments found"; continue to 1.3.*

### 1.3 Upload the overlay Secret File

1. Service → **Environment** → **Secret Files** → **Add Secret File**.
2. **Filename** (exact): `deployments.base-sepolia.json`
3. **Contents**: paste the full contents of your local
   `chain/deployments.base-sepolia.json` (the only copy of treasury + entity keys).
4. Save. *Render redeploys. At runtime the file is at
   `/etc/secrets/deployments.base-sepolia.json` (and also the service root for
   non-Docker — the app reads `/etc/secrets` via `SETTLEMENTOS_CHAIN_DIR`).*

### 1.4 Confirm blueprint-declared env vars on the running service

Service → **Environment**. The **names** present must include at least:

```
ADMIN_API_KEY
ADMIN_PASSWORD
ADMIN_USERNAME
AUDIT_ANCHOR_KEY
BASE_SEPOLIA_RPC_URL
CF_ACCESS_CLIENT_ID
CF_ACCESS_CLIENT_SECRET
DATABASE_URL
DEPLOYER_PRIVATE_KEY
FORTEL2_SEPOLIA_RPC_URL
FORTEL2_SEPOLIA_READ_RPC_URL
NEXT_PUBLIC_FORTEL2_EXPLORER_URL
NODE_ENV
NODE_VERSION
SETTLEMENTOS_CHAIN_DIR
TRUSTED_PROXY_HOPS
```

The three `ADMIN_*` **names** are declared in the blueprint (`sync: false`).
Their **values** are set in §1.6, after §1.5 has printed the OPERATOR key —
empty or missing values here are expected until then. On an already-running
service a Blueprint update will not prompt for new `sync: false` keys; add
the names in the Dashboard yourself if they are absent.

Values for secrets must be set (Render shows them as present / locked — do not
screenshot values). Compare **names and non-secret values** to `render.yaml`:

| Blueprint says | Running service must show |
|---|---|
| `NODE_VERSION=22.23.1` | same |
| `SETTLEMENTOS_CHAIN_DIR=/etc/secrets` | same |
| `TRUSTED_PROXY_HOPS=1` | same |
| `BASE_SEPOLIA_RPC_URL=https://sepolia.base.org` | same (or your private RPC) |
| `FORTEL2_SEPOLIA_RPC_URL=https://fortel2-write.ente.ltd` | same |
| `FORTEL2_SEPOLIA_READ_RPC_URL=http://fortel2-replica:10000` | same |
| `NEXT_PUBLIC_FORTEL2_EXPLORER_URL=https://settlementos-explorer-ihgo.onrender.com` | same |
| `numInstances: 1` | Settings → Scaling → 1 |
| `buildCommand: npm ci --include=dev && …` | Settings → Build & Deploy |
| `preDeployCommand: npx prisma migrate deploy` | Settings → Build & Deploy |
| `startCommand: npm start` | Settings → Build & Deploy |
| `healthCheckPath: /api/networks` | Settings → Health Check |

**Silent non-sync (trap A):** repo `render.yaml` has the new build command / env
keys, but the Dashboard still shows an older build command, missing
`SETTLEMENTOS_CHAIN_DIR`, or `numInstances > 1`. Treat the **Dashboard Settings
+ Shell env** as truth; manually edit Settings to match `render.yaml`, or
disconnect/reconnect the Blueprint, then re-run §2.

### 1.5 Seed the remote database (non-destructive)

1. Service → **Shell** (one-off).
2. Run:

```bash
npm run seed:demo
```

3. *Expected:*
   - Banner: non-destructive demo seed; existing entity columns left alone
     unless `--refresh-entities`
   - `Overlays (absolute paths): base-sepolia ← /etc/secrets/deployments.base-sepolia.json`
     (confirm the absolute path is under `/etc/secrets`, not a stray checkout)
   - New entities: `created`; wallets printed as addresses only
   - **NEW API keys** printed once — copy OPERATOR (and others) offline
   - Row counts: `entities: 4`, wallets ≥ 4, `apiKeys` ≥ 6
4. Run **again** (idempotence check):

```bash
npm run seed:demo
```

5. *Expected second run:*
   - Same row counts; `payments` / `auditEvents` unchanged (not wiped)
   - Each entity: `already present, unchanged` — **entity columns are not
     rewritten** (KYB / `mmfOptIn` / risk stay whatever the operator set)
   - Wallets for networks in the overlay are still registered (upsert); missing
     API keys would still be minted — but on a clean second run keys say
     `already present` and **no new raw keys are printed**

Default re-runs are safe for operator-edited entity columns. To force the seed
values back onto existing rows, pass the explicit override:

```bash
node scripts/seed-demo.mjs --refresh-entities
```

That flag prints every entity and column it is about to overwrite before writing.

If you see a setup wipe message, you ran the wrong command — stop. Only
`npm run setup` wipes, and it must refuse this host.

### 1.6 Wire admin password login (ordering is load-bearing)

This extends §1.2 / §1.4 (Dashboard secrets) and §1.5 (the print-once
OPERATOR key). It is its own subsection because `ADMIN_API_KEY` has a
gotcha nothing else in this document has: the raw key is shown **once**,
on the first `seed:demo` that creates the OPERATOR `ApiKey` row, and is
never written to a Secret File or any retrievable store.

`ADMIN_USERNAME` and `ADMIN_PASSWORD` matter **once** — they seed the
single `AdminCredential` row on the first login after that table exists
with no row, and are ignored forever after ([AD1](../admin-auth-plan.md)).
`ADMIN_API_KEY` is different: it is read on **every** successful password
login and becomes the `sos_key` cookie. It must be a raw key whose hash
is already in `ApiKey` as role OPERATOR.

**Ordering dependency:** `ADMIN_API_KEY` cannot be set correctly before
§1.5 has run at least once. Setting it earlier can only be a guess; a
wrong or empty value makes every password login 500 even when the
username and password are right.

Do these in order. Expected output is in italics after each step.

1. Deploy the service (Blueprint apply / merge to `main`). *Build
   succeeds and the app is up. `POST /api/auth/session` returns 500
   `admin session is not configured` — expected; the three secrets are
   not live yet. If Blueprint create prompted for `ADMIN_*`, they were
   left unset in §1.2. The `AdminCredential` table already exists
   (`preDeployCommand` applied the migration); it is empty.*

2. Run `npm run seed:demo` in the Render Shell exactly as §1.5, and
   **capture the printed OPERATOR key from that run's output**. *On a
   first run that mints the key, the banner says `NEW API keys (save
   these — they are not stored in the DB and will not be re-printed)`
   and prints `OPERATOR  sos_…`. Copy that raw value offline
   immediately. A re-run that finds the OPERATOR row already there
   prints `OPERATOR key: already present` (`op.created && op.raw` in
   `scripts/seed-demo.mjs`) and shows nothing. There is no recovery
   path for a missed print — rotating means creating a new OPERATOR
   `ApiKey` out of band (see §7), not re-running seed. If this service
   was seeded before admin login existed, §1.5 already ran: do not
   re-run seed hoping to see the key. Use the OPERATOR value saved
   from that earlier run (the same key pasted at `/login`).*

3. Service → **Environment** → add (or fill) the three `sync: false`
   secrets. Values are never committed; do not paste them into chat or
   logs.
   - `ADMIN_USERNAME` — operator's choice (trimmed at seed; do not pad).
   - `ADMIN_PASSWORD` — operator's choice. This is the **initial**
     password only.
   - `ADMIN_API_KEY` — the raw OPERATOR key captured in step 2, verbatim.
   *Dashboard shows the three names as present / locked.*

   On an already-running service a Blueprint update will **not** prompt
   for new `sync: false` keys (Render ignores them on update so it
   cannot blank existing secrets). Add the names in the Dashboard
   yourself if they are missing.

4. **Manual Deploy** or restart so the new env vars are in the running
   process. *§2.2's name check now reports `ADMIN_USERNAME`,
   `ADMIN_PASSWORD`, and `ADMIN_API_KEY` as `set(len=…)`, not `MISSING`.*

5. First login attempt: `POST /api/auth/session` with the username and
   password from step 3 (or sign in at `/login`). *This attempt seeds
   the `AdminCredential` row from env. Get username and password right
   — after this, env is ignored ([AD1](../admin-auth-plan.md)). A padded
   or wrong seed is permanent until the row is deleted by hand (below).*

**Working:** `POST /api/auth/session` with the chosen credentials
returns **200** (and sets the `sos_key` cookie), not 500 and not 401.

**500 vs 401 — do not treat these as one "login is broken" bucket.**
The route distinguishes them on purpose
([`app/api/auth/session/route.ts`](../../app/api/auth/session/route.ts)):

| Status | Body | What it means |
|---|---|---|
| **500** | `admin session is not configured` | `ADMIN_API_KEY` is unset, or it does not resolve to an OPERATOR principal (wrong key, a REVIEWER/ENTITY key, or the hash is not in `ApiKey`). Also the expected state before step 3, when username/password are unset and no credential row exists yet. |
| **401** | `invalid credentials` | A credential row **exists** and the submitted username/password do not match it. Changing `ADMIN_USERNAME` / `ADMIN_PASSWORD` in the Dashboard will not fix this ([AD1](../admin-auth-plan.md)). |

**Replace the admin credential** (wrong username seeded, or starting
fresh on a redeployed database): there is no UI and no script. Delete
the `AdminCredential` row directly against the Render database (one
row, id `admin`), then repeat step 5 so the next login re-seeds from
the current `ADMIN_USERNAME` / `ADMIN_PASSWORD`. Do not change those
env vars and expect the running password to follow.

A password change at `/admin/password` does **not** evict existing
sessions ([AD4](../admin-auth-plan.md)): the cookie holds
`ADMIN_API_KEY`, not a password-derived token. Evicting sessions means
rotating `ADMIN_API_KEY` (the env value **and** the corresponding
`ApiKey` row), not changing the password.

---

## 2. Post-deploy verification (trap A — do not skip)

Run from the **Render Shell** of the live service (not your laptop). These
commands print **names / SHAs / statuses**, never secret values.

### 2.1 Commit SHA the service built from

```bash
echo "RENDER_GIT_COMMIT=${RENDER_GIT_COMMIT:-<unset>}"
echo "RENDER_GIT_BRANCH=${RENDER_GIT_BRANCH:-<unset>}"
node -e 'console.log(process.version)'
```

*Compare `RENDER_GIT_COMMIT` to the merge SHA from §1.1. Mismatch ⇒ Blueprint /
auto-deploy did not pick up the commit you think is live (or you are on a
preview). Redeploy that SHA explicitly.*

*Compare `node` to `v22.23.1`. Mismatch ⇒ `NODE_VERSION` / `.node-version` did
not apply — set `NODE_VERSION=22.23.1` in Dashboard and redeploy.*

### 2.2 Env var names (not values)

```bash
node -e '
const need = [
  "DATABASE_URL","AUDIT_ANCHOR_KEY","DEPLOYER_PRIVATE_KEY",
  "SETTLEMENTOS_CHAIN_DIR","BASE_SEPOLIA_RPC_URL","TRUSTED_PROXY_HOPS",
  "NODE_VERSION","NODE_ENV",
  "FORTEL2_SEPOLIA_RPC_URL","FORTEL2_SEPOLIA_READ_RPC_URL",
  "NEXT_PUBLIC_FORTEL2_EXPLORER_URL",
  "CF_ACCESS_CLIENT_ID","CF_ACCESS_CLIENT_SECRET",
  "ADMIN_USERNAME","ADMIN_PASSWORD","ADMIN_API_KEY"
];
for (const k of need) {
  const v = process.env[k];
  console.log(k + "=" + (v === undefined ? "MISSING" : "set(len="+v.length+")"));
}
console.log("SETTLEMENTOS_CHAIN_DIR_value=" + (process.env.SETTLEMENTOS_CHAIN_DIR || "<unset>"));
console.log("TRUSTED_PROXY_HOPS_value=" + (process.env.TRUSTED_PROXY_HOPS || "<unset>"));
console.log("NODE_VERSION_value=" + (process.env.NODE_VERSION || "<unset>"));
console.log("FORTEL2_SEPOLIA_RPC_URL_value=" + (process.env.FORTEL2_SEPOLIA_RPC_URL || "<unset>"));
console.log("FORTEL2_SEPOLIA_READ_RPC_URL_value=" + (process.env.FORTEL2_SEPOLIA_READ_RPC_URL || "<unset>"));
console.log("NEXT_PUBLIC_FORTEL2_EXPLORER_URL_value=" + (process.env.NEXT_PUBLIC_FORTEL2_EXPLORER_URL || "<unset>"));
'
```

*Every secret line must be `set(len=…)` not `MISSING`. Non-secret values must
match `render.yaml`. `ADMIN_USERNAME` / `ADMIN_PASSWORD` / `ADMIN_API_KEY`
MISSING is expected until §1.6 is done — after that, all three must be
`set`. A Blueprint that failed to sync often leaves
`SETTLEMENTOS_CHAIN_DIR` MISSING while the Secret File still exists — the app
can still find the overlay via the `/etc/secrets` fallback, but treat the
missing env as proof the blueprint did not fully apply and fix Settings.*

### 2.3 Overlay file on disk + loadDeployments

```bash
ls -la /etc/secrets/deployments.base-sepolia.json
node -e '
const fs = require("fs");
const p = "/etc/secrets/deployments.base-sepolia.json";
const j = JSON.parse(fs.readFileSync(p, "utf8"));
const n = j.networks["base-sepolia"];
if (!n) throw new Error("no base-sepolia network in overlay");
console.log("overlay_ok chainId=" + n.chainId);
console.log("has_PaymentSettlement=" + !!n.contracts?.PaymentSettlement);
console.log("has_TokenizedMMF=" + !!n.contracts?.TokenizedMMF);
console.log("entity_wallet_count=" + Object.keys(n.accounts?.entityWallets || {}).length);
console.log("operator_uses_env=" + (n.accounts?.operator?.privateKeyEnv || "<none>"));
// Never print privateKey fields.
'
```

Then from the app process path (same Shell, project root):

```bash
node -e '
process.env.SETTLEMENTOS_CHAIN_DIR = process.env.SETTLEMENTOS_CHAIN_DIR || "/etc/secrets";
// Dynamic import of compiled path is awkward in Shell; probe the same files
// loadDeployments reads:
const fs = require("fs");
const path = require("path");
const dir = process.env.SETTLEMENTOS_CHAIN_DIR;
const p = path.join(dir, "deployments.base-sepolia.json");
console.log("load_path=" + p + " exists=" + fs.existsSync(p));
'
curl -sS "$RENDER_EXTERNAL_URL/api/networks" | node -e '
let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{
  const j=JSON.parse(s);
  const base=(j.networks||[]).find(n=>n.id==="base-sepolia");
  if(!base) { console.error("base-sepolia missing from /api/networks"); process.exit(1); }
  console.log("base-sepolia available=" + base.available + " chain_id=" + base.chain_id);
  if(!base.available) process.exit(2);
});
'
```

*Expected: `available=true`, `chain_id=84532`. If `available=false`, the running
app did not see the overlay — check Secret File filename and
`SETTLEMENTOS_CHAIN_DIR`.*

### 2.4 Migration state + pre-deploy actually ran

`render.yaml` sets `plan: starter` (paid), so `preDeployCommand` is supported
(it is unavailable only on free instances). Confirm both the Settings field
**and** that the last deploy's logs show the pre-deploy step.

```bash
npx prisma migrate status
```

*Expected: all migrations listed as applied (currently
`20260811004754_init_postgres`). Drift or "pending" ⇒ `preDeployCommand` did
not run — confirm Settings shows `npx prisma migrate deploy`, then Manual Deploy.*

In the deploy event log, find a pre-deploy / "running pre-deploy command" line
with `prisma migrate deploy` succeeding ("No pending migrations" or applied).
**Missing pre-deploy in the log while Settings still shows the command is the
same blueprint-drift class as a wrong build command** — fix Settings or
re-link the Blueprint, then redeploy.

### 2.5 Security headers (from your laptop against the public URL)

```bash
curl -sSI "https://<your-service>.onrender.com/" | grep -iE \
  'content-security-policy|x-content-type-options|x-frame-options|referrer-policy|permissions-policy'
```

*Expected headers (values from `next.config.ts` — do not change them here):*

| Header | Must include |
|---|---|
| `Content-Security-Policy` | `default-src 'self'`; `script-src 'self' 'unsafe-inline'` (deliberate for App Router hydration); `frame-ancestors 'none'` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=()` |

A route test does **not** exercise these — only a running server does.

### 2.6 Audit anchoring

Sign in with the OPERATOR key from seed, open the audit / integrity UI (or
`GET /api/audit` with `x-api-key`), and confirm the integrity payload shows
`anchored: true` (not merely `INTACT` with `anchored: false`).

---

## 3. Redeploy

1. Push / merge to `main` (or Manual Deploy → **Deploy latest commit**).
2. Watch build logs for:
   - `npm ci --include=dev`
   - `prisma generate`
   - `next build` success
   - pre-deploy: `prisma migrate deploy` → "No pending migrations" or applied
3. Re-run §2.1–2.3 (SHA, env names, `/api/networks`) and §2.4 (migrate status +
   pre-deploy log line).
4. Re-running `seed:demo` after a deploy is optional. The default path is
   **create-only for entity columns** — it will not revert operator KYB / MMF
   opt-in decisions. Re-run when you need wallets from a newly uploaded overlay
   or missing API keys. Use `--refresh-entities` only when you intentionally
   want seed values written back onto existing entity rows.

---

## 4. Rollback

1. Render → service → **Deploys** → select last known-good deploy → **Rollback**.
2. *Expected: previous build image/commit becomes live; `RENDER_GIT_COMMIT`
   matches that older SHA.*
3. Migrations: Prisma migrations are **forward-only** in this project. Rolling
   back the app does not un-apply SQL. If a bad migration shipped, fix forward
   with a new migration — do not `migrate reset` on the shared DB.
4. Overlay / secrets are independent of deploys — rolling back code does not
   remove Secret Files or env vars.

---

## 5. Healthy demo smoke (Base Sepolia — slow is correct)

1. Open `https://<service>.onrender.com/login`. Sign in with the
   username/password from §1.6 (or paste the OPERATOR key — API-key
   login still works).
2. Create payment: ACME US → Tokyo Trading, `100000.00` USD→JPY (or a smaller
   amount you have liquidity for), **source and dest = Base Sepolia**.
3. Quote → Execute. *Expect 8–10 seconds* (~2s blocks). Do not assume local
   instant mining; do not add client timeouts that abort early.
4. Status reaches `SETTLED` with Basescan links on escrow/settle hashes.
5. Audit chain INTACT and `anchored: true`.

---

## 6. Accepted characteristics (do not "fix" in a panic)

### Per-instance rate limiting

`lib/rate-limit.ts` is an in-memory sliding window **per process**. Behind more
than one instance the limit becomes per-instance. **Accepted** for this demo —
keep `numInstances: 1`. Do not add Redis here.

### Schema isolation ≠ credential isolation

Tables live in `settlementos.*`; chainbank's in `public.*`. That prevents
name collisions, not access. A peer app with the same DB role can still
`SELECT` our schema. Residual risk — do not re-role the shared Render database
as part of this deploy.

### Synchronous execution

Payment execute is synchronous end-to-end. Base Sepolia latency is expected.

---

## 7. Confusing setup with seed (do not)

| | `npm run setup` | `npm run seed:demo` |
|---|---|---|
| Purpose | Local wipe + chain redeploy + seed | Remote/shared upsert seed |
| Deletes rows? | **Yes** (payments, audit, entities, …) | **Never** |
| Host guard | Refuses non-localhost | Requires `?schema=settlementos` only |
| When | Local reset button | Render first-time + re-sync wallets |

If you ever need to rotate API keys on Render: create new `ApiKey` rows out of
band or extend the seed deliberately — this script will not delete or replace
existing keys (idempotent keep).

---

## 8. Blueprint ↔ reality checklist (print and tick)

After every production deploy:

- [ ] `RENDER_GIT_COMMIT` == intended `main` SHA
- [ ] `node -v` == `v22.23.1`
- [ ] Env **names** match §0 / `render.yaml` (secrets `set`, not `MISSING`)
- [ ] `ADMIN_*` set per §1.6; `POST /api/auth/session` returns 200 (not 500 / 401)
- [ ] `SETTLEMENTOS_CHAIN_DIR` value is `/etc/secrets`
- [ ] `/etc/secrets/deployments.base-sepolia.json` exists; `/api/networks` → base-sepolia `available: true`
- [ ] `npx prisma migrate status` → all applied
- [ ] Security headers present via `curl -sSI`
- [ ] Audit `anchored: true`
- [ ] Scaling still **1 instance**
