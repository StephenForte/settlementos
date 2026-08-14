import "server-only";

import { ASSETS, fromBaseUnits, type AssetSymbol } from "../assets";
import { verifyAuditChain } from "../audit";
import { isPlatformRole, type Principal } from "../auth";
import { ApiError } from "../api-errors";
import { accountsFor, isChainReady, loadDeployments, tokenBalance } from "../chain";
import { prisma } from "../db";
import { NETWORKS } from "../networks";
import { toPage } from "../pagination";
import { paymentScopeWhere } from "../session";
import { currentIndexOf, positionDerivedValue } from "../treasury";
import { walletOnNetwork } from "../wallets";
import { scrubAuditDetail, scrubFailureReason } from "../../app/api/guard";
import { ChainUnavailableError } from "./errors";
import { pageFromArgs } from "./page";

function requirePlatform(principal: Principal): void {
  if (!isPlatformRole(principal)) throw new ApiError("forbidden");
}

/**
 * A tenant's cursor must resolve inside its own scope: Prisma positions a cursor
 * by id regardless of `where`, so without this a foreign id would page while a
 * nonexistent one returned empty — the existence oracle the 404-not-403 rule
 * exists to deny. Callers must combine the id and the scope with `AND`, not a
 * spread: a scope keyed on `id` (entities) would otherwise overwrite the cursor.
 */
async function assertTenantCursor(
  principal: Principal,
  cursor: string | null,
  findInScope: (id: string) => Promise<{ id: string } | null>
): Promise<void> {
  if (cursor === null || isPlatformRole(principal)) return;
  const inScope = await findInScope(cursor);
  if (!inScope) throw new ApiError("invalid_request", "cursor is not valid");
}

/** Registry networks with deployment availability. Any authenticated principal. */
export async function listNetworks() {
  const deployed = isChainReady() ? new Set(Object.keys(loadDeployments().networks)) : new Set<string>();
  return {
    networks: Object.values(NETWORKS).map((n) => ({
      id: n.id,
      label: n.label,
      chain_id: n.chainId,
      live: !!n.live,
      explorer_url: n.explorerUrl ?? null,
      available: deployed.has(n.id),
    })),
  };
}

/**
 * Payments the principal may see. Tenant scoping is the Prisma `where`, never a
 * post-filter — the same filter GET /api/payments uses (and paymentScopeWhere).
 */
export async function listPayments(principal: Principal, args: { limit?: number; cursor?: string } = {}) {
  const page = pageFromArgs(args);
  const scope = paymentScopeWhere(principal);

  await assertTenantCursor(principal, page.cursor, (id) =>
    prisma.payment.findFirst({ where: { id, ...scope }, select: { id: true } })
  );

  const rows = await prisma.payment.findMany({
    where: scope,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: { sender: true, recipient: true },
    take: page.limit + 1,
    ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
  });

  const { rows: payments, nextCursor, hasMore } = toPage(rows, page.limit, (p) => p.id);
  return {
    payments: payments.map((p) => scrubFailureReason(principal, p)),
    next_cursor: nextCursor,
    has_more: hasMore,
  };
}

/**
 * One payment. The id is part of the `where` together with the tenant scope, so
 * a foreign id and a missing id are the same not-found — never forbidden.
 */
export async function getPayment(principal: Principal, args: { payment_id: string }) {
  const payment = await prisma.payment.findFirst({
    where: { id: args.payment_id, ...paymentScopeWhere(principal) },
    include: {
      sender: { include: { wallets: true } },
      recipient: { include: { wallets: true } },
      complianceChecks: { orderBy: { createdAt: "asc" as const } },
      auditEvents: { orderBy: { id: "asc" as const } },
      ledgerCredits: true,
      reservation: true,
    },
  });
  if (!payment) throw new ApiError("not_found");
  const scrubbed = scrubFailureReason(principal, payment);
  return {
    payment: { ...scrubbed, auditEvents: scrubAuditDetail(principal, scrubbed.auditEvents) },
  };
}

/** Entities the principal may see. Tenant `where` is `{ id: entityId }`. */
export async function listEntities(principal: Principal, args: { limit?: number; cursor?: string } = {}) {
  const page = pageFromArgs(args);
  const scope = isPlatformRole(principal) ? {} : { id: principal.entityId };

  await assertTenantCursor(principal, page.cursor, (id) =>
    // AND, not a spread: the entity scope is `{ id: entityId }`, the one scope
    // whose key collides with the cursor's own `id`. `{ id, ...scope }` would
    // overwrite the cursor and always look up the caller's own row.
    prisma.entity.findFirst({ where: { AND: [{ id }, scope] }, select: { id: true } })
  );

  const rows = await prisma.entity.findMany({
    where: scope,
    include: { wallets: true, ledgerCredits: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: page.limit + 1,
    ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
  });
  const { rows: entities, nextCursor, hasMore } = toPage(rows, page.limit, (e) => e.id);
  return { entities, next_cursor: nextCursor, has_more: hasMore };
}

/** Parked MMF positions. Platform treasury, not a tenant's funds. */
export async function listTreasuryPositions(
  principal: Principal,
  args: { limit?: number; cursor?: string } = {}
) {
  requirePlatform(principal);
  const page = pageFromArgs(args);

  const pageRows = await prisma.treasuryPosition.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: page.limit + 1,
    ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
  });
  const { rows: positions, nextCursor, hasMore } = toPage(pageRows, page.limit, (p) => p.id);

  const networks = [...new Set(positions.filter((p) => p.status === "ACTIVE").map((p) => p.network))];
  const indexes = new Map(
    await Promise.all(
      networks.map(async (network) => [network, await currentIndexOf(network).catch(() => null)] as const)
    )
  );

  return {
    positions: positions.map((p) => {
      const decimals = ASSETS[p.asset as AssetSymbol]?.decimals ?? 0;
      const shares = BigInt(p.shares);
      const principalAmount = BigInt(p.assetAmountIn);
      const index = p.status === "ACTIVE" ? (indexes.get(p.network) ?? null) : null;
      const { value, accruedYield } = positionDerivedValue(shares, principalAmount, index);
      return {
        position_id: p.id,
        network: p.network,
        asset: p.asset,
        status: p.status,
        shares: p.shares,
        amount_in: fromBaseUnits(principalAmount, decimals),
        index_at_entry: p.indexAtEntry,
        current_index: index === null ? null : index.toString(),
        current_value: value === null ? null : fromBaseUnits(value, decimals),
        accrued_yield: accruedYield === null ? null : fromBaseUnits(accruedYield, decimals),
        tx_hash_park: p.txHashPark,
        tx_hash_recall: p.txHashRecall,
        created_at: p.createdAt.toISOString(),
        recalled_at: p.recalledAt ? p.recalledAt.toISOString() : null,
      };
    }),
    next_cursor: nextCursor,
    has_more: hasMore,
  };
}

/** Platform-wide treasury + entity balances. Mirrors GET /api/balances. */
export async function getBalances(principal: Principal) {
  requirePlatform(principal);

  if (!isChainReady()) {
    throw new ChainUnavailableError(
      "Chains not set up. Run: npm run chain, npm run chain:polygon, then npm run setup"
    );
  }

  const dep = loadDeployments();
  const entities = await prisma.entity.findMany({ include: { wallets: true } });

  const networks: Record<
    string,
    {
      balances: { label: string; kind: string; address: string; tokens: Record<string, string> }[];
      error?: string;
    }
  > = {};

  for (const [networkId, net] of Object.entries(dep.networks)) {
    const holders: { label: string; kind: string; address: string }[] = [
      { label: "Settlement Treasury", kind: "treasury", address: accountsFor(networkId).treasury.address },
      ...entities.flatMap((e) => {
        const w = walletOnNetwork(e.wallets, networkId);
        return w ? [{ label: e.name, kind: "entity", address: w.address }] : [];
      }),
    ];
    try {
      const balances = await Promise.all(
        holders.map(async (h) => {
          const perToken: Record<string, string> = {};
          for (const [symbol, token] of Object.entries(net.contracts.tokens)) {
            const raw = await tokenBalance(networkId, token.address, h.address as `0x${string}`, {
              viaReadRpc: true,
            });
            perToken[symbol] = fromBaseUnits(raw, token.decimals);
          }
          return { ...h, tokens: perToken };
        })
      );
      networks[networkId] = { balances };
    } catch {
      networks[networkId] = { balances: [], error: `RPC unreachable for ${networkId}` };
    }
  }

  const reservations = await prisma.liquidityReservation.findMany({
    where: { status: "RESERVED" },
  });

  const credits = await prisma.ledgerCredit.findMany({ include: { entity: true } });
  const ledgerTotals: Record<string, Record<string, number>> = {};
  for (const c of credits) {
    ledgerTotals[c.entity.name] ??= {};
    ledgerTotals[c.entity.name][c.currency] =
      (ledgerTotals[c.entity.name][c.currency] ?? 0) + Number(c.amount);
  }

  const pendingPayments = await prisma.payment.count({
    where: {
      status: {
        notIn: ["SETTLED", "COMPENSATED", "REJECTED", "CANCELLED", "REFUNDED", "EXPIRED", "FAILED", "DRAFT"],
      },
    },
  });

  return {
    networks,
    reservations: reservations.map((r) => ({
      payment_id: r.paymentId,
      asset: r.asset,
      network: r.network,
      amount: r.amount,
      status: r.status,
    })),
    ledgerTotals,
    pendingPayments,
  };
}

/**
 * Hash-chain integrity. Available to any authenticated principal: the verdict
 * is a property of the log, not of a tenant's rows, and no events are returned.
 * `anchored: false` is a weaker INTACT than a signed one — both fields are kept.
 */
export async function verifyAuditChainTool() {
  const integrity = await verifyAuditChain();
  return {
    verdict: integrity.valid ? "INTACT" : "BROKEN",
    valid: integrity.valid,
    broken_at_id: integrity.brokenAtId ?? null,
    reason: integrity.reason ?? null,
    mode: integrity.mode,
    anchored: integrity.anchored,
    events_verified: integrity.eventsVerified,
    checkpoint: integrity.checkpoint && {
      id: integrity.checkpoint.id,
      last_event_id: integrity.checkpoint.lastEventId,
      created_at: integrity.checkpoint.createdAt.toISOString(),
    },
  };
}
