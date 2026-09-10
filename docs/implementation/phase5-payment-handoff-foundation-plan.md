# theCliniQ Phase 5 Step 4 — Payment Handoff foundation plan

## Scope

Step 4 is the minimum direct-patient bridge from an unexpired
`SLOT_RESERVED` Appointment Intent to `PAYMENT_PENDING`. It creates immutable
Phase 4 allocation evidence and a provider-agnostic internal payment intent.
It does not contact a payment provider and does not create a confirmed
Appointment.

Implementation is gated by the approved-with-condition P5-PH-B01 through
P5-PH-B03 requirements in
[`phase5-payment-handoff-open-decisions.md`](../decisions/phase5-payment-handoff-open-decisions.md)
are approved.

## Data model and migration

Create one reversible migration, proposed as
`20260915000000_phase5_payment_handoff.js`.

### `appointment_financial_handoffs`

The proposed table is booking-owned and has:

- UUID primary key;
- `appointment_intent_id`, `slot_reservation_id`,
  `financial_allocation_snapshot_id`, and `payment_intent_id`, each `NOT NULL`,
  `ON DELETE RESTRICT` FK, and individually `UNIQUE`;
- `booking_actor_account_id` (`NOT NULL`, restrictive Account FK);
- `idempotency_key` and server-derived `request_fingerprint` (`NOT NULL`);
- `created_at` and immutable creation actor/audit context; and
- no client-selected provider, offering, price, provider, tenant, currency, or
  amount column.

The bridge preserves Phase 4’s generic financial tables: it does not add
appointment foreign keys to `financial_allocation_snapshots` or
`payment_intents`. The only Phase 4 integrity correction is a database trigger
that rejects `UPDATE` and `DELETE` of `financial_allocation_components` after
insertion; it does not redesign the financial model.

The migration also adds `PAYMENT_PENDING` to the Appointment Intent state
vocabulary. An Appointment Intent transition guard rejects all direct-SQL
transitions outside the approved current lifecycle, including any transition to
`PAYMENT_PENDING` other than `SLOT_RESERVED → PAYMENT_PENDING`. A deferred
database guard verifies, at commit, that an Intent in that state has exactly
one consistent bridge, final immutable allocation, `CREATED` payment intent,
and matching still-held reservation/payment context. The bridge guard verifies
reservation-to-intent ownership, payment-to-allocation ownership, exact
amount/currency consistency, and immutable bridge rows. It also verifies that
the immutable, server-written allocation `input_data` matches the Appointment
Intent’s booking context. No related FK may cascade-delete financial linkage.

Targeted DOWN must fail if any handoff exists. It must not delete bookings,
allocations, payment intents, or other immutable financial history.

## Immutable allocation input

The allocation snapshot uses Phase 4 `bigint` minor units and records only
server-derived booking evidence:

- Appointment Intent, Slot Reservation, and Service Exposure IDs;
- Service Offering, Version, and Price IDs;
- patient/booking actor, provider doctor-or-clinic, and booking tenant IDs;
- direct booking relationship and any approved capability reference (none for
  the direct-patient slice);
- currency, gross minor-unit amount, requested local time, derived UTC range,
  buffers, hold expiry, and calculation timestamp; and
- selected commercial-rule versions plus any existing, approved refund or
  settlement policy-version references.

No raw payment provider payload, credential, session secret, Firebase token,
or arbitrary patient data is copied. A server-side selector considers only
`commercial_rules.status = ACTIVE`,
`commercial_rule_versions.status = APPROVED`, their effective time ranges, and
server-derived direct-booking provider Doctor/Clinic, Service Offering, and
`PATIENT_PROVIDER` scopes. No applicable rule or ambiguous highest-priority
rule fails closed before any financial record is written; Step 4 does not
synthesize policy values.

## Provider configuration and shared-executor boundary

The non-secret `provider_key` is resolved from a validated adapter registry at
server startup and injected through the composition root. It must never be
read from a request body, Appointment Intent, tenant, database row, or patient.
This configuration selects no credential and authorizes no live provider call.

Step 4 uses a dedicated payment-handoff repository/service that accepts the
Appointment Intent transaction's `PostgresExecutor`. It must not call the
existing `FinancialService.allocate()` or
`FinancialService.createPaymentIntent()` from inside that transaction because
those methods independently open transactions. Allocation creation,
component insertion, payment-intent insertion, bridge insertion, Appointment
Intent state transition, and audit write must occur in the **same PostgreSQL
transaction**. The Phase 4 evaluator may be reused as pure calculation logic.

## Transaction and lock sequence

All writes occur in one PostgreSQL transaction. No external provider call may
run while any transaction lock is held.

1. Authenticate the server session. Derive the Account; reject missing or
   invalid sessions before the transaction.
2. Lock `appointment_intents` by ID with `FOR UPDATE`.
3. Require direct-patient ownership: authenticated Account equals both
   `patient_account_id` and `booking_actor_account_id`. Revalidate the active
   PatientProfile. Tenant context, membership, network capability, exposure,
   provider, and client IDs do not substitute for this check.
4. Lock the linked `slot_reservations` row with `FOR UPDATE`; require it is the
   Intent’s sole row, has `HELD` status, and has `expires_at >
   clock_timestamp()`.
5. Lock any existing handoff by `appointment_intent_id` with `FOR UPDATE`.
   This is the idempotency serialization point. Then lock selected applicable
   Commercial Rule, Commercial Rule Version, Commercial Rule Scope, and
   Refund/Settlement Policy Version rows in ascending UUID order before
   evaluation.
6. If no handoff exists, evaluate approved Phase 4 commercial rules from the
   immutable booking snapshot; insert the final allocation and components,
   then the internal `CREATED` payment intent, then the handoff bridge.
7. Compare-and-set the Appointment Intent from `SLOT_RESERVED` to
   `PAYMENT_PENDING`. The deferred guard validates all links at commit.
8. Append the successful audit event and commit.

The global lock order is **Appointment Intent → Slot Reservation → Appointment
Financial Handoff → Commercial Rule → Commercial Rule Version → Commercial Rule
Scope → Refund/Settlement Policy Version**. Same-level financial rows are
locked in deterministic ascending UUID order. Step 4 does not take a new
capacity lock because it does not allocate capacity; the already-held
reservation is locked and revalidated. Existing reservation release and expiry
operations must be changed to the same Intent-first order before Step 4 so they
cannot deadlock with handoff. No external provider call may occur while any of
these locks are held.

### Expiry and races

If step 4 or 5 finds an expired hold using PostgreSQL `clock_timestamp()`, the
same transaction marks the held
reservation and the `SLOT_RESERVED` Intent `EXPIRED`, appends an expiry audit,
and returns a generic conflict. It creates neither allocation nor payment
intent. Concurrent handoffs serialize on the Intent/Reservation/Handoff locks:
one commits; the other reads the committed bridge and can only be an exact
idempotent replay. A race with expiry either completes the handoff while the
hold is still valid at the final database check, or expires it; it never
resurrects it.

After a successful handoff, the immutable reservation expiry remains in force.
The existing expiry path must be extended to expire a `PAYMENT_PENDING` Intent
and its internal payment intent without a provider call. A late retry or later
provider fact must be conflict/reconciliation input, never a mechanism for
reactivating the reservation or Intent.

## Idempotency

The public operation is scoped to the authenticated booking actor, Intent,
operation name, and opaque client key. The server computes a canonical
fingerprint from that scope. It stores a separately derived internal payment
idempotency key so the Phase 4 `UNIQUE(provider_key, idempotency_key)` boundary
cannot be confused by client keys from other booking operations.

| Case | Required result |
| --- | --- |
| First valid request | One allocation, one payment intent, one bridge, and `PAYMENT_PENDING`. |
| Same actor, Intent, key, and fingerprint | Return the existing handoff and identifiers; append replay audit; create nothing. |
| Same actor/Intent with a different key or fingerprint | Generic conflict; append conflict audit; do not disclose financial details. |
| Different actor or substituted Intent ID | Generic forbidden/not-found-equivalent response, with authorization-denial audit. |
| Expired, released, or already-expired reservation | Atomically expire where applicable and return conflict; create nothing. |
| Concurrent valid requests | One commits; the other becomes the exact replay or deterministic conflict. |

The endpoint accepts no mutable financial input, so “same key, different
request” is rejected by request validation or fingerprint comparison rather
than being interpreted as a new amount, provider, or booking.

## Payment-intent boundary

The payment intent is a Phase 4 record with server-derived `provider_key`,
`CREATED` status, allocation FK, exact gross amount/currency, and derived
provider-scoped idempotency key. Step 4 returns internal identifiers and
`PAYMENT_PENDING`; it returns no checkout URL, order ID, payment token, or
provider payload. A later approved provider integration may transition the
financial intent to `PENDING_PROVIDER` before an external order call.

## Minimal API contract

**Proposed endpoint:** `POST /v1/appointment-intents/:intentId/payment-handoffs`

| Item | Contract |
| --- | --- |
| Authentication | Existing server-side session cookie only. |
| Request | `{ "idempotencyKey": "opaque-client-key" }`; no amount, provider, patient, service, tenant, reservation, or price fields. |
| Success | New handoff: `201`; exact replay: `200`. Both return Intent ID, handoff ID, allocation ID, payment-intent ID, `PAYMENT_PENDING`, currency, and exact minor-unit amount. |
| Errors | `401` unauthenticated; generic `403` unauthorized; `409` expiry, invalid state, replay mismatch, duplicate, or no applicable approved rule. No database constraint names or ownership facts are returned. |
| Provider boundary | No provider order, checkout, payment verification, or credential interaction. |

## Audit and security

Use the existing append-only `audit_events` boundary for successful handoff,
exact replay, authorization denial, expiry, and conflict. Audit metadata uses
IDs/outcomes only. Raw idempotency keys, provider credentials, signatures,
payloads, sessions, and financial policy bodies are excluded.

Repository/service boundaries must enforce ownership after `FOR UPDATE`, not
only at the route. All offering/version/price/provider/tenant fields come from
the locked immutable Appointment Intent; client substitution is impossible.
The booking bridge’s database guards prevent direct SQL from creating an
inconsistent `PAYMENT_PENDING` state or reusing an allocation/payment intent
for another booking.

## Tests and verification

### Unit and API tests

- patient-owned successful handoff and exact replay;
- missing/revoked/expired session; non-patient, cross-account, and
  cross-tenant substitution denial;
- direct Patient clinic-owned and doctor-owned exposure contexts without
  implicit membership/network authority;
- only server-derived amount/currency/provider/offering/version/price inputs;
- invalid state, released/expired hold, stale retry, and replay-key conflict;
- allocation components and immutable snapshot linkage; and
- audit coverage with no sensitive metadata.

### PostgreSQL integration/concurrency tests

- two real concurrent handoff transactions for one held reservation: exactly
  one allocation, payment intent, bridge, and `PAYMENT_PENDING` transition;
- reservation expiry racing with handoff: either valid atomic handoff or
  expiry, never both;
- reservation release racing with handoff: one valid terminal outcome without
  deadlock or financial linkage on a released reservation;
- direct SQL attempts to create duplicate bridges, mismatched reservation,
  allocation, payment intent, amount/currency, or `PAYMENT_PENDING` without
  financial records must fail;
- direct SQL invalid Appointment Intent transitions and direct
  `PAYMENT_PENDING` invariant bypasses must fail;
- no-match and ambiguous commercial-rule selection must create no financial
  record;
- cross-account/IDOR and bridge-tampering attempts must fail;
- allocation-component `UPDATE` and `DELETE` must be rejected; and
- immutability of allocation/components and retention-safe targeted DOWN; and
- prior Phase 2, Phase 4, and Phase 5 tables remain intact after targeted DOWN.

### Disposable database verification

Create a dedicated SQL fixture and markdown procedure. It must apply the
current migrations plus the new Step 4 migration to a fresh disposable
PostgreSQL database, use deterministic fixtures within a transaction, test UP
and targeted DOWN, then confirm all prior-phase objects remain. It must never
use production data, credentials, a live provider, or checkout.

## Explicit non-goals

- Razorpay/live provider calls, checkout, credentials, webhooks, payment
  verification, reconciliation processing, and payment confirmation.
- Appointment confirmation or creation, refunds, settlements, ledger posting,
  completion, cancellation, or rescheduling.
- Clinic→Doctor `BOOK`, Clinic→Clinic referral booking, shared capacity pools,
  generated slots, Redis authority, UI, Firebase migration, and production
  deployment.
