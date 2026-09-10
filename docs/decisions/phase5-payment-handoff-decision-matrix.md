# theCliniQ Phase 5 Step 4 — Payment Handoff decision matrix

## Scope and decision status

This package defines the smallest **direct Patient** handoff from a valid
`SLOT_RESERVED` Appointment Intent to `PAYMENT_PENDING`. It inherits approved
Phase 2 authorization, Phase 4 financial immutability, and Phase 5 booking
decisions. It does not approve a payment-provider call, checkout, webhook, or
appointment confirmation.

Entries marked **INHERITED APPROVED** are already locked by an earlier phase.
Entries marked **APPROVED WITH CONDITION** are accepted architecture subject to
the stated implementation gate; they do not choose commercial, legal, or
provider business values.

| ID | Status | Decision |
| --- | --- | --- |
| P5-PH-01 | INHERITED APPROVED | A handoff starts only from a direct-patient `SLOT_RESERVED` intent with its one `HELD`, unexpired reservation. `PAYMENT_PENDING` is not appointment confirmation and payment success alone never confirms an appointment. |
| P5-PH-02 | APPROVED WITH CONDITION AFTER DESIGN REVISION | Add one booking-owned `appointment_financial_handoffs` table rather than adding appointment foreign keys to Phase 4 generic financial tables. It is a one-to-one immutable bridge: `appointment_intent_id`, `slot_reservation_id`, `financial_allocation_snapshot_id`, and `payment_intent_id` are each restrictive FKs and individually unique. All allocation/payment writes must use the Appointment transaction's shared `PostgresExecutor`, not nested FinancialService transactions. |
| P5-PH-03 | APPROVED WITH CONDITION AFTER DESIGN REVISION | Expand the Appointment Intent state vocabulary only with `PAYMENT_PENDING`; allow only `SLOT_RESERVED → PAYMENT_PENDING`. A deferred PostgreSQL transition guard must reject that transition unless a consistent handoff row, final allocation, `CREATED` payment intent, and still-valid held reservation exist at commit. |
| P5-PH-04 | APPROVED WITH CONDITION | `financial_allocation_snapshots` remain immutable Phase 4 records. Step 4 adds the narrowly scoped database correction that `financial_allocation_components` are immutable after insertion. Components remain linked exclusively by `financial_allocation_components.allocation_snapshot_id`; no price, commission, tax, refund, or settlement value is invented by Step 4. |
| P5-PH-05 | APPROVED WITH CONDITION AFTER DESIGN REVISION | The handoff bridge must assert all links: its reservation belongs to its Appointment Intent; the payment intent references its allocation; payment currency and amount equal the allocation gross amount/currency; and allocation `input_data` contains a server-derived immutable booking context matching the Appointment Intent. No FK may cascade-delete financial linkage. |
| P5-PH-06 | INHERITED APPROVED | Financial amounts use `bigint` minor units and ISO currency. The gross input is the Appointment Intent’s immutable `price_amount_minor` and `currency`; the selected commercial-rule version(s) and Phase 4 calculation outcome are recorded in the allocation snapshot. |
| P5-PH-07 | APPROVED WITH CONDITION | Step 4 creates a provider-agnostic internal Phase 4 `payment_intent` in `CREATED`, linked to the final allocation. Its non-secret `provider_key` comes only from a validated server configuration and adapter registry at startup, injected through the composition root; it never comes from a request body, Appointment Intent, tenant, database row, or patient. Step 4 does not call a provider or move that financial intent to `PENDING_PROVIDER`. |
| P5-PH-08 | PROPOSED FOR STEP 4 APPROVAL | Only the authenticated Account that is both `patient_account_id` and `booking_actor_account_id` on a direct-patient intent may initiate or replay its handoff. Tenant context, clinic membership, network participation, provider identity, and client-supplied IDs grant no handoff authority. |
| P5-PH-09 | PROPOSED FOR STEP 4 APPROVAL | Handoff idempotency scope is `(booking_actor_account_id, appointment_intent_id, operation, client_idempotency_key)`. Store the opaque client key and a server-derived request fingerprint on the bridge. Derive the provider-facing payment-intent key server-side from that scope; never use a client key as a globally provider-scoped key. |
| P5-PH-10 | PROPOSED FOR STEP 4 APPROVAL | The only accepted client payload is an opaque idempotency key. The booking, provider, tenant, offering, version, price, reservation, currency, amount, commercial context, and provider key are all server-derived. Therefore a different payload is rejected at request validation, while the same scope/key with a different derived fingerprint is a conflict. |
| P5-PH-11 | APPROVED WITH CONDITION | Expiry is evaluated by PostgreSQL using `clock_timestamp()` while holding the Intent and Reservation locks. If the hold has expired, atomically mark the reservation and intent expired, append audit, create no financial records, and return a conflict. A later retry cannot revive the hold. |
| P5-PH-12 | APPROVED WITH CONDITION | `PAYMENT_PENDING` remains bounded by the immutable reservation expiry. The existing reservation release/expiry operations must use the same global lock order as handoff to avoid deadlocks and must handle `PAYMENT_PENDING → EXPIRED`, release/expire the held reservation, and mark the internal payment intent expired without provider interaction. A late provider fact is explicitly future reconciliation work and cannot restore capacity or booking state. |
| P5-PH-13 | INHERITED APPROVED | PostgreSQL is the transaction and concurrency authority. Redis may not decide authorization, allocation, idempotency, expiry, payment state, or reservation validity. No external call occurs while database locks are held. |
| P5-PH-14 | APPROVED WITH CONDITION | Required audit outcomes are `APPOINTMENT_PAYMENT_HANDOFF_CREATED`, `APPOINTMENT_PAYMENT_HANDOFF_REPLAYED`, `APPOINTMENT_PAYMENT_HANDOFF_EXPIRED`, `APPOINTMENT_PAYMENT_HANDOFF_CONFLICT`, and authorization denial through the existing appointment/audit boundary. Metadata contains identifiers and outcome only—never provider credentials, secrets, payment payloads, or raw idempotency keys. |

## Exact linkage model

`appointment_intents` owns the business booking context and its one
`slot_reservations` row owns the short-lived capacity hold. The proposed bridge
links that immutable booking evidence to a Phase 4 allocation and payment
intent without changing ownership of either domain:

```text
appointment_intents 1 ── 1 slot_reservations
        │                         │
        └──── 1 appointment_financial_handoffs 1 ────┘
                              │                 │
                              1                 1
          financial_allocation_snapshots    payment_intents
                              │
                              └── 1..n financial_allocation_components
```

The bridge is immutable after insertion. Its restrictive FKs and unique
constraints prevent a booking from acquiring a second allocation or payment
intent, and prevent one allocation/payment intent from being reused by another
booking. Allocation `input_data` is a server-derived snapshot, not an
authorization input.

## Provider key and commercial-rule selection

`provider_key` is a non-secret server configuration value. A validated adapter
registry resolves it at startup and the composition root injects the selected
key into the Step 4 handoff service. It is never read from an Appointment
Intent, tenant, database row, patient, or request body. This selects no
credential and authorizes no provider call.

The server-side commercial selector considers only `commercial_rules` with
`status = ACTIVE`, `commercial_rule_versions` with `status = APPROVED`, their
effective time range, and server-derived direct-booking scopes: provider
Doctor/Clinic, Service Offering, and `PATIENT_PROVIDER`. It then uses the
existing Phase 4 priority/ambiguity evaluator. No applicable rule or an
ambiguous highest-priority rule fails closed before allocation, payment-intent,
or bridge insertion; Step 4 never manufactures commercial values.

## Shared transaction composition

Step 4 must not call the existing `FinancialService.allocate()` or
`FinancialService.createPaymentIntent()` from an Appointment Intent
transaction, because each existing method owns its own transaction boundary.
Instead, a dedicated payment-handoff repository/service receives the
Appointment transaction's `PostgresExecutor` and performs allocation,
component, payment-intent, bridge, state-transition, and audit writes in that
one PostgreSQL transaction. The Phase 4 evaluator remains reusable as pure
calculation logic; the existing generic financial tables do not need a
redesign.

## Required reversible migration boundary

The existing schema is **not sufficient**: Appointment Intents currently lack
`PAYMENT_PENDING` and there is no relational booking-to-allocation/payment
link. One new reversible migration is required. It should:

1. create `appointment_financial_handoffs` with the four restrictive,
   individually-unique links above, actor/idempotency/fingerprint/audit
   timestamps, and no mutable business fields;
2. expand the Appointment Intent state `CHECK` and transition guard for only
   `SLOT_RESERVED → PAYMENT_PENDING` and the expiry path required by
   P5-PH-12;
3. add an Appointment Intent transition guard, deferred `PAYMENT_PENDING`
   invariant, bridge consistency/immutability guards, and the narrowly scoped
   `financial_allocation_components` update/delete immutability correction;
4. fail targeted DOWN safely if handoff records exist, rather than deleting
   financial or booking evidence.

The migration must not alter existing Phase 4 allocation, payment, ledger,
webhook, refund, settlement, or retention schemas beyond the narrowly scoped
allocation-component immutability enforcement.

## Explicitly deferred or prohibited

- Razorpay/live provider calls, checkout, credentials, provider order creation,
  webhooks, verification, and reconciliation processing.
- Payment or appointment confirmation; `payments` rows; refunds, settlements,
  ledger postings, adjustments, cancellation, rescheduling, and completion.
- Clinic→Doctor `BOOK`, Clinic→Clinic referral booking, shared capacity pools,
  UI, Firebase migration, and production deployment.
- Any commission percentage, tax, processing-fee, refund, settlement, or
  payout rule that is not already selected by approved Phase 4 policy data.
