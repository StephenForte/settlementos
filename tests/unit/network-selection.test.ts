import { describe, it, expect } from "vitest";
import { reconcileNetworkSelection } from "@/lib/network-selection";

describe("reconcileNetworkSelection", () => {
  it("keeps both legs when the current selection is already available", () => {
    expect(
      reconcileNetworkSelection(
        { source: "base-sepolia", destination: "polygon-amoy" },
        ["base-sepolia", "polygon-amoy", "fortel2-sepolia"]
      )
    ).toEqual({ source: "base-sepolia", destination: "polygon-amoy" });
  });

  it("maps both legs to the sole available network (Render single-rail case)", () => {
    // The bug on bcc2ac9: form state stayed base-local/polygon-local while the
    // only <option> was base-sepolia — no change event could ever fire.
    expect(
      reconcileNetworkSelection(
        { source: "base-local", destination: "polygon-local" },
        ["base-sepolia"]
      )
    ).toEqual({ source: "base-sepolia", destination: "base-sepolia" });
  });

  it("repairs only the invalid leg when the other is still available", () => {
    expect(
      reconcileNetworkSelection(
        { source: "base-sepolia", destination: "polygon-local" },
        ["base-sepolia", "fortel2-sepolia"]
      )
    ).toEqual({ source: "base-sepolia", destination: "base-sepolia" });
  });

  it("leaves the form untouched when available is empty", () => {
    expect(
      reconcileNetworkSelection(
        { source: "base-local", destination: "polygon-local" },
        []
      )
    ).toEqual({ source: "base-local", destination: "polygon-local" });
  });

  it("returned source and destination are always members of available when non-empty", () => {
    const cases: Array<{
      current: { source: string; destination: string };
      available: string[];
    }> = [
      {
        current: { source: "base-local", destination: "polygon-local" },
        available: ["base-sepolia"],
      },
      {
        current: { source: "base-sepolia", destination: "base-sepolia" },
        available: ["base-sepolia", "polygon-amoy"],
      },
      {
        current: { source: "ghost", destination: "base-sepolia" },
        available: ["fortel2-sepolia", "base-sepolia"],
      },
      {
        current: { source: "a", destination: "b" },
        available: ["x", "y", "z"],
      },
    ];
    for (const { current, available } of cases) {
      const next = reconcileNetworkSelection(current, available);
      expect(available).toContain(next.source);
      expect(available).toContain(next.destination);
    }
  });
});
