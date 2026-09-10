# theCliniQ Phase 5 Step 4 — Payment Handoff verification

## Disposable PostgreSQL procedure

Use only a fresh disposable PostgreSQL database with all prior theCliniQ
migrations and `20260915000000_phase5_payment_handoff.js` applied. Never use
application or production data, provider credentials, checkout, or a live
payment provider.

Run [`phase5-payment-handoff-verification.sql`](phase5-payment-handoff-verification.sql)
with PostgreSQL error stopping enabled. The fixture runs in one transaction and
rolls back its deterministic Account, profile, Service Offering, exposure,
Appointment Intent, reservation, commercial-rule, allocation, payment-intent,
and handoff records.

The script proves the migration objects exist, validates a consistent direct
patient `SLOT_RESERVED → PAYMENT_PENDING` bridge, and rejects direct SQL
component mutation, bridge mutation, duplicate bridge insertion, and invalid
Appointment Intent state transitions. Targeted DOWN must be executed only
after the fixture rollback and must fail safely if any real handoff exists.

## Not SQL-testable

Session authentication, server-derived provider-key resolution, route request
shape, patient IDOR handling, and real concurrent application requests are
covered by API/integration tests. They require an application process and
separate PostgreSQL connections; this fixture deliberately contains no
credentials or provider call.
