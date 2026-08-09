import { LoginForm } from "./login-form";
import { currentPrincipal } from "@/lib/session";

export default async function LoginPage() {
  const principal = await currentPrincipal();

  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-2xl font-semibold text-ink">Sign in</h1>
      <p className="mt-1 mb-6 text-sm text-body">
        Paste an API key to act as its principal. `npm run setup` prints the seeded keys once and
        writes them to <span className="font-mono text-ink-mid">chain/dev-api-keys.json</span>.
      </p>
      {principal && (
        <p className="mb-4 rounded-md border border-mute bg-canvas-soft px-3 py-2 text-sm text-body">
          Signed in as <span className="text-ink">{principal.label}</span> ({principal.role}).
          Signing in again replaces this session.
        </p>
      )}
      <LoginForm />
    </div>
  );
}
