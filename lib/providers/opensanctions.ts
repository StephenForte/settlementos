// OpenSanctions matching API — real consolidated OFAC/EU/UN screening of
// entity names. Docs: https://www.opensanctions.org/docs/api/matching/
//   POST {OPENSANCTIONS_API_URL}/match/default
//   Authorization: ApiKey <OPENSANCTIONS_API_KEY>
// One request screens both parties (query ids "sender"/"recipient"); results
// come back per query with a score (0–1) and the API's own match verdict.

import { providerResult, type ProviderResult } from "./types";
import { fetchJson, failSafe } from "./http";

export const PROVIDER_NAME = "opensanctions";
/** Below the API's match threshold but close enough to warrant a human look. */
export const POSSIBLE_MATCH_SCORE = 0.5;

export interface ScreeningParty {
  kind: "sender" | "recipient";
  name: string;
  country?: string;
}

function baseUrl(): string {
  // `||` not `??`: an empty-string env var means "unset", not "empty URL".
  return (process.env.OPENSANCTIONS_API_URL || "https://api.opensanctions.org").replace(/\/$/, "");
}

interface MatchResult {
  score?: number;
  match?: boolean;
}

export async function openSanctionsScreen(parties: ScreeningParty[]): Promise<ProviderResult> {
  const queries = Object.fromEntries(
    parties.map((p) => [
      p.kind,
      {
        schema: "Company",
        properties: { name: [p.name], ...(p.country ? { country: [p.country] } : {}) },
      },
    ])
  );

  try {
    const { status, body } = await fetchJson(`${baseUrl()}/match/default`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `ApiKey ${process.env.OPENSANCTIONS_API_KEY}`,
      },
      body: JSON.stringify({ queries }),
    });
    if (status !== 200) return failSafe(PROVIDER_NAME, `unexpected status ${status}`, status, body);

    const responses =
      (body as { responses?: Record<string, { results?: MatchResult[] }> })?.responses ?? {};
    let maxScore = 0;
    const matchReasons: string[] = [];
    for (const p of parties) {
      for (const r of responses[p.kind]?.results ?? []) {
        maxScore = Math.max(maxScore, r.score ?? 0);
        if (r.match && !matchReasons.includes(`${p.kind}_sanctions_list_match`)) {
          matchReasons.push(`${p.kind}_sanctions_list_match`);
        }
      }
    }

    const score = Math.round(maxScore * 100);
    if (matchReasons.length > 0) return providerResult(PROVIDER_NAME, "FAIL", 100, matchReasons, body);
    if (maxScore >= POSSIBLE_MATCH_SCORE)
      return providerResult(PROVIDER_NAME, "MANUAL_REVIEW", score, ["sanctions_possible_match"], body);
    return providerResult(PROVIDER_NAME, "PASS", score, [], body);
  } catch (err) {
    return failSafe(PROVIDER_NAME, err);
  }
}
