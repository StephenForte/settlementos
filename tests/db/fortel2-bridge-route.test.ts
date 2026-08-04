// Hermetic proof that the simulated-bridge quote path is network-pair generic
// for ForteL2 (US-F008 / F7). quoteRoutes reads the payment row via Prisma and
// builds BRIDGE_AND_SETTLE off sourceNetwork/destinationNetwork with no
// hardcoded pairs; liquidityCheck degrades to {ok:true, recallRequired:false}
// when the destination chain is unreadable (fortel2 is absent from the fixture
// deployments and its RPC is pinned dead in FIXTURE_ENV). So this file
// exercises the full FX / bridge-fee / asset-mapping math without dialing any
// fortel2 chain. recall_required semantics need a live treasury read — covered
// in tasks/runbooks/fortel2-bridge-manual-qa.md, not here.

import { describe, it, expect } from "vitest";
import {
  applyBps,
  convert,
  formatRate,
  quoteFx,
  FX_SPREAD_BPS,
} from "@/lib/fx";
import { formatMinorUnits, parseAmount } from "@/lib/money";
import { assetForCurrency } from "@/lib/assets";
import { networkInfo } from "@/lib/networks";
import { BRIDGE_FEE_BPS, quoteRoutes, type RouteOption } from "@/lib/routing";
import { createDraftPayment } from "../helpers/payments";

const AMOUNT = "25000.00";
const SRC_CCY = "USD";
const DST_CCY = "JPY";

const BASE = "base-sepolia";
const FORTE = "fortel2-sepolia";

/** Independently recompute the bridged destination amount the quote engine should produce. */
function expectedBridgedDestAmount(amount: string, src: string, dst: string): string {
  const amountMinor = parseAmount(amount, src);
  const fx = quoteFx(amountMinor, src, dst);
  const bridgedEffective = applyBps(
    fx.midRate,
    FX_SPREAD_BPS + fx.slippageBps + BRIDGE_FEE_BPS
  );
  return formatMinorUnits(
    convert(amountMinor - fx.platformFee, bridgedEffective, src, dst),
    dst
  );
}

function expectedBridgedRate(amount: string, src: string, dst: string): string {
  const amountMinor = parseAmount(amount, src);
  const fx = quoteFx(amountMinor, src, dst);
  return formatRate(
    applyBps(fx.midRate, FX_SPREAD_BPS + fx.slippageBps + BRIDGE_FEE_BPS)
  );
}

function bridgeRoute(routes: RouteOption[]): RouteOption {
  const bridge = routes.find((r) => r.strategy === "BRIDGE_AND_SETTLE");
  expect(bridge).toBeDefined();
  return bridge!;
}

function assertBridgeShape(
  bridge: RouteOption,
  sourceNetwork: string,
  destinationNetwork: string
) {
  const srcLabel = networkInfo(sourceNetwork).label;
  const dstLabel = networkInfo(destinationNetwork).label;
  const sourceAsset = assetForCurrency(SRC_CCY);
  const destAsset = assetForCurrency(DST_CCY);
  const expectedDest = expectedBridgedDestAmount(AMOUNT, SRC_CCY, DST_CCY);
  const expectedRate = expectedBridgedRate(AMOUNT, SRC_CCY, DST_CCY);

  expect(bridge.source_network).toBe(sourceNetwork);
  expect(bridge.destination_network).toBe(destinationNetwork);
  expect(bridge.bridge_fee_bps).toBe(BRIDGE_FEE_BPS);
  expect(BRIDGE_FEE_BPS).toBe(5);

  expect(bridge.source_asset).toBe(sourceAsset.symbol); // mockUSDC
  expect(bridge.destination_asset).toBe(destAsset.symbol); // mockJPY
  expect(bridge.estimated_destination_amount).toBe(expectedDest);
  expect(bridge.estimated_fx_rate).toBe(expectedRate);

  expect(bridge.recommended).toBe(true);
  expect(bridge.liquidity_available).toBe(true);
  // Unreadable fortel2 / live-network treasury → degrade; do NOT assert recall_required.
  expect(bridge.recall_required).toBe(false);

  expect(bridge.description).toContain(srcLabel);
  expect(bridge.description).toContain(dstLabel);
  expect(bridge.description).toContain("simulated bridge");
  expect(bridge.description).toContain(destAsset.symbol);
  expect(bridge.hops).toEqual([
    `${sourceAsset.symbol} · ${srcLabel}`,
    "FX + simulated bridge",
    `${destAsset.symbol} · ${dstLabel}`,
    `${DST_CCY} ledger credit`,
  ]);
}

describe("ForteL2 simulated-bridge route quoting (hermetic)", () => {
  it("quotes BRIDGE_AND_SETTLE for base-sepolia → fortel2-sepolia", async () => {
    const payment = await createDraftPayment({
      amount: AMOUNT,
      sourceCurrency: SRC_CCY,
      destinationCurrency: DST_CCY,
      sourceNetwork: BASE,
      destinationNetwork: FORTE,
    });

    const routes = await quoteRoutes(payment.id);
    expect(routes).toHaveLength(2);

    const bridge = bridgeRoute(routes);
    assertBridgeShape(bridge, BASE, FORTE);
    expect(bridge.route_id).toBe(`route_${payment.id}_bridge`);

    // Fallback settles on source only — still named correctly, no fortel2 leg.
    const fallback = routes.find((r) => r.strategy === "SOURCE_CHAIN_LEDGER_SETTLEMENT");
    expect(fallback).toBeDefined();
    expect(fallback!.source_network).toBe(BASE);
    expect(fallback!.destination_network).toBe(BASE);
    expect(fallback!.bridge_fee_bps).toBe(0);
    expect(fallback!.description).toContain(networkInfo(BASE).label);
    expect(fallback!.description).not.toContain(networkInfo(FORTE).label);
  });

  it("quotes BRIDGE_AND_SETTLE for fortel2-sepolia → base-sepolia", async () => {
    const payment = await createDraftPayment({
      amount: AMOUNT,
      sourceCurrency: SRC_CCY,
      destinationCurrency: DST_CCY,
      sourceNetwork: FORTE,
      destinationNetwork: BASE,
    });

    const routes = await quoteRoutes(payment.id);
    expect(routes).toHaveLength(2);

    const bridge = bridgeRoute(routes);
    assertBridgeShape(bridge, FORTE, BASE);
    expect(bridge.route_id).toBe(`route_${payment.id}_bridge`);

    const fallback = routes.find((r) => r.strategy === "SOURCE_CHAIN_LEDGER_SETTLEMENT");
    expect(fallback).toBeDefined();
    expect(fallback!.source_network).toBe(FORTE);
    expect(fallback!.destination_network).toBe(FORTE);
    expect(fallback!.bridge_fee_bps).toBe(0);
    expect(fallback!.description).toContain(networkInfo(FORTE).label);
  });

  it("applies the same bridge-fee math as a known Base↔Polygon cross-network quote", async () => {
    // Control: the local sims already settle cross-chain in integration tests.
    // Matching destination amounts here proves fortel2 ids share that math path,
    // not a parallel code branch.
    const control = await createDraftPayment({
      amount: AMOUNT,
      sourceCurrency: SRC_CCY,
      destinationCurrency: DST_CCY,
      sourceNetwork: "base-local",
      destinationNetwork: "polygon-local",
    });
    const forteOut = await createDraftPayment({
      amount: AMOUNT,
      sourceCurrency: SRC_CCY,
      destinationCurrency: DST_CCY,
      sourceNetwork: BASE,
      destinationNetwork: FORTE,
    });
    const forteIn = await createDraftPayment({
      amount: AMOUNT,
      sourceCurrency: SRC_CCY,
      destinationCurrency: DST_CCY,
      sourceNetwork: FORTE,
      destinationNetwork: BASE,
    });

    const [controlRoutes, outRoutes, inRoutes] = await Promise.all([
      quoteRoutes(control.id),
      quoteRoutes(forteOut.id),
      quoteRoutes(forteIn.id),
    ]);

    const controlBridge = bridgeRoute(controlRoutes);
    const outBridge = bridgeRoute(outRoutes);
    const inBridge = bridgeRoute(inRoutes);

    expect(outBridge.estimated_destination_amount).toBe(
      controlBridge.estimated_destination_amount
    );
    expect(inBridge.estimated_destination_amount).toBe(
      controlBridge.estimated_destination_amount
    );
    expect(outBridge.bridge_fee_bps).toBe(controlBridge.bridge_fee_bps);
    expect(inBridge.bridge_fee_bps).toBe(controlBridge.bridge_fee_bps);
    expect(outBridge.estimated_fx_rate).toBe(controlBridge.estimated_fx_rate);
    expect(inBridge.estimated_fx_rate).toBe(controlBridge.estimated_fx_rate);
  });
});
