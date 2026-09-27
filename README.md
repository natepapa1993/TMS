# Crossline TMS

Cross-border carrier TMS: Mexican leg, crossing, US leg — one order, one screen, every rule enforced before a truck moves. Sold per truck per month.

The plan, functional spec and personas live in the Claude doc ("TMS plan"). Feature IDs in code and tests refer to that spec.

## Run it

```
cp .env.example .env.local        # DATABASE_URL, TEST_DATABASE_URL, SESSION_SECRET (≥32 chars)
pnpm install
pnpm db:migrate                   # applies ./drizzle to DATABASE_URL
pnpm dev
```

## Prove it

Nothing is "done" until it passes (spec §10.1a). CI runs all of this on every push:

```
pnpm typecheck      # next typegen + tsc
pnpm lint
pnpm db:reset-test  # drops and re-migrates TEST_DATABASE_URL
pnpm test           # vitest: state machines (every pair), eligibility, orders/dispatch, records, import
pnpm features       # feature board gate: every "done" feature names tests that mention it
pnpm build
pnpm test:e2e       # Playwright, real browser, real database: setup, dispatcher day, OOS/split/hold, isolation
```

## Where things are

- `src/db/schema` — tables. Every tenant-owned table has `tenant_id`, audit columns and `archived_at`.
- `src/data/records.ts` — the one repository for master data (tenant scope, permissions, audit, archive blockers, optimistic concurrency).
- `src/data/fields.ts` — field definitions that drive the quick-add popup, record screen, list columns and CSV import.
- `src/domain/states.ts` — order and leg transition tables. `src/domain/eligibility.ts` — who may run which leg (B-1 has no override). `src/domain/orders.ts` — create/book/plan/dispatch/advance/split/hold/OOS.
- `src/app/(app)` — Dispatch board, Orders, Fleet, Settings. Server functions in each `actions.ts` check the session and call the domain; the UI never touches the database.
- `docs/features.json` — the feature board.

## Milestones

M0 (this) foundation & dispatch · M1 tendering & tracking · M2 crossing · M3 compliance · M4 billing · M5 Sylectus/DAT/portals · M6+ per the plan.
