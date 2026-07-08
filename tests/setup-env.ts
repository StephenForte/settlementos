// Runs in every test worker BEFORE any test file imports app code, so modules
// that read env at import time (lib/db, lib/chain, lib/networks) see the fixture.
import { FIXTURE_ENV } from "./fixture";

Object.assign(process.env, FIXTURE_ENV);
