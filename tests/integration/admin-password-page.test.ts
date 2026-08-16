import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/admin/password/change-password-form", () => ({
  ChangePasswordForm: () => null,
}));

import ChangePasswordPage from "@/app/admin/password/page";
import AdminIndexPage from "@/app/admin/page";

describe("/admin/password page", () => {
  it("states that existing sessions stay signed in (AD4)", () => {
    const html = renderToStaticMarkup(createElement(ChangePasswordPage));
    expect(html).toContain("Existing sessions stay signed in");
    expect(html).toContain("Change password");
    expect(html).toContain("/admin");
  });

  it("is linked from the admin index with the same session note", () => {
    const html = renderToStaticMarkup(createElement(AdminIndexPage));
    expect(html).toContain("/admin/password");
    expect(html).toContain("Existing sessions stay signed in");
  });
});
