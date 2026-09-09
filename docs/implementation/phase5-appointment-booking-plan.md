# theCliniQ Phase 5 — Appointment & Booking Foundation plan

## Status, scope, and locked decisions

This is planning only. It does not authorize code, migrations, booking APIs,
payment execution, Razorpay checkout, chat, prescription, files, Firebase work,
UI migration, or production deployment.

The following are locked: direct Patient→Doctor booking; Patient→Clinic booking
where a clinic exposes a bookable service/doctor; Clinic→Doctor booking only
through explicit bilateral `BOOK`; Clinic→Clinic only through a separately
approved referral and patient-consent workflow; Doctor→Doctor prohibited.
`DISCOVER` and `CONTACT` never imply `BOOK`; `REFER` remains separate.

**Decision 9 — Service Offering ownership and assignment is approved.** Every
Service Offering has exactly one owner: either its `owner_doctor_profile_id` or
its `owner_clinic_id`. PostgreSQL must use those explicit foreign keys and a
party-shape `CHECK` constraint to enforce exactly-one ownership; a generic
provider kind/id pair is not sufficient. A clinic may expose a doctor-owned
offering only through a later, explicit assignment/publication relationship.
That relationship has its own lifecycle and authorization and never transfers
ownership. Doctor-owned offering mutation requires authenticated Account
ownership of the DoctorProfile; clinic-owned mutation requires active tenant
membership and the approved tenant permission. ID substitution and
cross-tenant access are denied.

**Decision 10 — Availability configuration vocabulary is approved.** Offering
and availability configuration support versioned/configurable
`slot_duration`, `buffer_before`, `buffer_after`, `capacity`,
`booking_lead_time`, `booking_horizon`, `recurrence_rule`,
`provider_timezone`, and availability-exception type. This approves no
numeric/default/business values. Timezones are IANA identifiers; recurrence is
expressed in provider/clinic local time and resolved to UTC instants for actual
appointments. DST ambiguity/nonexistent-local-time handling remains an
availability implementation decision with mandatory test evidence. Neither
configuration nor derived slots is booking authority: PostgreSQL reservations
remain authoritative.

Services are provider-owned Service Offerings. A provider is a doctor or clinic.
Service pricing is versioned, provider-owned, and applies only to future
bookings; historical appointment context is immutable. theCliniQ's Phase 4
commercial-rule engine determines allocation. PostgreSQL is authoritative for
availability/reservation concurrency. Redis may cache but never decide it.

## 1. Final data model proposal — no migration

| Entity | Purpose and relationships | Required invariants |
| --- | --- | --- |
| `service_offerings` | Exactly one explicit owner: `owner_doctor_profile_id` or `owner_clinic_id`; service identity, status, publication/bookability, and lifecycle. | Both owner FKs exist and an exactly-one party-shape check is enforced. Ownership never transfers through clinic exposure; doctor/clinic authority is server-derived. |
| `service_offering_versions` | Immutable effective-dated version of configurable duration, buffers, capacity, lead/horizon, recurrence, IANA timezone, and price context. | Future bookings select one approved effective version; historical references never change. No numeric/default business values are implied. |
| `service_offering_prices` | Versioned provider-owned exact currency/minor-unit price input. | No floating point; one applicable approved price/version; Phase 4 computes allocation. |
| `availability_rules` / `availability_rule_windows` | Recurring working periods for an eligible offering/provider context in an IANA provider/clinic timezone. | Effective periods, approved recurrence vocabulary, configurable capacity, and status are validated; local periods are converted to UTC only when resolving appointments. |
| `availability_exceptions` | Configurable exception type (including leave, holiday, break, blocked period, or one-off override) for an offering/provider context. | Time range, precedence, actor, reason category, and audit are required. Exact exception vocabulary remains implementation/business configuration. |
| `availability_slots` | Optional bounded derived/read model of candidate availability. | Rebuildable cache only; never booking authority. |
| `slot_reservations` | Intent, offering/version, capacity units, UTC range, expiry, state, idempotency, and optional opaque token hash. | Active capacity cannot exceed approved capacity; expired records cannot consume capacity. |
| `appointment_intents` | Patient/profile, doctor/provider, offering/version, requested time/context, state, reservation, allocation/payment references, idempotency. | Patient ownership and approved booking context required; no confirmation by client. |
| `booking_context_snapshots` | Direct, clinic, or future referral context with Clinic/NetworkConnection/capability evidence captured at commitment. | Connection/membership is not broad patient access; referral requires consent. |
| `appointments` | Consumed reservation, immutable booking context, selected offering/price/allocation/policy references, primary state. | Created only from one consumed reservation; never overwrite historical context. |
| `appointment_participants` | Appointment, Account, role (`PATIENT`, `DOCTOR`, approved clinic-operational role), access scope. | Participant-scoped access; no arbitrary profile dereference. |
| `appointment_events` | Append-only state-transition and audit correlation history. | Actor, prior/next state, occurred time, non-sensitive metadata. |
| `appointment_cancellations` | Cancellation actor/category/reason/context, policy versions, refund/adjustment references. | No normal cancellation after `COMPLETED`; no caller-chosen refund value. |
| `appointment_reschedules` | Original appointment, new intent/reservation, actor/reason, old/new offering/price/allocation references. | New capacity secured before old capacity is released. |

Future appointment records reference a Phase 4 Financial Allocation Snapshot;
the snapshot references the selected commercial/refund/settlement policy
versions. It is never updated. Price changes create new offering versions and
affect future intents only.

## 2. Booking sequence and financial boundary

```
Service selection
→ Appointment Intent
→ server authorization + service/version validation
→ versioned provider price selection
→ slot reservation
→ immutable Phase 4 allocation snapshot
→ future payment intent
→ PAYMENT_PENDING
→ server verification + persisted provider webhook/reconciliation
→ CONFIRMED
```

An allocation snapshot is created after capacity is reserved and the exact
service/version/context price is committed, before the future payment intent.
It references: intent, patient, doctor/provider, offering/version/price,
currency, direct/clinic/referral context, clinic and NetworkConnection evidence
where applicable, selected commercial rule versions, refund/settlement policy
versions, and calculation timestamp. Payment references the allocation snapshot.

The provider client is never financial authority. Server verification, durable
webhook persistence, and Phase 4 reconciliation determine provider facts.
Payment success alone does not confirm an appointment or make settlement due.
An abandoned/expired payment releases capacity; a late-success/conflicting event
enters reconciliation and cannot resurrect an expired appointment automatically.

## 3. Exact authorization boundaries

| Scenario | Server-side authorization required | Explicit denial |
| --- | --- | --- |
| Patient→Doctor | Authenticated Account owns PatientProfile; active/eligible DoctorProfile; active bookable doctor-owned offering/version; availability capacity. | Other patient identity; inactive doctor/offering; tenant/network inference. |
| Patient→Clinic | Account owns PatientProfile; active clinic and clinic-owned bookable offering/version; selected doctor is eligible and authorized for the offering; capacity. | Clinic membership alone as patient authority; arbitrary clinic/provider substitution. |
| Clinic→Doctor context | Patient participation; authorized clinic actor through active membership and future appointment permission; active/eligible doctor; active bilateral `BOOK` evidence on Clinic↔Doctor connection; offering/version/capacity. | `DISCOVER`/`CONTACT` as booking permission; doctor tenant authority merely from connection. |
| Clinic→Clinic referral context | Patient participation/explicit consent; approved referral record; destination clinic authority; active bilateral `REFER` evidence; destination offering/doctor/capacity. | Source clinic viewing destination appointment/payment/chat/prescription data. |
| Appointment reads | Patient/doctor participant, or clinic actor with active membership and appointment-scoped operational permission. | Profile ID, tenant ID, clinic ID, appointment ID, or connection ID substitution. |
| Completion | Doctor participant; clinic owner/admin in clinic-owned appointment context. | Patient, clinic staff by default, support/admin by default. |
| Cancellation | Patient own eligible appointment; doctor participant; clinic owner/admin in clinic-owned context; controlled exceptional platform intervention. | Clinic staff by default; arbitrary refund selection; normal cancellation after completed. |

Context selection never grants authorization. Revalidate doctor/clinic/offering,
membership, network capability, and appointment participation at each sensitive
transition. Platform support/admin exceptional access remains fail-closed until
a separately approved, auditable global-role mechanism exists.

## 4. Appointment state transition table

| State | Allowed transitions | Actor | Prerequisites | Audit | Financial effect |
| --- | --- | --- | --- | --- | --- |
| `APPOINTMENT_INTENT` | `SLOT_RESERVED`, `CANCELLED`, `FAILED` | Patient / authorized system | Valid ownership, service/version/context | Every attempt and denial | None |
| `SLOT_RESERVED` | `PAYMENT_PENDING`, `EXPIRED`, `CANCELLED`, `RESCHEDULED` | Server / authorized canceller | Unexpired valid reservation | Hold/expiry/cancel audit | Allocation may be created at commitment; no payment fact yet |
| `PAYMENT_PENDING` | `CONFIRMED`, `PAYMENT_FAILED`, `EXPIRED`, `CANCELLED`, `RECONCILIATION_REQUIRED` | Server verification/reconciliation | Valid reservation and allocation; provider fact | Provider/state audit | Future payment intent only; never settlement |
| `CONFIRMED` | `IN_PROGRESS`, `CANCELLED`, `RESCHEDULED`, `RECONCILIATION_REQUIRED` | Authorized participant/system | Confirmed server-side facts | Transition audit | Cancellation/reschedule uses versioned policy/adjustment |
| `IN_PROGRESS` | `COMPLETED`, `CANCELLED`, `RECONCILIATION_REQUIRED` | Doctor, clinic owner/admin where clinic-owned | Participant/context/authority | Completion/cancel audit | No settlement execution |
| `COMPLETED` | `RECONCILIATION_REQUIRED` or controlled financial correction only | System / controlled financial workflow | Completion actor/state evidence | Immutable event + correction audit | Settlement becomes policy-evaluable; no normal cancel |
| `CANCELLED` | None; compensating correction only | Controlled financial workflow | Cancellation policy snapshot | Audit | Refund/adjustment/hold determined by policy |
| `EXPIRED` / `PAYMENT_FAILED` | `RECONCILIATION_REQUIRED` only for late/conflicting provider facts | System | Expiry/failure fact | Audit | Capacity released; no guessed refund |
| `RESCHEDULED` | Replacement appointment lifecycle | System after transactional reschedule | New reservation committed before old release | Old/new audit | Same price no added payment; higher/lower differences use new allocation/adjustment per policy |
| `RECONCILIATION_REQUIRED` | Controlled resolution only | Reconciliation workflow | Conflicting/ambiguous provider or financial facts | Audit | Blocks irreversible downstream effects |

Every state transition is append-only and auditable with actor, previous state,
resulting state, timestamp, and non-sensitive reason/context. Normal paths are
not reversible; corrections use compensating financial/appointment records.

## 5. Availability, capacity, and PostgreSQL strategy

Availability is IANA-timezone aware and supports recurring periods, working
periods, breaks, leave, holidays, blocked periods, and one-off exceptions. Slot
duration and buffer are Service Offering Version properties. Capacity-based
reservations are mandatory: no capacity-one assumption.

For each reservation/reschedule transaction:

1. Lock the AppointmentIntent or appointment with `SELECT … FOR UPDATE`.
2. Resolve the effective offering/version, availability rules, exceptions, and
   timezone into the requested UTC range.
3. Lock the relevant capacity bucket/range and reject inactive doctor, clinic,
   offering, membership, or required network authorization.
4. Enforce active-reservation/confirmed capacity with PostgreSQL range
   exclusion plus capacity accounting, or an equivalent normalized locked
   capacity ledger proven by concurrency tests.
5. Insert the idempotent reservation and expiry; atomically consume/release it
   only through valid state transition.
6. On reschedule, secure and persist new capacity first; only then release old
   capacity and append old/new events in the same transaction.

Expiry is checked in PostgreSQL on every action. A worker may release expired
reservations, but is not correctness authority. DST ambiguity/nonexistence,
timezone conversion, capacity boundaries, and concurrent reservation/reschedule
behavior require PostgreSQL and timezone test evidence.

## 6. Idempotency requirements

| Operation | Idempotency scope | Required result |
| --- | --- | --- |
| Appointment Intent creation | Patient Account + operation + client key | Same valid request returns original intent; changed payload conflicts. |
| Slot reservation | Intent + operation/key + requested capacity/range | One active reservation or deterministic conflict. |
| Confirmation | Appointment/intent + provider/internal event identity | Replay does not create another appointment or consume capacity twice. |
| Cancellation | Appointment + cancellation operation/key | One cancellation outcome and policy evaluation; replay returns it. |
| Reschedule | Appointment + operation/key | One replacement attempt; concurrent requests serialize. |
| Payment intent creation | Phase 4 provider + idempotency key + allocation snapshot | Existing Phase 4 idempotency boundary; no duplicate provider order. |

Idempotency keys are opaque, server-validated, retained per approved policy,
and never authorize access by themselves.

## 7. Approved architecture, remaining decisions, and coding prerequisites

Service Offering ownership/assignment architecture and the availability
configuration vocabulary are approved. They do **not** approve offering
publication/moderation, clinic exposure of a doctor-owned offering, or concrete
configuration values. The later assignment/publication relationship must be
explicit, lifecycle-managed, and separately authorized; it must not alter the
Service Offering owner.

Before the applicable implementation slice, approve: concrete configurable
availability values and recurrence/holiday/exception vocabulary; offering
publication/moderation and clinic-doctor offering assignment policy; booking
and referral capability workflow details; cancellation timing/refund
percentages/fees/taxes; exceptional platform support model; home-visit address
eligibility/privacy; legal/accounting/provider effects of
reschedule/cancellation; historical Firebase mapping scope; and deployed legacy
callable contract reconciliation. Availability implementation must also choose
and test the DST ambiguity/nonexistent-local-time policy without silently
inventing it.

## 8. Testing gates and reviewable implementation sequence

1. **Service Offering foundation:** explicit doctor-or-clinic ownership,
   version/effective-date lifecycle, exact minor-unit price tests, and
   ownership/tenant-authorization isolation. It does not implement clinic
   assignment/publication, availability, or booking.
2. **Availability foundation:** recurrence/exceptions/timezone/DST unit tests;
   capacity/overlap PostgreSQL tests.
3. **Intent/reservation:** API authorization/IDOR/idempotency, expiry, locked
   capacity, concurrency/race integration tests.
4. **Appointment lifecycle:** participant isolation, direct/clinic contexts,
   capability revalidation, append-only events, completion authority tests.
5. **Cancellation/reschedule:** policy snapshots, same/higher/lower-price
   financial boundaries, old/new capacity ordering, payment race tests.
6. **Integration gates:** Phase 4 allocation/payment-boundary tests,
   webhook-before-client/late-event reconciliation tests, no live Razorpay.
7. **Verification gates:** disposable PostgreSQL migration UP/DOWN and
   concurrency tests; API security tests; Playwright UI-parity baselines for
   legacy booking/login/payment-pending/cancel/reschedule states.

No step may advance without prior review, passing Phase 2/4 regressions, and
explicit approval for the corresponding unresolved decisions.
