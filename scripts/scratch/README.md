# Scratch / one-off scripts

Ad-hoc checks, probes, and historical root `test-*` / `check-*` / `debug-*` helpers.

**Not part of the product runtime.** Prefer:

- unit tests: `src/**/*.test.ts` and `test/`
- farm tests: `scripts/grok-farm/tests/`
- ops: `scripts/doctor.ts`, `preflight.ts`, `production.ts`, `start.ts`

These files may be deleted when unused.
