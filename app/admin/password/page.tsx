import Link from "next/link";
import { ChangePasswordForm } from "./change-password-form";

export default function ChangePasswordPage() {
  return (
    <div className="mx-auto max-w-md space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Change password</h1>
        <p className="mt-1 text-sm text-body">
          Requires the current password. Existing sessions stay signed in — a
          password change gates new logins only.
        </p>
      </header>
      <ChangePasswordForm />
      <Link href="/admin" className="inline-block text-sm text-primary hover:underline">
        ← Admin
      </Link>
    </div>
  );
}
