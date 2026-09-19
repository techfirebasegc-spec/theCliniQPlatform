# theCliniQ Phase 5.8 — Network Booking and Clinic-to-Clinic Referral plan

## Scope and implementation boundary

This plan is architecture only. Decisions 1–6 in the companion
[decision matrix](../decisions/phase5-network-booking-referral-decision-matrix.md)
are approved, but implementation remains pending. It must compose with, rather than replace, the current
direct Patient booking, Service Exposure, Availability, Appointment Intent,
Payment Handoff, Appointment Lifecycle, Cancellation/Refund, Rescheduling, and
directional Network Capability foundations.

It introduces no code, migration, route, UI, provider call, or deployment.

## 1. Clinic → Doctor delegated booking flow

The server—not a request body—derives each link in this chain:

```
authenticated clinic actor
→ active tenant membership + approved clinic permission
→ accepted Clinic↔Doctor NetworkConnection
→ active Doctor → Clinic BOOK capability
→ currently ACTIVE + VERIFIED independent DoctorProfile
→ PUBLISHED exposure owned by that Doctor
→ active Offering / Version / Price
→ selected FIXED_SLOT or QUEUE availability
→ active scoped Patient clinic-booking authorization
→ immutable network booking context
→ Appointment Intent + PostgreSQL capacity reservation
→ existing financial handoff
```

`patient_account_id` remains the Patient and payer. `booking_actor_account_id`
records the delegated Clinic Account that submitted the request. The Doctor (or
Clinic for its own services), Service Exposure, Offering/Version/Price, Tenant,
NetworkConnection, accepted proposal/capability, and scheduling context are
separately server-derived facts. Neither the connection nor a supplied ID
authorizes substitution of any of those facts.

The approved Patient delegated-booking authorization is single-use. It has an
immutable exact scope and policy-derived `expires_at`; its state is `ACTIVE`,
`CONSUMED`, `REVOKED`, or `EXPIRED`. It binds the Patient, Clinic/Tenant,
Doctor/provider, published Service Exposure/Offering, and selected mode's
fixed-slot request or queue-window scope. Any material scope change requires a
new Patient authorization. `ACTIVE → CONSUMED` happens only in the successful
booking transaction. An expired, revoked, consumed, forged, or scope-mismatched
authorization denies before any Appointment, capacity, payment, or financial
evidence is created.

A live `BOOK` grant is checked when a new network booking context is committed.
It is not consumed. The grant does not replace Patient authorization, service
exposure, availability, Appointment authorization, idempotency, or financial
validation. It must be revalidated for a replacement reservation during
rescheduling. Revocation after commitment never rewrites existing evidence.

## 2. Clinic → Clinic referral flow

```
PENDING_PATIENT_CONSENT
      ↓ Patient consent
PENDING_RECEIVING_CLINIC
      ↓ Receiving Clinic acceptance
ACCEPTED
      ↓ one successful booking transaction
CONSUMED
```

`REJECTED`, `WITHDRAWN`, and `EXPIRED` are terminal from the allowed
pre-consumption states; `CONSUMED` is terminal as well. The referral is a
consent-aware, single-use booking authorization candidate: it is not an
Appointment, a service exposure, `BOOK`, or clinical-data-sharing grant.
`REFER` must be an active Receiving Clinic → Referring Clinic capability when
the referral lifecycle operation requires it.

Decision 2 is approved: each referral has an immutable policy-derived
`expires_at`, never a universal hard-coded duration. The Referring Clinic may
withdraw only while either pending; the Patient may withdraw/revoke consent only
while pending; and the Receiving Clinic may reject only from
`PENDING_RECEIVING_CLINIC`. Each action is auditable with its actor and safe
reason/context. Once `ACCEPTED`, pending-state withdrawal/rejection is
forbidden; it can only be consumed once or expire under the policy. Expired
referrals cannot be accepted or consumed.

The future PostgreSQL model allows at most one matching active pending referral
for a Patient, referring Clinic, receiving Clinic, and immutable
purpose/context fingerprint. Terminal `REJECTED`, `WITHDRAWN`, `EXPIRED`, and
`CONSUMED` referrals do not block a legitimate new referral. Concurrent
matching creation is serialized so one wins and one conflicts.

Decision 3 is approved: only an active receiving-Clinic `CLINIC_OWNER` or
`CLINIC_ADMIN` may accept, reject, consume, or execute the resulting
referral-driven booking. `CLINIC_STAFF` has no default authority. A Doctor does
not obtain this authority through Clinic association; the Patient may only give
or revoke their own consent; and `PLATFORM_SUPPORT`/`PLATFORM_ADMIN` receives
no normal referral authority. The receiving actor must still satisfy both the
live `REFER` relationship and the applicable receiving-Clinic role boundary.
Neither acceptance nor consumption bypasses Patient authorization,
provider/service/exposure, availability/capacity, Appointment permission, or
financial/payment validation.

Decision 4 is approved: referral disclosure is limited to the Patient
identity/contact details required to process/schedule, referring-Clinic
identity, referral purpose/context and status, and necessary booking details.
Referral existence never grants the receiving Clinic prior appointments,
prescriptions, records/history, chat, files, diagnoses, or unrelated clinical
information. Any future clinical-data sharing needs separate explicit Patient
consent, authorization, and audit evidence outside this plan.

The referring Clinic retains only its authorized referral metadata/status and
audit evidence, never the receiving Clinic's resulting Appointment, clinical,
chat, prescription, file, payment, or other downstream Patient information.
Consent revocation prevents future pending use but preserves immutable consent,
scope, timestamp, revocation, and valid historical action evidence.

Referral retention must bind to a configurable/versioned policy, whose approved
outcome may be deletion, anonymization, or legally required continued
retention. Existing Phase 4 `legal_holds` override normal retention expiry.
This plan does not create a global audit-retention policy: referral audit and
consent evidence remains auditable under the applicable policy and is not
casually deleted with the referral record.

On consumption, the transaction validates the referral, Patient authority,
receiving provider/service exposure, selected scheduling mode, availability,
and capacity. It then creates the immutable referral/network booking context,
Appointment Intent, capacity reservation, and `CONSUMED` referral state as one
atomic outcome. Capacity conflict, authorization failure, expiry, or a losing
race rolls back all proposed new booking evidence.

## 3. Entity responsibilities and retention

The new entities proposed in the decision matrix supplement existing records;
they must not duplicate `service_exposures`, `network_connections`, accepted
network capability proposals/capabilities, Appointment Intent, Appointment,
Financial Allocation Snapshot, payment, or Appointment Participant facts.

- `patient_clinic_booking_authorizations` is Patient-owned single-use delegated
  authority, scoped to a specific Clinic/Tenant, external Doctor/provider,
  Service Exposure/Offering, and selected scheduling context. It carries an
  immutable policy-derived `expires_at`, is independently revocable/expirable,
  is consumed exactly once, and is restrictive-retention evidence.
- `network_booking_contexts` is one immutable context snapshot for a network
  booking Intent. It snapshots exact network/capability/proposal, delegation,
  provider/exposure/service/version/price, mode, and schedule evidence.
- `appointment_referrals` is a stateful, single-use Clinic→Clinic workflow. It
  records both Clinic/Tenant identities, Patient, `REFER` evidence, scope,
  policy-derived `expires_at`, transition actors/timestamps, and one consuming
  Intent/context. Its immutable purpose/context fingerprint is the pending
  duplicate-prevention scope, and it is bound to versioned retention/legal-hold
  architecture.
- `referral_consent_events` is append-only Patient consent/decline/withdrawal
  evidence. It is not a generic Patient record-access permission.

All foreign keys are restrictive. Context, consent, referral, and event
records must be append-only or transition-guarded, with terminal records never
reopened. No normal deletion may erase historical authorization or booking
evidence.

## 4. Scheduling and capacity integration

The provider/service's versioned scheduling mode controls the network booking:

| Mode | Network booking behavior | Authoritative capacity fact |
| --- | --- | --- |
| `FIXED_SLOT` | The request contains a candidate exact local appointment time; the server derives the UTC interval using approved IANA/DST rules and validates duration/buffers/exceptions. | Existing PostgreSQL fixed-slot interval reservation. |
| `QUEUE` | The request selects a provider-local consultation-window start/end with server-derived UTC bounds; it does not promise a consultation start time. The future runtime service validates the versioned cutoff, window, and exceptions. | Implemented PostgreSQL Queue Window capacity persistence, deterministic server-assigned position, and lifecycle-adjacent queue status. A full window is rejected deterministically. |

Both modes share the same Availability Foundation. Derived slots/windows and
Redis are advisory/read support only. Queue estimated wait is derived from
authoritative queue state, never an exact-time promise or booking authority.

### Decision 5 — Queue Scheduling Policy (APPROVED)

Queue configuration is provider/service-specific and versioned; there is no
global patients-per-hour rule. The authoritative queue booking evidence is the
consultation window, maximum capacity, assigned position, and queue status.
The server assigns positions deterministically under PostgreSQL concurrency;
patients cannot select them and historical position evidence is not casually
renumbered. Configuration changes affect future eligibility only and must not
mutate booked queue or Appointment evidence. Queue status must distinguish at least booked/waiting,
called/in-progress, completed, cancelled, and no-show without becoming a
second Appointment lifecycle.

Authorized delivering Doctors and the existing authorized clinic operational
boundary may advance/manage queue progression only through auditable,
appointment-scoped operations using normal lifecycle authorization; this gives
no new Clinic Staff authority. Existing cancellation/refund behavior remains
authoritative. Any capacity release is transactional and preserves original
queue evidence. The detailed no-show timing, authority, release/advance, and
financial policy remains a future configurable/versioned implementation
decision. Estimated wait remains derived information only.

## 5. Transaction, idempotency, and lock discipline

The implementation must document one global lock order before adding any
database objects. At a high level, booking creation locks the smallest required
authorization/context record, then the bookable service/configuration and
capacity authority, and finally persists the new Intent/reservation/context.
Post-intent operations retain the approved common `Appointment Intent → Slot
Reservation` prefix and payment-handoff locking conventions.

For Clinic→Doctor delegated booking, an implementation must lock the selected
authorization, require unexpired `ACTIVE` exact-scope evidence, and apply
`ACTIVE → CONSUMED` compare-and-set in the successful capacity-reservation
transaction. For referral creation and lifecycle, an implementation must lock/check
the pending uniqueness scope and use guarded state transitions. For referral
booking, it must serialize on the referral before capacity and use a guarded
`ACCEPTED → CONSUMED` compare-and-set only in the successful
capacity-reservation transaction. For queue booking, it must lock
the one queue-window capacity authority, count authoritative active consumers,
assign one unique deterministic position, and commit before external work.
For rescheduling, revalidate the live context, secure new capacity before old
capacity release, and use the approved deterministic capacity ordering whenever
two target capacity resources are locked.

Initial authorization checks provide early denial; transaction-time
revalidation occurs after the relevant locks and before state compare-and-set.
Idempotency must bind actor, operation, and server-derived request fingerprint.
An exact replay returns existing evidence; changed input conflicts; no retry
can consume a second referral or capacity unit.

No Razorpay/provider/network call occurs while PostgreSQL locks are held. The
existing financial handoff composes through the current executor and continues
to produce immutable allocation/payment evidence only after valid reservation.

### Decision 6 — exact implementation boundary (APPROVED)

The detailed entity/guard proposal is authoritative in the Decision 6 section
of the companion matrix. The implementation slice must add the following
without duplicating existing Appointment, financial, participant, exposure, or
network facts:

- immutable Patient delegated-booking authorization and policy-version evidence;
- immutable network booking context for one Intent;
- guarded Referral and append-only Referral consent evidence;
- one immutable queue policy per Service Offering Version, authoritative Queue
  Window capacity resource, and immutable Queue Entry position evidence;
- restrictive references from the selected Intent/Appointment context, rather
  than a second booking or financial model.

The precise canonical lock order is conditional by operation:

```
idempotency / duplicate key
→ existing Intent → Reservation → Handoff → Appointment → Payment Intent → Payment → committed capacity (when an existing Appointment exists)
→ NetworkConnection → active directional Capability → accepted Proposal evidence
→ delegated authorization OR Referral → active Membership / eligible actor record
→ Exposure → Offering Version → Availability Configuration → selected policy
→ sorted target capacity resource(s)
→ new evidence, guarded CAS, Appointment Event, Business Audit
```

Immutable Allocation, price, capability-proposal, and historical context rows
are validated, not made mutable lock targets. A new booking begins at the
network/workflow group because no existing lifecycle prefix exists. Existing
cancellation/refund, payment confirmation, rescheduling, and start/completion
paths retain their approved subsets of this order. Network rescheduling locks
the source prefix first, secures target capacity next, and releases old capacity
last. External provider, Redis, notification, and network calls occur only
after commit.

The implemented persistence migration uses restrictive FKs, partial unique
pending-Referral prevention, single-use authorization/referral CAS, deferred
cross-table consistency triggers, Queue Window `FOR UPDATE` capacity
serialization, unique historical Queue positions, and append-only historical
evidence. It extends the existing Phase 4 retention-policy and legal-hold
record-category checks to support `REFERRAL`; this remains a narrow
compatibility extension, not a second retention or legal-hold system.

## 6. Appointment, financial, and access boundaries

The network context enters the existing lifecycle without a new lifecycle:

```
APPOINTMENT_INTENT → SLOT_RESERVED → PAYMENT_PENDING → CONFIRMED
→ IN_PROGRESS → COMPLETED
```

Existing exception states, payment confirmation separation, cancellation/refund,
reschedule, capacity, and completed-settlement-eligibility rules remain
authoritative. The booking Clinic can be captured as operational context but is
not automatically an Appointment Participant or a clinical-data recipient.
Do not add a tri-party clinical-participant model.

Phase 4 remains untouched: the Patient is payer; price and allocation evidence
is immutable; network/referral facts are supplemental, server-derived input
evidence only; no network state changes historical allocation/payment/refund/
settlement records; and Appointment completion remains the only existing
settlement-eligibility fact.

Visibility is least-privilege: the referring Clinic sees only its referral
metadata/status and audit; the receiving Clinic receives only the minimum
referral/scheduling disclosure and destination Appointment visibility only via
existing appointment-scoped operational authorization after consumption. No
referral grants clinical records/history, chat, prescriptions, files, diagnoses,
or payment visibility. The Doctor sees only their existing participant/provider
context; the Patient sees their own records; Support/Admin has no implicit
access.

## 7. Required verification architecture

The implemented persistence slice includes focused migration and
two-connection PostgreSQL verification for database-enforced items below.
Future runtime booking/referral implementation must add unit and API tests for:

- each authorization link and cross-tenant/ID substitution denial;
- `BOOK` revocation before creation/reschedule versus historical booking
  preservation after commitment;
- approved Patient delegated-authorization exact scope, policy-derived expiry,
  revocation, single consumption, concurrent-consumption conflict, and replay;
- approved referral expiry, pending duplicate prevention, transition guards,
  receiving-clinic rejection, pending-only withdrawal/consent revocation,
  single consumption, and expiry/withdrawal/acceptance/consumption races with
  no partial booking outcome;
- fixed-slot and queue capacity contention; unique deterministic queue
  positions; no capacity excess; Redis unavailable/stale behavior;
- Appointment participants/access and referral visibility isolation;
- immutable network/referral/financial snapshots, audit coverage, and no
  external provider call under lifecycle/capacity locks.
- direct SQL rejection of invalid delegated scopes, Referral party/capability
  context, terminal reactivation, Queue local/UTC divergence, duplicate Queue
  positions, and Queue-capacity excess;
- rollback of every newly proposed network/context/Intent/capacity record when
  a later event, audit, financial handoff, or constraint write fails; and
- retention-policy and `REFERRAL` legal-hold preservation/override behavior.

Disposable PostgreSQL verification must prove migration UP/DOWN preserves prior
Phase 2, Phase 4, and Phase 5 objects and that direct SQL cannot bypass
authorization-context, referral, capacity, or immutable-evidence guards.

## Explicit exclusions

No chat, prescription, files, clinical data sharing, global Support/Admin
shortcut, tri-party clinical participant model, payment provider change,
provider settlement execution, UI, or deployment is included in Phase 5.8.
