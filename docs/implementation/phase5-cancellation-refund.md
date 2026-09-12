# theCliniQ Phase 5.5 — Cancellation and Refund

## Scope

Phase 5.5 provides an authorized, idempotent cancellation decision for an existing appointment and a durable refund-execution boundary. It does not implement rescheduling, start/completion workflows, network booking, or production provider deployment.

## Cancellation state and authorization

The supported cancellation transitions are `PAYMENT_PENDING → CANCELLED`, `CONFIRMED → CANCELLED`, and `IN_PROGRESS → CANCELLED`. The payment-pending transition exists only to make the approved payment-confirmation race deterministic: a later provider capture remains an immutable provider fact and cannot resurrect the appointment.

The existing appointment authorization service remains authoritative:

- a patient cancels only an appointment containing the Account-owned patient participant;
- a doctor cancels only an appointment containing their Account-owned, currently ACTIVE and VERIFIED doctor participant;
- a clinic Owner or Admin cancels only a clinic-participant appointment with current `appointment.cancel` membership permission;
- clinic Staff and deferred Support/Admin actors are denied.

## Refund-policy selection

At cancellation-decision time, the service selects approved and effective policy versions in descending scope specificity: global, provider, service offering, then service offering plus provider. The highest priority within the winning specificity wins. No match and an equally ranked winner are failures; database ordering is never used as a business decision.

Structured policy data declares a refund outcome (`NONE`, `FULL`, or `PERCENTAGE`), `PAYMENT_AMOUNT` basis, cancellation-window seconds, eligible payment states, and whether in-progress cancellation is allowed. The actor supplies only a reason and idempotency key; refund amount and selected policy are server-derived and persisted with the immutable cancellation decision.

All money is represented as integer minor units. Percentage refunds use deterministic integer truncation toward zero: `payment_amount_minor * percentage_bps / 10000`. Structured policy validation requires integer non-negative window seconds, approved payment-state vocabulary, and an integer `percentageBps` only for `PERCENTAGE` policies.

## Transaction and capacity behavior

The cancellation transaction uses an explicit sequential lock order:

`Appointment Intent → Slot Reservation → Financial Handoff → Appointment → Payment Intent → Payment → Cancellation Decision → Refund`.

It validates policy, transitions appointment state with compare-and-set semantics, creates the immutable decision/event/audit/consequence records, creates a refund request where applicable, and releases a held future reservation atomically. An in-progress appointment is never made reusable automatically. Existing reservation expiry remains distinct from cancellation.

## Refund execution and reconciliation

Cancellation and external refund execution are separate. A refund attempt is claimed and committed before calling the provider. The provider response is persisted in a later transaction. Unknown provider outcomes, including a timeout or unavailable operation, become `RECONCILIATION_REQUIRED`; they are never treated as a definitive failure or success.

Razorpay credentials and live refund calls remain disabled unless the configured provider safely implements `createRefund`. No external provider call occurs while PostgreSQL lifecycle locks are held.

## Financial and settlement evidence

Original allocation, price, payment, and ledger history remain immutable. The cancellation decision references the exact locked appointment reservation, allocation snapshot, and payment context. PostgreSQL deferred integrity guards reject a refund or financial consequence that has an unrelated allocation/payment, mismatched currency/policy, or amount above the approved decision or original payment. Provider refund references are immutable.

Phase 5.5 does not invent ledger account mappings or rewrite settlement history. Because the approved refund policy does not yet encode an automated settlement treatment, an existing settlement relationship produces immutable cancellation evidence with `RECONCILIATION_REQUIRED`; no settlement status is automatically changed. Creating compensating ledger entries or approved financial adjustments remains a controlled Phase 4 reconciliation/accounting workflow decision.

## Provider reconciliation

Refund execution commits a durable claim before the external call. A webhook with zero or multiple eligible refund matches is retained as immutable provider evidence and routed to reconciliation without mutating any candidate refund. A provider refund reference is inserted/verified before success is finalized: an existing reference is accepted only when it belongs to the same refund; a collision or inconsistent provider fact results in reconciliation rather than a successful refund state.
