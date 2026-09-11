# Phase 5 Step 5.3 — Razorpay Order Provisioning and Payment Confirmation

## Scope and state model

This step keeps the approved payment-intent vocabulary. `CREATED` becomes
`PENDING_PROVIDER` only after a validated Razorpay Order is durably linked to
the internal payment intent. `ORDER_PROVISIONING` is deliberately not a
payment-intent state: in-flight external work is represented by the separate,
one-to-one `payment_order_provisioning_attempts` record.

`PENDING_PROVIDER` requires a non-null, immutable `provider_order_id`. The
database guard permits that relationship to be set only with the atomic
`CREATED` to `PENDING_PROVIDER` transition.

## Receipt, claim, and external-call boundary

The server derives the deterministic receipt `clqpi_` plus the lowercase
hyphen-free payment-intent UUID. It contains no patient, appointment, clinic,
or medical information and is 38 characters long.

Claim transaction lock order is:

`Appointment Intent → Slot Reservation → Appointment Financial Handoff → Payment Intent → Provisioning Attempt`.

The claim is a PostgreSQL compare-and-set lease. The Razorpay lookup/create
operation runs only after that transaction commits. A retry first recovers an
Order by receipt; it never trusts client amount, currency, receipt, or order
identifiers. Finalization reacquires the same locks, validates immutable
allocation and active reservation context, writes the ORDER provider reference,
sets the payment intent to `PENDING_PROVIDER`, and finalizes the attempt in one
transaction. Mismatch, expiry, or lease loss is reconciliation/conflict, never
a capacity resurrection.

## Webhook confirmation

`POST /v1/providers/razorpay/webhook` is a provider-only ingress. It verifies
the Razorpay HMAC over the raw request body before JSON parsing. Internal IDs,
amounts, currencies, and payment authority are derived solely from the
authenticated `payment.captured` event. `order.paid` and unknown events can be
recorded but cannot confirm an appointment.

Webhook ingestion/deduplication is a short transaction. Confirmation is a
second transaction with this lock hierarchy:

`Appointment Intent → Slot Reservation → Appointment Financial Handoff → Appointment → Payment Intent → Provider Webhook Event`.

Immutable allocation evidence is validated, not locked as a mutable target.
The confirmation transaction validates exact provider order/payment correlation
and amount/currency equality, persists the unique payment fact, transitions
`PENDING_PROVIDER → SUCCEEDED`, creates or locks the appointment, then
atomically transitions `PAYMENT_PENDING → CONFIRMED` with exactly one immutable
appointment event and audit event. Provider calls and notifications are not
made while these locks are held.

## Reconciliation and expiry

Conflicting provider facts, mismatched order context, late success after expiry,
and failed finalization become reconciliation evidence. Reservation expiry now
expires both `CREATED` and `PENDING_PROVIDER` payment intents, so later provider
events cannot revive the booking. Provider secrets, authorization headers,
signatures, and raw provider payloads are neither logged nor returned through
the patient API.

## Explicit exclusions

Razorpay Checkout/UI, refunds, settlements, payouts, cancellation,
rescheduling, support exceptions, provider polling APIs, reconciliation UI,
and production deployment remain outside this step.
