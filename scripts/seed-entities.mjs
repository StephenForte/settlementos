// Demo entity definitions shared by scripts/setup.mjs and scripts/seed-demo.mjs.
// Address is supplied per network by the caller (dev-mnemonic in setup; overlay
// wallets in seed-demo). Keep in sync with ENTITIES in tests/helpers/deploy.ts
// when adding entity fields (AGENTS.md gotcha — that copy stays TypeScript).

/**
 * @typedef {{ label: string, allowlisted: boolean, riskScore: number }} WalletProfile
 * @typedef {{
 *   externalId: string,
 *   name: string,
 *   country: string,
 *   role: string,
 *   kybStatus: string,
 *   riskRating: string,
 *   approvedCorridors: string,
 *   mmfEligible?: boolean,
 *   mmfOptIn?: boolean,
 *   walletProfile: WalletProfile,
 * }} DemoEntity
 */

/** @type {readonly DemoEntity[]} */
export const DEMO_ENTITIES = Object.freeze([
  {
    externalId: "ent_acme_us",
    name: "ACME US Inc",
    country: "US",
    role: "SENDER",
    kybStatus: "PASSED",
    riskRating: "LOW",
    approvedCorridors: JSON.stringify(["USD-JPY", "USD-SGD"]),
    // The one institution cleared for tokenized-MMF parking (Phase 8).
    mmfEligible: true,
    mmfOptIn: true,
    walletProfile: {
      label: "ACME operating wallet",
      allowlisted: true,
      riskScore: 5,
    },
  },
  {
    externalId: "ent_tokyo_supplier",
    name: "Tokyo Trading KK",
    country: "JP",
    role: "RECIPIENT",
    kybStatus: "PASSED",
    riskRating: "LOW",
    approvedCorridors: JSON.stringify(["USD-JPY", "SGD-JPY", "JPY-USD"]),
    walletProfile: {
      label: "Tokyo Trading settlement wallet",
      allowlisted: true,
      riskScore: 10,
    },
  },
  {
    externalId: "ent_sg_supplier",
    name: "Singapore Imports Pte Ltd",
    country: "SG",
    role: "BOTH",
    kybStatus: "PASSED",
    riskRating: "LOW",
    approvedCorridors: JSON.stringify(["USD-SGD", "SGD-JPY", "SGD-USD"]),
    walletProfile: {
      label: "SG Imports settlement wallet",
      allowlisted: true,
      riskScore: 8,
    },
  },
  {
    // Intentionally incomplete onboarding — demos the manual-review path.
    externalId: "ent_osaka_parts",
    name: "Osaka Parts Co",
    country: "JP",
    role: "RECIPIENT",
    kybStatus: "PENDING",
    riskRating: "MEDIUM",
    approvedCorridors: JSON.stringify(["USD-JPY"]),
    walletProfile: {
      label: "Osaka Parts wallet (unverified)",
      allowlisted: false,
      riskScore: 55,
    },
  },
]);

/** Entity columns written on create / --refresh-entities (not the wallet profile). */
export const ENTITY_REFRESH_COLUMNS = Object.freeze([
  "name",
  "country",
  "role",
  "kybStatus",
  "riskRating",
  "approvedCorridors",
  "mmfEligible",
  "mmfOptIn",
]);

/**
 * @param {DemoEntity} e
 */
export function entityRowData(e) {
  return {
    externalId: e.externalId,
    name: e.name,
    country: e.country,
    role: e.role,
    kybStatus: e.kybStatus,
    riskRating: e.riskRating,
    approvedCorridors: e.approvedCorridors,
    mmfEligible: e.mmfEligible ?? false,
    mmfOptIn: e.mmfOptIn ?? false,
  };
}
