// Runs in every test worker BEFORE any test file imports app code, so modules
// that read env at import time (lib/db, lib/chain, lib/networks) see the fixture.
import { fixtureEnv, readFixtureDatabaseUrl } from "./fixture";

Object.assign(process.env, fixtureEnv(readFixtureDatabaseUrl()));
