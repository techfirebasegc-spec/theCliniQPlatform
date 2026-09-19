# theCliniQ Phase 5.8 — Network Booking and Clinic-to-Clinic Referral decision matrix

## Status and boundary

This is an **approved architecture package with implemented and verified
Phase 5.8 persistence/schema**. Runtime booking APIs, service-layer workflow,
provider operations, UI, and deployment changes remain deferred. It preserves
the already-approved Phase 2 network model, Phase 4 financial evidence, and
Phase 5 exposure, availability, appointment, cancellation/refund,
rescheduling, participant, and scheduling-mode decisions.

`OWNERSHIP != PATIENT-FACING EXPOSURE != NETWORK CAPABILITY != PATIENT CONSENT`.
No one of these concepts substitutes for another.

## P5.8-NB-01 — Clinic → Doctor delegated network booking

| Element | Proposed decision |
| --- | --- |
| Capability direction | `BOOK` is an active directional Doctor → Clinic grant on an accepted Clinic↔Doctor NetworkConnection. The Clinic consumes the grant only to request booking of that Doctor's own exposed service. |
| Complete authorization chain | Authenticated clinic actor → active tenant membership → required clinic permission → accepted Clinic↔Doctor connection → active directional `BOOK` grant → DoctorProfile currently `ACTIVE` and professionally `VERIFIED` → locked `PUBLISHED` doctor/service exposure → active applicable Offering/Version/Price → selected-mode availability → patient authority/consent → Appointment Intent → PostgreSQL capacity reservation → existing financial handoff. |
| Patient and actor separation | `patient_account_id` remains the patient and payer. `booking_actor_account_id` records the clinic Account that executes the delegated request. Provider, clinic, NetworkConnection, capability, authorization, and exposure context are server-derived and separately snapshotted. |
| Patient authority | A clinic must hold an active, scoped Patient authorization before it may create an external Doctor booking on the Patient's behalf. The authorization binds the patient, delegated clinic, external Doctor/service exposure, and approved scheduling/request scope; IDs supplied by the clinic never expand it. |
| Non-authority | `BOOK` alone cannot bypass patient authority, exposure publication, Doctor eligibility, Offering/Version/Price validity, availability, lead/horizon, capacity, Appointment authorization, or Phase 4 financial rules. `DISCOVER`, `CONTACT`, and `REFER` never authorize this booking. |
| Existing appointments | Revocation of `BOOK` after an Appointment Intent/Appointment is committed does not mutate or invalidate historical booking, financial, participant, or lifecycle evidence. A new reservation or reschedule revalidates live network authority. |

### Decision 1 — Patient delegated-booking authorization

**Status: APPROVED.** A Patient delegated-booking authorization grants one
named Clinic delegated authority to book one consultation on that Patient's
behalf, only within its immutable authorized scope. It does not transfer Patient
ownership, payer identity, provider ownership, appointment participation, or
financial authority.

| Element | Approved rule |
| --- | --- |
| Scope | The authorization binds exactly the Patient, delegated Clinic/Tenant, relevant independent Doctor/provider, Service Exposure, Service Offering, and scheduling context. The scheduling context includes the selected `FIXED_SLOT` exact request scope or `QUEUE` consultation-window scope as applicable. A material change to Patient, provider, service, exposure, scheduling mode/window, or requested booking scope requires a new authorization. |
| Expiry | Every authorization carries immutable `expires_at`, selected through a configurable/versioned policy. No universal duration is hard-coded. An expired authorization cannot create a new Appointment Intent or capacity reservation. |
| Single use | Default lifecycle is `ACTIVE → CONSUMED`, `ACTIVE → REVOKED`, or `ACTIVE → EXPIRED`. `CONSUMED`, `REVOKED`, and `EXPIRED` are terminal. A successful delegated booking consumes the authorization exactly once; every later booking requires a new authorization. |
| Identity separation | `patient_account_id` remains Patient and payer. `booking_actor_account_id` remains the authenticated Clinic Account/executor. The delegated authorization grants only bounded booking authority and cannot make the Clinic the Patient, payer, provider, or clinical participant. |
| Immutable evidence | Retain authorization creation and Patient-consent actor/timestamp, exact scope snapshot/fingerprint, policy/version and `expires_at`, consumption Intent/context and timestamp, and revocation actor/timestamp/reason category if revoked. The evidence is restrictive-retention, not mutable current permission state. |
| Audit | Append immutable business/audit events for creation, Patient consent/authorization, consumption, expiry, revocation, and every denied or conflicting consumption attempt. Metadata is identifier/outcome/safe reason category only. |
| Concurrency | PostgreSQL locks the authorization and applies a compare-and-set from unexpired `ACTIVE` to `CONSUMED` in the same transaction that creates the immutable network booking context, Appointment Intent, and capacity reservation. Two concurrent attempts cannot both consume it; a loser persists none of those booking records. |

The authorization cannot be used to change Patient, substitute provider/service,
expand exposure/scope, bypass availability, bypass Appointment authorization, or
bypass payment/financial rules. It supplements—not replaces—the active
directional `BOOK` grant and every other live booking revalidation.

## P5.8-NB-02 — Clinic → Clinic referral

`REFER` is an active directional Receiving Clinic → Referring Clinic grant on
an accepted Clinic↔Clinic NetworkConnection. It authorizes a bounded referral
workflow only; it is not `BOOK`, service exposure, patient consent, access to
clinical data, or an Appointment.

### Decision 2 — Clinic→Clinic Referral Lifecycle

**Status: APPROVED.** A referral has immutable `expires_at`, selected through a
configurable/versioned policy; no universal expiry duration is hard-coded. An
expired referral cannot be accepted or consumed. Expiry is an auditable,
terminal lifecycle transition with immutable evidence.

| From | To | Meaning | Actor / preconditions |
| --- | --- | --- | --- |
| New | `PENDING_PATIENT_CONSENT` | Referring Clinic has proposed a single-use referral; no destination booking authority exists. | Initiating clinic actor is currently authorized; accepted connection and active directional `REFER` grant are revalidated. |
| `PENDING_PATIENT_CONSENT` | `PENDING_RECEIVING_CLINIC` | Patient has supplied the required consent evidence for the exact referral scope. | Patient Account owns the PatientProfile and accepts the immutable proposed referral scope. |
| `PENDING_RECEIVING_CLINIC` | `ACCEPTED` | Receiving Clinic accepts the referral. | Receiving clinic actor is currently authorized within its tenant and the connection/capability remains valid. |
| `ACCEPTED` | `CONSUMED` | The referral is atomically bound to one destination booking context and Appointment Intent. | A valid patient-authorized referral booking commits capacity and the same transaction compare-and-sets the referral. |
| `PENDING_RECEIVING_CLINIC` | `REJECTED` | Receiving Clinic declines before acceptance. | Receiving clinic actor only; auditable and terminal. |
| `PENDING_PATIENT_CONSENT` or `PENDING_RECEIVING_CLINIC` | `WITHDRAWN` | Referring Clinic withdraws while pending, or Patient withdraws/revokes consent while the referral remains pending. | Authorized referring-clinic or Patient actor only; actor and safe reason/context are immutable/auditable. |
| `PENDING_PATIENT_CONSENT`, `PENDING_RECEIVING_CLINIC`, or `ACCEPTED` | `EXPIRED` | Referral reaches immutable policy-derived `expires_at` before consumption. | Transactional expiry/CAS; auditable and terminal. |

`CONSUMED`, `REJECTED`, `WITHDRAWN`, and `EXPIRED` are terminal. A referral is
single-use: only one `ACCEPTED → CONSUMED` compare-and-set may succeed, and no
transition can reopen, clone, or reuse it. Referral creation or acceptance
never itself creates an Appointment.

Once `ACCEPTED`, normal pending-state withdrawal and rejection actions are
forbidden. It may only proceed to `CONSUMED` or become `EXPIRED` according to
the approved policy/state machine; this decision introduces no post-acceptance
cancellation semantics.

At most one active pending referral may exist for the same Patient, referring
Clinic, receiving Clinic, and immutable referral-purpose/context fingerprint.
The future PostgreSQL design must enforce this across
`PENDING_PATIENT_CONSENT` and `PENDING_RECEIVING_CLINIC` with a guarded unique
constraint/index and a creation transaction. Concurrent matching creation
attempts deterministically yield one creation and one conflict. Terminal
historical referrals never prevent a legitimate new referral.

### Decision 3 — Receiving-Clinic Permission Boundary

**Status: APPROVED.** A receiving-clinic actor must satisfy both the active
Clinic→Clinic referral relationship requirements and an active membership in
the receiving Clinic's Tenant with the approved fixed role for the requested
action. `REFER` is relationship evidence only: it never grants every receiving
Clinic member unrestricted referral or booking authority.

| Actor | Approved authority |
| --- | --- |
| `CLINIC_OWNER` | May accept, reject, consume, and perform the resulting referral-driven booking within the receiving Clinic, after all referral, Patient, provider/service/exposure, scheduling/capacity, appointment, and financial checks pass. |
| `CLINIC_ADMIN` | Same receiving-clinic referral authority as `CLINIC_OWNER`, subject to active Tenant membership and all independent booking validations. |
| `CLINIC_STAFF` | No default authority to accept, reject, consume, or perform resulting referral-driven booking. This decision creates no staff grant mechanism and does not expand Staff authority elsewhere. |
| Doctor associated with the Clinic | No receiving-clinic referral authority merely by association or network participation. This decision creates no Doctor referral authority model. |
| Patient | May provide or revoke only their own referral consent under Decision 2; the Patient is never a receiving-clinic actor. |
| `PLATFORM_SUPPORT` / `PLATFORM_ADMIN` | No normal receiving-clinic referral authority. No support/admin exception mechanism is created or inferred. |

Referral acceptance or consumption never bypasses the independent Appointment
booking chain: Patient authorization, provider/service/exposure validation,
scheduling availability/capacity, appointment permissions, and financial/
payment rules remain mandatory. The resulting booking Clinic is operational
context, not an automatic clinical participant or visibility grant.

### Decision 4 — Clinic→Clinic Referral Privacy, Legal Disclosure, and Retention

**Status: APPROVED.** Referral workflow authorization, Patient consent,
Appointment authorization, clinical-data access, and payment/financial access
are separate boundaries. Referral existence is never broad healthcare-data
authorization.

| Boundary | Approved rule |
| --- | --- |
| Minimum receiving-clinic disclosure | The receiving Clinic may receive only the Patient identity/contact information required to process the referral and schedule the intended consultation, plus referring-Clinic identity, referral purpose/context, referral status, and booking information needed for that scheduling. No additional Patient information follows from referral existence. |
| Clinical data | A referral never grants automatic access to previous appointments, prescriptions, medical records/history, chat, files, diagnoses, or unrelated clinical information. A future sharing mechanism requires separate explicit Patient consent, authorization, and audit evidence; Decision 4 does not design it. |
| Referring-clinic visibility | The referring Clinic may access only referral information and lifecycle/status permitted by its own authorization boundary. Creation, acceptance, or consumption never grants access to the receiving Clinic's resulting Appointment, clinical records, chat, prescriptions, files, payment information, or other downstream Patient/clinical information. |
| Consent and revocation history | Patient consent is explicit and auditable. Pending-state revocation prevents later use under Decision 2, but never rewrites/erases prior consent, scope, consent/revocation time, or actions taken while the referral was valid. |
| Retention | Referral records use a configurable/versioned retention policy. On retention expiry, the configured outcome may be deletion, anonymization, or continued retention where legally required; no universal duration is hard-coded. Existing Phase 4 `legal_holds` override normal retention processing. |
| Audit evidence | Referral lifecycle and consent evidence remain auditable under the applicable retention/audit policy. Referral retention expiry never casually deletes append-only audit evidence. Decision 4 adds no new global audit-retention policy. |

## P5.8-NB-03 — Data model roles

| Entity | Purpose, ownership, and lifecycle | Immutable evidence / relationships | Authorization, uniqueness, and audit |
| --- | --- | --- | --- |
| `patient_clinic_booking_authorizations` | Patient-owned, explicitly scoped single-use delegated authority for a named Clinic to execute one external Doctor booking request. Lifecycle is `ACTIVE`, `CONSUMED`, `REVOKED`, `EXPIRED`; it is not a referral and does not create an Appointment by itself. | Restrictive FKs to Patient Account/Profile, delegated Clinic/Tenant, target DoctorProfile, Service Exposure/Offering, scheduling mode/context, configurable/versioned expiry policy, and consuming Intent/context. Snapshot exact allowed scope, Patient consent actor/time, `expires_at`, consumption, and revocation evidence. | Only Patient-owned authenticated authority may grant or revoke; Clinic reads only its active exact-scope authorization. A guarded single consuming Intent/context plus `ACTIVE → CONSUMED` CAS prevents reuse. Audit create/consent/consume/revoke/expire/denial without clinical content. |
| `network_booking_contexts` | Immutable authorization evidence attached to an externally initiated Appointment Intent. It is not a participant and not a substitute for financial evidence. | Restrictive FKs to Intent, delegated Clinic/Tenant, NetworkConnection, accepted directional `BOOK` capability/proposal, patient-clinic booking authorization, Service Exposure/Offering/Version/Price, selected scheduling mode, and relevant local/UTC or queue-window context. One context per network-created Intent. | Created only inside the authorized booking transaction after all live revalidation. `UNIQUE(appointment_intent_id)`; no update/delete after commitment. Audit creation and authorization denial. |
| `appointment_referrals` | Single-use Clinic→Clinic referral with initiating/referring Clinic, receiving Clinic, Patient, accepted `REFER` evidence, policy-derived `expires_at`, versioned retention policy, and states `PENDING_PATIENT_CONSENT`, `PENDING_RECEIVING_CLINIC`, `ACCEPTED`, `CONSUMED`, `REJECTED`, `WITHDRAWN`, `EXPIRED`. | Restrictive FKs to both Clinics/Tenants, Patient Account/Profile, NetworkConnection, accepted directional `REFER` capability/proposal, expiry/retention policy versions, initiating actor, receiving acceptance/rejection actor, referral consent evidence, eventual consuming Intent/context, and applicable legal hold. Immutable proposed scope/purpose fingerprint and transition timestamps; terminal records retained subject to approved retention processing. | Receiving actions require active `CLINIC_OWNER`/`CLINIC_ADMIN` membership plus relationship validation. One referral is consumed at most once (`UNIQUE` consuming Intent/context and CAS state guard). A partial unique invariant allows at most one matching pending referral. Audit every transition, expiry, withdrawal, rejection, consumption, retention processing, and denial. |
| `referral_consent_events` | Append-only Patient consent/decline/withdrawal evidence for one referral; it neither grants blanket clinic access nor creates an Appointment. | Restrictive FK to referral, Patient Account/Profile, event actor/time, immutable approved scope fingerprint, and optional safe reason category. No clinical payload. Consent/revocation evidence is retained auditable history even when it prevents future referral use. | Only the referral Patient may create Patient consent/decline/withdrawal evidence. `UNIQUE`/transition guard prevents conflicting active consent. Audit the event itself and rejected attempts; do not erase audit evidence solely because referral retention processing occurs. |

## P5.8-NB-04 — Scheduling, lifecycle, and financial integration

Network booking uses the service's already-approved scheduling mode; it never
creates a network-specific schedule.

### Decision 5 — Queue Scheduling Policy (APPROVED)

`FIXED_SLOT` and `QUEUE` are two scheduling modes of the one approved
Availability Foundation; they are not two availability systems. Queue policy
is provider/service-specific and versioned, so no universal patients-per-hour,
capacity, cutoff, duration, or operational value is introduced. A queue
booking records a provider-local consultation-window start/end with
server-derived UTC bounds, maximum capacity, deterministic server-assigned
position, and queue status. It does not promise a consultation start time.

PostgreSQL is the transactional authority for queue capacity and position. A
full queue is rejected deterministically, concurrent bookings cannot exceed
capacity or share a position, and Redis may only cache/support. Queue status
must distinguish at least booked/waiting, called/in-progress, completed,
cancelled, and no-show without replacing the authoritative Appointment
lifecycle. Position is immutable booking evidence except through a separately
auditable future operational action; a Patient cannot choose it. Authorized
providers/clinic operators advance queue progression only through normal
appointment lifecycle authorization. Existing cancellation/refund behavior
remains authoritative; any capacity release is transactional and preserves the
original position. A configuration change affects future eligibility only; it
does not mutate booked queue, Appointment, price, or financial evidence.
No-show timing, authority, release/advance, and financial
consequences remain future versioned-policy work. Estimated wait is derived
information, never a promised time, capacity authority, or financial fact.

- `FIXED_SLOT`: validate exact local request through the provider IANA timezone,
  availability exceptions, versioned duration/buffers, lead/horizon, and the
  existing PostgreSQL interval-capacity reservation model.
- `QUEUE`: validate the selected provider-local consultation-window start/end
  and server-derived UTC bounds, explicit maximum queue capacity and cutoff;
  PostgreSQL atomically reserves capacity and assigns one deterministic
  authoritative position. Queue status is a lifecycle-adjacent operational fact
  and cannot change the Appointment lifecycle. Estimated wait is derived only
  and never a guaranteed consultation time.

The normal lifecycle remains:

```
APPOINTMENT_INTENT → SLOT_RESERVED → PAYMENT_PENDING → CONFIRMED
→ IN_PROGRESS → COMPLETED
```

Existing `CANCELLED`, `EXPIRED`, `PAYMENT_FAILED`, reconciliation, and
rescheduling rules remain unchanged. A delegated clinic is booking context and
operational authority, not an additional clinical Appointment participant.
Existing Patient/Doctor/clinic operational participant/access boundaries remain
the only appointment access path.

The Patient remains payer. Existing Phase 4 commercial-rule selection,
Financial Allocation Snapshot, payment intent, payment facts, financial handoff,
and settlement eligibility remain authoritative. Network/referral metadata may
be included as server-derived booking-context evidence only; it cannot rewrite
allocation, price, payment, refund, or settlement facts. Settlement remains
eligible only after the existing Appointment completion boundary.

## P5.8-NB-05 — Concurrency, idempotency, and revocation

PostgreSQL is the sole transactional authority; Redis may cache only.

- `BOOK` is not consumed by booking. It is locked/revalidated as current
  authorization evidence at creation and again for a new reservation on
  reschedule.
- Booking-authorization grant/revoke, referral consent/withdrawal,
  receiving-clinic rejection/acceptance, expiry, consumption, and the selected
  fixed-slot or queue capacity authority use PostgreSQL row locking plus
  compare-and-set state transitions. Redis is never lifecycle or duplicate
  prevention authority.
- Matching pending-referral creation locks/checks the pending uniqueness scope
  transactionally. A concurrent loser returns deterministic conflict and leaves
  no referral, consent, booking, or audit-success residue.
- Referral consumption and capacity reservation succeed or roll back together;
  a losing concurrent consumer creates no partial Intent, context, capacity,
  financial handoff, or referral evidence.
- Queue position assignment occurs under the queue-window capacity lock, with a
  unique authoritative position and deterministic ordering defined by the
  future implementation. Two concurrent requests cannot exceed capacity or
  receive the same position.
- Idempotency is scoped to the Patient/booking actor and operation with a
  server-derived request fingerprint. Exact replay returns the original result;
  altered payload conflicts and never consumes a second referral/capacity.
- Reschedule creates new context only after revalidating the live required
  `BOOK`/referral authority, then secures new capacity before releasing old
  capacity. Existing committed appointments remain valid after later network
  revocation.

## P5.8-NB-06 — Visibility and audit

| Party | Minimum permitted visibility |
| --- | --- |
| Patient | Their own authorization, referral status/consent, appointment, and existing patient-visible booking facts. |
| Referring Clinic | Its referral metadata/status and its own audit evidence only; no implied destination clinical, appointment, payment, chat, prescription, or file access. |
| Receiving Clinic | Only the minimum referral/Patient/booking information necessary to process the referral and schedule the intended consultation; after valid consumption, destination Appointment visibility only through existing appointment-scoped operational authorization. No automatic historical/clinical-data access. |
| Doctor | Their own authorized appointment/participant context only. A Clinic connection/referral does not grant doctor broad Patient access. |
| Support/Admin | No implicit access. Any elevated support path remains deferred to the existing controlled-exception architecture. |

Append-only business/audit evidence is required for booking-authorization
create/revoke/expiry; network booking-context creation; Patient consent;
referral create/consent/accept/reject/withdraw/expire/consume; queue operations
when implemented; and every security-relevant authorization denial. Metadata
must contain identifiers, transition/outcome, and safe reason category only—no
secrets or unnecessary clinical data.

## Decision 6 — Exact Immutable Schema, Constraints, and Global Lock Order

**Status: APPROVED — persistence/schema implemented and verified; runtime
booking behavior remains deferred.** Decision 6 resolved the final Phase 5.8
design gate and its persistence migration implements the following schema and
transaction rules as one coherent design. It does not add runtime APIs or
replace an existing Phase 2, Phase 4, or Phase 5 authority with a network
shortcut.

### Required persistence model

| Entity/table | Exact responsibility and immutable evidence | Mutable lifecycle / retention boundary |
| --- | --- | --- |
| `patient_delegated_booking_authorization_policy_versions` | UUID primary key; immutable approved policy version selected at authorization creation. It records only validated, versioned expiry-policy data and effective dates; it never supplies a universal duration. | `DRAFT → APPROVED → RETIRED` is policy administration outside a booking transaction. An authorization references its selected version restrictively. |
| `patient_clinic_booking_authorizations` | UUID primary key. Restrictive FKs to Patient Account/Profile, delegated Clinic and Tenant, target DoctorProfile, Service Exposure, Service Offering, selected authorization-policy version, and (for `QUEUE`) its Queue Window. It stores a server-derived immutable scope fingerprint, scheduling mode, exact fixed interval or exact Queue Window, Patient-consent actor/time, immutable `expires_at`, and immutable consuming Intent/context references. | Only `status`, `consumed_at`, `consumed_by_account_id`, `revoked_at`, `revoked_by_account_id`, and a safe revocation reason category may change through guarded transitions. States are `ACTIVE`, `CONSUMED`, `REVOKED`, `EXPIRED`; the last three are terminal. No soft or hard delete. |
| `appointment_referral_policy_versions` | UUID primary key; immutable approved referral-expiry policy version/effective dates. A referral uses exactly one selected version and its derived immutable `expires_at`. | Policy lifecycle is separate from an existing referral and cannot rewrite it. |
| `appointment_referrals` | UUID primary key. Restrictive FKs to Patient Account/Profile, referring Clinic/Tenant, receiving Clinic/Tenant, NetworkConnection, accepted directional `REFER` capability and its accepted proposal, destination Service Exposure/Offering, selected referral-policy version, selected `retention_policy_versions` row, and eventual consuming Appointment Intent. Immutable rows capture the original parties, capability evidence, purpose/context fingerprint, destination scope, Patient identity, `expires_at`, creation actor/time, and retention-policy version. | Only state-transition fields and their actor/time/safe reason fields may change. States remain `PENDING_PATIENT_CONSENT`, `PENDING_RECEIVING_CLINIC`, `ACCEPTED`, `CONSUMED`, `REJECTED`, `WITHDRAWN`, `EXPIRED`; terminal states never reactivate. Normal deletion is prohibited. Retention processing is separately auditable and blocked by an active legal hold. |
| `referral_consent_events` | UUID primary key, restrictive referral and Patient Account/Profile FKs, consent event type, actor, occurrence time, immutable scope fingerprint, and optional safe reason category. It is append-only evidence, not an access grant. | No update/delete. Consent/revocation changes the Referral only through its guarded Referral transition in the same transaction. |
| `network_booking_contexts` | UUID primary key and `UNIQUE(appointment_intent_id)`. It is an immutable cross-boundary snapshot for one network-created Intent: Patient, booking actor/tenant, NetworkConnection, accepted proposal/capability, exposure/offering/version/price, scheduling mode, and exact fixed-slot or Queue Entry evidence. `booking_kind` is either `CLINIC_DOCTOR_DELEGATED` or `CLINIC_CLINIC_REFERRAL`. | No update/delete. Exactly one of `patient_clinic_booking_authorization_id` and `appointment_referral_id` is non-null, according to `booking_kind`; a restrictive FK prevents historical context loss. |
| `service_offering_version_queue_policies` | One immutable queue-policy row per Service Offering Version (`UNIQUE(service_offering_version_id)`). It contains validated maximum capacity and booking-cutoff configuration for that immutable version; provider/timezone derive from the Version/Availability Configuration rather than a client field. | No mutation after its Version is active; a future Service Offering Version supplies changed configuration. |
| `queue_windows` | UUID primary key and the authoritative capacity resource for one materialized bookable Queue consultation window. It restrictively references the queue policy, Availability Configuration, and Service Offering Version; it stores authoritative provider-local start/end and server-derived UTC start/end, maximum-capacity snapshot, cutoff snapshot, and creation evidence. | Window context and capacity snapshot are immutable. It is not a generated-slot cache and has no mutable availability counter. Normal delete is prohibited while referenced. |
| `queue_entries` | UUID primary key; `UNIQUE(appointment_intent_id)` and restrictive Queue Window/Intent FKs. It stores immutable Queue Window, maximum-capacity snapshot, position, booking actor/patient, and creation evidence. It is the durable queue booking evidence that later joins to the Appointment through its Intent. | `queue_status` and `capacity_status` are distinct guarded operational fields. Queue status is `WAITING`, `CALLED`, `COMPLETED`, `CANCELLED`, or `NO_SHOW`; capacity status is `ACTIVE` or `RELEASED` with release timestamp/reason evidence. Position, window, patient, and all scheduling context are never rewritten or renumbered. |

`appointment_intents` and `appointments` gain only restrictive references and
snapshots necessary to identify the selected scheduling mode, Queue Window and
Queue Entry where applicable, and one network booking context. Existing exact
fixed-slot fields remain authoritative for `FIXED_SLOT`; no second Appointment
or financial model is created for `QUEUE`.

### Required relational guards, indexes, and immutability

- All new primary keys are UUIDs; all historical/reference FKs use
  `ON DELETE RESTRICT`. No new network/referral/queue evidence is
  cascade-deleted or soft-deleted.
- Authorization guard: Patient Profile must belong to `patient_account_id`;
  delegated Clinic must belong to `delegated_tenant_id`; target Doctor,
  Exposure, Offering, Version, and Queue Window (if any) must be the same
  approved provider/service context. `FIXED_SLOT` requires its exact immutable
  approved UTC range and no Queue Window; `QUEUE` requires exactly one Queue
  Window and no fixed-slot scope. `expires_at` must equal the server-derived
  selected-policy outcome.
- Authorization single-use: `UNIQUE(consuming_appointment_intent_id)` plus a
  guarded `UPDATE ... WHERE status='ACTIVE' AND expires_at > current_timestamp`
  compare-and-set. A deferred context trigger verifies the consuming Intent and
  `network_booking_contexts` row match the stored immutable scope. Revoke and
  expire never reopen or replace consumption evidence.
- Authorization lookup index:
  `(delegated_clinic_id, patient_account_id, service_exposure_id, status,
  expires_at)` with an active-scope index on the immutable scope fingerprint;
  it supports the locked exact-scope lookup but is never an authorization
  substitute.
- Referral party/context guard: the Patient Profile belongs to the stored
  Patient Account; each stored Clinic belongs to its stored Tenant; referring
  and receiving Clinics differ; the connection is `CLINIC_CLINIC`; the stored
  `REFER` grant is directional **Receiving Clinic → Referring Clinic**, active
  when creation/acceptance/consumption requires it, and tied to its exact
  accepted proposal. The destination exposure/offering must match the receiving
  provider/service scope. A referral never substitutes an Appointment
  participant or payment authority.
- Referral duplicate index:
  `UNIQUE(patient_account_id, referring_clinic_id, receiving_clinic_id,
  purpose_context_fingerprint) WHERE status IN
  ('PENDING_PATIENT_CONSENT','PENDING_RECEIVING_CLINIC')`. Terminal referrals
  are deliberately outside this predicate. `UNIQUE(consuming_appointment_intent_id)` enforces one consumption.
- Referral lookup indexes are `(receiving_clinic_id, status, expires_at)`,
  `(referring_clinic_id, status, expires_at)`, and `(patient_account_id,
  status, expires_at)`; `network_booking_contexts` additionally indexes its
  immutable connection/capability and referral/authorization references for
  scoped audit and retention lookup.
- Referral transition trigger permits only the Decision 2 state matrix, checks
  expiry before acceptance/consumption, requires the appropriate append-only
  Patient consent evidence before `PENDING_RECEIVING_CLINIC`, and prevents all
  terminal-state reactivation. A deferred trigger verifies Referral,
  `network_booking_contexts`, and consuming Intent agree at commit.
- Consent-event trigger verifies exactly the Referral Patient can create the
  event; `BEFORE UPDATE OR DELETE` raises. The Referral transition—not a
  mutable consent flag—represents the current workflow state.
- Queue Window guard validates one Availability Configuration/Version/queue
  policy context, valid IANA-derived local/UTC conversion, same-day local
  bounds, positive maximum capacity, and a cutoff selected from the immutable
  policy snapshot. Caller-supplied UTC values may not diverge from the
  server-derived local-time result. Appropriate lookup indexes are
  `(service_offering_version_id, starts_at, ends_at)` and
  `(availability_configuration_id, starts_at, ends_at)`.
- Queue Entry guard verifies its immutable context against the Queue Window and
  Intent. `UNIQUE(queue_window_id, queue_position)` makes position unique for
  all historical entries, not merely currently active ones. A deferred
  capacity trigger rejects a transaction if the number of `ACTIVE` entries for
  a Queue Window exceeds its snapshotted maximum capacity. No mutable counter
  is used. Index `(queue_window_id, capacity_status, queue_position)` supports
  the locked count and deterministic next-position query.
- Queue checks require `queue_position > 0`, one recognized mode/status, and
  internally consistent `capacity_status`, release timestamp, and release
  reason category. Queue Window checks require `ends_at > starts_at`, local
  start/end on one provider-local date, positive maximum capacity, and a
  cutoff at or before its start. Every proposed evidence table has
  `created_at`; transition-bearing rows also carry their state-specific actor
  and timestamp. None accepts an independently client-authored derived UTC
  value.
- Queue-status guard allows only lifecycle-consistent progression: `WAITING`
  before delivery, `CALLED` only with `IN_PROGRESS`, `COMPLETED` only with
  `COMPLETED`, and `CANCELLED` only with `CANCELLED`. `NO_SHOW` is recorded
  only by a later approved no-show operation; it must not itself fabricate an
  Appointment transition, capacity release, or financial consequence.
- Existing `appointment_intent_context_guard`, Appointment context/event
  guards, participant completeness guards, committed-capacity guards, Phase 4
  immutable allocation/payment evidence, and directional-capability trigger
  remain in force. New guards validate by restrictive FK and deferred
  cross-table consistency; they do not duplicate or weaken those authorities.
- The Phase 5.8 migration must extend—not replace—the current
  `appointment_intents.booking_relationship` vocabulary with the explicit
  referral value `CLINIC_CLINIC`, add the selected scheduling-mode and
  Queue-Entry/Window references where applicable, and extend the existing
  Intent/Appointment context guards so those new snapshots exactly match the
  immutable `network_booking_contexts` and Queue evidence. The current
  `PATIENT_PROVIDER` and `CLINIC_DOCTOR` checks and all existing payment-pending
  guards remain unchanged.

### Retention reconciliation with Phase 4

There is one existing-schema conflict: Phase 4 currently restricts both
`retention_policy_versions.record_category` and `legal_holds.record_category`
to financial/audit/webhook categories and excludes `REFERRAL`. Decision 4
requires configurable referral retention and legal-hold override. The Phase
5.8 migration must therefore minimally extend those two existing `CHECK`
constraints with `REFERRAL`; it must not create a competing legal-hold system
or alter existing financial meanings. A Referral stores its selected approved
retention-policy version; retention processing verifies no active
`legal_holds(record_category='REFERRAL', subject_type='APPOINTMENT_REFERRAL',
subject_id=referral.id)` exists before its configured action. Consent and audit
evidence remain restrictive and auditable under that policy.

### Canonical transaction order

The existing common lifecycle prefix is preserved. The canonical order is
conditional: a transaction locks only resources it actually mutates or needs
to serialize, and never locks an immutable allocation snapshot merely to
validate it.

1. **Idempotency/duplicate key** — lock an existing actor-scoped idempotency
   row if present; otherwise rely on the matching unique index as the final
   race arbiter.
2. **Existing lifecycle prefix, when an existing Appointment is involved** —
   `Appointment Intent → Slot Reservation → Financial Handoff → Appointment →
   Payment Intent → Payment → Appointment Committed Capacity`. This is the
   current cancellation/refund and rescheduling prefix; immutable Allocation
   evidence is read/validated, not locked as a mutable target.
3. **Network relationship** — `NetworkConnection → active directional
   Capability → accepted Proposal evidence`. The Connection serializes
   capability revocation with network use; the accepted Proposal is immutable
   evidence and is only locked when its own lifecycle is being changed.
4. **Mutable workflow authority** — exactly one of delegated Booking
   Authorization or Referral, then the active Tenant Membership/eligible
   Doctor/Patient row required for the actor. This establishes fresh authority
   after relationship locking.
5. **Bookable configuration** — `Service Exposure → Service Offering Version
   → Availability Configuration → applicable versioned policy`. Offering/price
   and allocation records are validated according to existing immutable rules.
6. **Target capacity** — lock one Queue Window or the existing fixed-slot
   Version/Availability capacity serialization boundary. If a transaction
   needs more than one target capacity resource, sort by the stable tuple
   `(service_offering_version_id, starts_at, ends_at, resource_id)` before any
   capacity lock.
7. **New evidence and CAS** — create Intent/reservation/Queue Entry/context;
   apply guarded authorization/referral `→ CONSUMED` CAS only after capacity
   succeeds; append Appointment Event and business Audit in the same
   transaction; commit before notification, provider, or Redis work.

This normalizes Phase 5.8 without changing existing Phase 5 implementations:
direct reservation remains `Intent → bookable configuration → capacity`,
payment handoff remains `Intent → Reservation → Handoff → service/policy`,
payment confirmation remains persisted provider event then `Intent →
Reservation → Handoff → Appointment → Payment Intent`, cancellation/refund
retains its documented common prefix, and start/complete lock only the
Appointment before authorization/CAS. A network reschedule must retain its
existing source prefix before taking the network/workflow/configuration and
new-capacity groups; it secures new capacity before releasing old committed
capacity. No existing path holds a network workflow row while calling an
external provider.

### Required transaction, authorization, and concurrency behavior

| Operation | Locks / atomic result | Winner, loser, and retry semantics |
| --- | --- | --- |
| Clinic→Doctor delegated booking | Network relationship → authorization → membership/eligibility → exposure/configuration → target capacity; create context, Intent, capacity record, and `ACTIVE → CONSUMED` authorization CAS together. | One consumer wins. Same idempotency fingerprint replays; changed fingerprint or consumed/expired/revoked authority conflicts with no partial booking evidence. |
| Referral creation | Connection → active `REFER` → referring membership → pending-duplicate key; insert Referral and audit together. | Partial unique index admits one pending Referral; concurrent duplicate loses with conflict and may safely retry after terminalization. |
| Patient consent / referral accept, reject, withdraw, expire | Connection/capability only where live relationship is required, then Referral → actor's current Patient ownership or receiving/referring Membership; append consent/lifecycle evidence and Referral CAS together. | One permitted CAS wins; stale/pending-state mismatch returns conflict. A revoke racing acceptance serializes on Referral; whichever commits first determines terminal/next state. |
| Referral consumption | Existing prefix if present, then relationship → Referral → receiving Membership → exposure/configuration → target capacity; create context/Intent/capacity and `ACCEPTED → CONSUMED` CAS in one transaction. | One consumer wins; capacity failure, expired authority, or a loser rolls back every newly proposed record. |
| Queue booking | Workflow authority then Queue Window `FOR UPDATE`; derive authoritative active-entry count and next position, insert Queue Entry, Intent/reservation/context, and consumption CAS together. | Final capacity admits one winner; other callers receive deterministic conflict. Unique position and deferred capacity guard defend direct SQL and implementation error. |
| Fixed-slot booking | Same authority/configuration path, then existing Version/Availability fixed-slot serialization and capacity count; persist the ordinary Intent/reservation/context atomically. | Existing capacity conflict/replay semantics remain unchanged. |
| Cancellation | Existing common lifecycle prefix only, then current authorization revalidation, Appointment CAS, events/audit, and existing capacity/refund consequence. It does not lock or mutate a historical Referral/authorization. | Existing cancellation winner/loser semantics remain; a committed historical network context is never consumed again or rewritten. |
| Network/referral reschedule | Existing source prefix → live relationship/workflow revalidation → configuration → sorted new capacity resource(s); create successor/context then release source capacity last. | New capacity is secured first. A revoked/expired authority or capacity conflict leaves source, finance, and historical context intact. |
| Start / complete | Appointment lock → transaction-time Appointment authorization → Appointment CAS → immutable Appointment Event + Audit. Network/referral records are historical evidence and are not relocked. | Existing one-winner concurrency behavior and terminal-state protection remain unchanged. |

Initial authorization checks provide early denial. Every sensitive mutation
revalidates mutable authorization after its relevant row locks and immediately
before the state CAS. Tenant/Clinic/Doctor/Patient IDs supplied by callers are
never authority: they must match the locked network, membership, participant,
Exposure, and scope evidence. No transaction makes Razorpay/provider, network,
Redis, notification, or other external calls while PostgreSQL locks are held.

### Race matrix

| Concurrent case | Serialization primitive | Committed result / loser behavior | Retry |
| --- | --- | --- | --- |
| Matching Referral creation | Pending-referral partial unique index plus Referral-scope lock | One pending Referral and audit succeed; the other receives `CONFLICT` and has no residue. | Safe after a terminal outcome or with a nonmatching new scope. |
| Two acceptances or Patient revocation versus acceptance | `appointment_referrals` `FOR UPDATE` and guarded state CAS | First valid state transition determines `ACCEPTED` or `WITHDRAWN`; the stale action conflicts and creates no conflicting consent/event state. | Exact idempotent replay only. |
| Two Referral consumptions | Referral `FOR UPDATE`, `ACCEPTED → CONSUMED` CAS, and `UNIQUE(consuming_appointment_intent_id)` | Exactly one consumption may create context/Intent/capacity. The other conflicts with no partial financial or booking state. | Same idempotency fingerprint replays winner only. |
| Two delegated-authorization consumptions | Authorization `FOR UPDATE`, unexpired `ACTIVE → CONSUMED` CAS, and unique consuming Intent | Exactly one succeeds; other conflicts without an Intent, Queue Entry, Reservation, or financial residue. | Same fingerprint replays winner only. |
| Final Queue capacity / position | Queue Window `FOR UPDATE`, active-entry count, `UNIQUE(queue_window_id, queue_position)`, deferred capacity trigger | One final-capacity booking/position commits; the loser conflicts. No duplicate position or excess active capacity can commit. | Safe after cancellation/release only under existing transactional policy. |
| Referral consumption versus capacity failure | One transaction includes Referral/authorization CAS and capacity write | If capacity or any later write fails, transaction rollback leaves Referral `ACCEPTED` and authorization unconsumed. | Safe to retry while unexpired/authorized. |
| Cancellation versus a completed Referral consumption | Existing lifecycle prefix serializes cancellation of the newly created Appointment; Referral is historical after consumption. | Cancellation cannot undo/reforge consumption. It follows existing cancellation/refund rules and releases capacity only when that policy allows. | Existing cancellation idempotency semantics. |
| Reschedule versus another booking | Existing source prefix, then deterministically ordered target capacity resources | The capacity winner commits; a loser preserves the source appointment and all historical financial/network evidence. | Safe with the same reschedule fingerprint or a later available window. |
| Start/complete versus cancellation | Appointment `FOR UPDATE` plus appointment-status CAS and existing event guard | Exactly one permitted transition commits; the other returns stale/terminal conflict and appends no duplicate successful event. | Existing lifecycle retry semantics. |

### Failure and verification requirements

Each listed atomic operation rolls back all newly proposed authoritative rows
on a capacity, policy, authorization, state, event, audit, financial-handoff,
or constraint failure. A valid referral/authorization that cannot obtain
capacity remains unconsumed; an accepted referral does not itself reserve
capacity; payment/handoff failure cannot leave a consumed authorization,
consumed referral, Queue Entry, or partial financial context. Existing payment
and reconciliation behavior remains authoritative.

Future implementation verification must include: migration UP/DOWN and direct
SQL guard tests; restrictive-FK/tenant/provider/scope spoofing; policy/expiry
and terminal transition tests; append-only evidence tests; partial unique
pending-referral tests; delegated/referral single-use races; consent/revocation
and acceptance/consumption races; two-connection final Queue capacity and
position races; fixed-slot capacity regression; cancellation/consumption,
reschedule/booking, and start/complete/cancel races; transaction rollback when
event/audit/financial writes fail; deadlock/lock-cleanup checks; retention/legal
hold checks; and audit metadata checks. Unit tests cover pure scope/state
selection; API integration covers authorization/IDOR; real PostgreSQL tests
cover locks, constraints, races, migration, rollback, and direct SQL bypass.

## Phase 5.8 architecture approval status

Decisions 1–6 are approved. Phase 5.8 persistence/schema is implemented and
disposable-PostgreSQL verified. Runtime booking/referral APIs, service-layer
workflow, UI, and deployment remain deferred; persistence completion is not
full workflow completion.

## Explicitly deferred

Chat, prescriptions, files, clinical-data sharing, a tri-party clinical
participant model, payment-provider changes, settlement execution, UI,
production deployment, and any automatic booking created solely by a network
capability or referral are outside Phase 5.8 architecture approval.
