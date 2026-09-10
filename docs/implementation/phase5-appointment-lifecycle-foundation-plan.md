# theCliniQ Phase 5 Step 5 — Appointment Lifecycle Foundation Plan

## Scope

Create durable Appointment lifecycle after Step 4 `PAYMENT_PENDING`; exclude
checkout, live Razorpay credentials, payouts, chat, prescriptions, files,
shared capacity, referral/BOOK capability, UI and deployment.

## Persistence and guards

Appointment has restrictive immutable references to Intent, Reservation,
handoff/allocation/payment intent, patient/provider/clinic/tenant, service
exposure/offering/version/price, booking context and local/UTC window, plus
state/timestamps. Immutable events include payment-confirmed, started,
completed, cancelled, reschedule-requested, rescheduled, reconciliation-required
and controlled-support-exception with actor, reason and audit linkage.

Step 5.2 adds only the typed internal transition foundation. Its exact
database/application matrix is `PAYMENT_PENDING → CONFIRMED`,
`PAYMENT_PENDING → PAYMENT_FAILED`, `PAYMENT_PENDING → EXPIRED`,
`CONFIRMED → IN_PROGRESS`, `CONFIRMED → CANCELLED`,
`IN_PROGRESS → COMPLETED`, and `IN_PROGRESS → CANCELLED`. Every successful
transition updates the Appointment and inserts exactly one immutable
Appointment Event, linked to its distinct business Audit Event, in one
PostgreSQL transaction. The transition service locks only the Appointment and
uses compare-and-set status writes; when a future operation also needs booking
state, it preserves `Intent → Reservation → Appointment`. Terminal records
cannot reactivate.

This is not a generic status API. The service receives a typed internal action
and actor/context for future workflow authorization. It deliberately does not
perform provider confirmation, cancellation/refund, start/completion
authorization, rescheduling, external calls, financial writes, or a new
idempotency scheme. Exact replay remains a future workflow/API concern because
the current immutable event schema has no correlation identifier.

### Operation, lock, and external-call boundaries

Business operation order, PostgreSQL lock order, and external provider calls
are separate concerns. The common booking-lifecycle lock prefix remains
`Intent → Reservation`.

Provider-event ingestion is a separate authenticated, deduplicated transaction.
It authenticates/verifies first, then persists or deduplicates the provider event
in its own short transaction without locking appointment-lifecycle rows. A
received webhook alone never confirms an Appointment.

After an authenticated/reconciled provider fact is available, a confirmation
transaction locks the persisted provider event, Appointment Intent, Slot
Reservation, Appointment, financial handoff, and mutable payment record in that
order as applicable. Immutable allocation evidence is validated, not treated as
a mutable lock target. Existing payment-handoff revalidation retains its
`Intent → Reservation → Handoff → service/policy` lock order. The transaction
validates captured success, immutable links, and held unexpired capacity; creates
or resolves one Appointment; transitions it to `CONFIRMED` atomically; and
commits before notifications or provider follow-up. Unknown or conflicting facts
go to reconciliation.

External Razorpay/provider calls never occur while PostgreSQL lifecycle locks are
held. A lifecycle transaction must not call `FinancialService.allocate()`,
`FinancialService.createPaymentIntent()`, or another transaction-owning financial
method. Lifecycle-linked financial work uses a transaction-aware financial
adapter/repository that accepts the existing `PostgresExecutor`; nested or
independent financial transactions are prohibited.

## Operations

Start validates actor/window/state. Completion uses approved authority, audits
evidence and marks settlement eligibility only. Cancellation selects versioned
policy, snapshots it, writes compensating finance without mutating allocation.
Reschedule validates new booking context, reserves new capacity first, compares
price and applies approved adjustment/refund policy before releasing old slot.
When multiple capacity resources are required, the implementation locks them in
one documented deterministic order; no path may lock old→new while another locks
new→old. Any applicable financial consequence uses the same transaction
boundary. State transitions use row locking plus compare-and-set semantics.
Support/Admin requires elevated permission, mandatory reason/audit, and no
financial self-approval. Support/Admin exceptions reuse the same lifecycle
locking and service path rather than introducing a separate convention.

Service, price, reservation, allocation, financial-handoff, provider-event, and
Appointment-event evidence remains immutable.

## Migration and verification

Future reversible migration adds Appointment/events, restrictive FKs, transition
and immutable-event guards, confirmation consistency guard and indexes without
rewriting Steps 1–4. Tests cover transitions, idempotency, confirmation/
reconciliation races, authorization, policy selection, reschedule capacity and
price cases, completed protection, exception control, audit immutability and
Steps 1–4 regressions. Disposable PostgreSQL UP/DOWN verifies guards and
preservation.
