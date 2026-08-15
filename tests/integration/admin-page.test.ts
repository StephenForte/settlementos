import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "@/lib/auth";

vi.mock("@/lib/session", () => ({
  currentPrincipal: vi.fn(),
}));

import { currentPrincipal } from "@/lib/session";
import AdminLayout from "@/app/admin/layout";
import AdminIndexPage from "@/app/admin/page";

const operator: Principal = { keyId: "k_op", role: "OPERATOR", label: "Platform operator" };
const reviewer: Principal = { keyId: "k_rev", role: "REVIEWER", label: "Compliance reviewer" };

async function renderAdmin() {
  const page = createElement(AdminIndexPage);
  const shell = await AdminLayout({ children: page });
  return renderToStaticMarkup(shell);
}

describe("/admin shell", () => {
  beforeEach(() => {
    vi.mocked(currentPrincipal).mockReset();
  });

  it("renders the admin index for an OPERATOR", async () => {
    vi.mocked(currentPrincipal).mockResolvedValue(operator);
    const html = await renderAdmin();
    expect(html).toContain("Admin");
    expect(html).toContain("/admin/password");
    expect(html).toContain("/admin/coins");
    expect(html).toContain("/admin/wallets");
    expect(html).not.toContain("Sign in required");
  });

  it("does not render admin for an anonymous caller", async () => {
    vi.mocked(currentPrincipal).mockResolvedValue(null);
    const html = await renderAdmin();
    expect(html).toContain("Sign in required");
    expect(html).not.toContain("/admin/password");
    expect(html).not.toContain("Mock coins");
  });

  it("does not render admin for a REVIEWER", async () => {
    vi.mocked(currentPrincipal).mockResolvedValue(reviewer);
    const html = await renderAdmin();
    expect(html).toContain("Sign in required");
    expect(html).not.toContain("/admin/password");
  });
});
