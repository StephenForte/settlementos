// Stand-in for the `server-only` marker package under vitest.
//
// That package resolves to an unconditional `throw` outside a React Server
// Components bundle (its "react-server" export condition is what swaps in the
// empty module), so importing lib/chain.ts — or anything reaching it — would
// blow up the suite at import time. Vitest aliases the package here instead;
// the real marker still guards the Next build, which is the bundle that matters.
export {};
