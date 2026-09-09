# theCliniQ Phase 5 Step 3 — Appointment Intent & Slot Reservation Foundation plan

## Scope

Implement only an immutable appointment intent and short-lived PostgreSQL slot reservation. The successful Step 3 boundary is `APPOINTMENT_INTENT → SLOT_RESERVED`; it does not create `PAYMENT_PENDING`, a confirmed appointment, payment provider facts, generated slots, or Redis authority.

## Database design

Create one reversible migration, proposed as `20260913000000_phase5_appointment_intent_reservations.js`.

### `appointment_intents`

UUID PK; `patient_account_id`, `booking_actor_account_id`, optional `booking_tenant_id`; exactly-one provider doctor/clinic FK; Offering and Offering-version FKs; copied immutable price currency/minor-unit; provider timezone; authoritative requested local timestamp; server-derived `starts_at`/`ends_at` UTC; duration/buffer/validated-hold-seconds snapshots; booking relationship/capability snapshot; state, expiry, request fingerprint, idempotency key, creator/time and lifecycle timestamps.

Constraints: provider XOR; positive/non-empty interval; approved state vocabulary; unique `(booking_actor_account_id, idempotency_key)`; restrictive deletion; indexes for patient, provider, version, state/expiry, and tenant isolation. Snapshot fields cannot update after a reservation exists; state transition trigger permits only the minimum transitions.

### `slot_reservations`

UUID PK; unique `appointment_intent_id`; immutable `service_offering_version_id` capacity key; `starts_at`, `ends_at`, requested capacity units, status, `expires_at`, created/released/expired timestamps and actor audit FKs. `HELD` is the only consuming status, and an expired hold is treated as non-consuming in every capacity query.

No `appointment_intent_events` table is needed: existing append-only `audit_events` records lifecycle and denial facts.

## Capacity and transaction design

The canonical Step 3 capacity identity is `service_offering_version_id`, not merely provider/time. It safely captures service-specific duration, buffers, and capacity frozen by the immutable version/configuration. Shared provider capacity across offerings is explicitly unsupported until a capacity-pool model is approved.

Within one PostgreSQL transaction:

1. authenticate/authorize before entering the transaction;
2. lock the applicable Offering version and Availability Configuration parent in deterministic UUID order;
3. revalidate active version/configuration, IANA timezone, lead/horizon, Step 2 availability/exclusions, provider eligibility, network/capability and idempotency;
4. query existing non-expired `HELD` reservations for the same version and overlapping UTC range under the parent lock;
5. sum capacity units and reject if adding the request exceeds configuration capacity;
6. insert intent and hold, append audit fact, commit.

This serializes same-version contention: capacity 1 permits one success; capacity 2 permits two. No external call happens while locks are held. Future rescheduling locks old/new capacity keys in ascending UUID order, secures the new hold, then releases the old hold.

## Time and expiry

The service accepts only provider-local request time. It invokes the existing Step 2 recurrence/timezone logic to resolve UTC using provider IANA timezone, rejects contradictory client UTC, honors lead/horizon, duration, buffers, breaks, holidays, leave, blocked and one-off rules, skips spring gaps, and selects earlier fall occurrence.

Validated hold seconds are copied from the Service Offering Version at creation. `expires_at` is calculated as `reservation_created_at + configured_hold_seconds` and evaluated against `current_timestamp` inside every consuming-capacity query. A worker may transition stale rows but correctness never depends on it. Expired/released holds cannot return to `HELD`; late payment is a future reconciliation concern and cannot resurrect capacity.

## Authorization

Use server session authentication and existing tenant/network authorization only. A Patient may create an intent for a bookable service explicitly exposed by the selected Doctor or Clinic without a network connection, after server-side validation of patient authorization, provider eligibility, active Offering/version, explicit service exposure, availability, and lead/horizon. Provider/service IDs alone grant nothing, and clinic context never implicitly exposes a doctor-owned service. Clinic→Doctor requires active Clinic→Doctor connection, both parties’ active bilateral `BOOK` consent, doctor Account/Profile eligibility, and bookable active Offering/version/availability. Clinic→Clinic is excluded pending referral/patient-consent model. Doctor→Doctor always denies. DISCOVER and CONTACT never authorize booking. IDs are scoped at repository/service boundaries.

## API boundaries

Proposed routes: `POST /v1/appointment-intents` (idempotent create/hold), `GET /v1/appointment-intents/:id` (actor/provider scoped), and `POST /v1/appointment-intents/:id/cancel` (release only). Do not expose payment, appointment, reschedule, slot-generation, or public provider-management routes in this step.

## Implementation sequence

1. Add migration, state/immutability guards, indexes, and migration contract tests.
2. Add availability-evaluation adapter; do not duplicate Step 2 logic.
3. Add intent/reservation repository using parameterized PostgreSQL and locked transaction boundary.
4. Add authorization/idempotency/audit service and thin routes.
5. Add unit/API/concurrency tests and disposable verification SQL.

Expected files: migration; `api/src/modules/appointments/{appointment-intents.ts,postgres-appointment-intent-repository.ts}`; `api/src/routes/appointment-intents.ts`; `api/src/app.ts`; focused API/migration tests; verification markdown/SQL.

## Verification and rollback

Disposable PostgreSQL verification must prove UP, direct SQL constraints, capacity 1/2 concurrent contention, expiry/release non-consumption, idempotent retry/conflict/concurrent same key, transition guards, local/UTC DST behavior, authorization/network denials, and audit. Targeted DOWN removes only Step 3 objects while preserving Phase 2, Phase 4, and Phase 5 Steps 1–2 tables. Rollback must fail safely if later payment/appointment migrations depend on these records.

## Explicit exclusions and deferred work

Payment/Razorpay/webhooks/refunds/settlement/reconciliation/ledger, appointment confirmation/lifecycle, generated slots, Redis authority, Clinic→Clinic referral booking, assignment-publication, shared capacity pools, UI, and deployment are outside Step 3.
