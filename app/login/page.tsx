import { LoginForm } from "./login-form";
import { currentPrincipal } from "@/lib/session";

export default async function LoginPage() {
  const principal = await currentPrincipal();

  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-2xl font-semibold text-white">Sign in</h1>
      <p className="mt-1 mb-6 text-sm text-slate-400">
        Paste an API key to act as its principal. `npm run setup` prints the seeded keys once and
        writes them to <span className="font-mono text-slate-300">chain/dev-api-keys.json</span>.
      </p>
      {principal && (
        <p className="mb-4 rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm text-slate-400">
          Signed in as <span className="text-slate-200">{principal.label}</span> ({principal.role}).
          Signing in again replaces this session.
        </p>
      )}
      <LoginForm />
    </div>
  );
}
