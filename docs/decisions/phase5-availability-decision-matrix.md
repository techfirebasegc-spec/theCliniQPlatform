# theCliniQ Phase 5 Step 2 — Availability Foundation decision matrix

## Scope and status vocabulary

This is planning only. It authorizes no application code, migration, schema,
route, test, UI, booking, payment, appointment, Firebase, or deployment work.
It preserves Phase 2 authorization/network rules, Phase 4 financial authority,
and Phase 5 Decisions 1–10.

- **APPROVED** — locked by the approved Phase 5 model or prior decision.
- **OPEN** — needs a bounded business or implementation decision; no value or
  behavior is inferred here.
- **BLOCKED** — cannot be implemented safely until the identified prerequisite
  is approved. Where data/configuration is ambiguous, the future system must
  fail closed.
- **DEFERRED** — an approved future concern that is intentionally outside the
  configuration-only Step 2 scope.

## A. Availability ownership and lifecycle

| Decision | Proposed rule | Status | Why / downstream impact | Required tests |
| --- | --- | --- | --- | --- |
| Doctor-owned availability | Availability belongs to a doctor-owned Service Offering and is managed only by the Account that owns its DoctorProfile. | **APPROVED** | Preserves independent-doctor ownership; no tenant membership is required for the direct doctor path. | Doctor ownership, impersonation/IDOR, inactive context denial. |
| Clinic-owned availability | Availability belongs to a clinic-owned Service Offering and is managed through active tenant membership with existing `clinic.manage`. | **APPROVED** | Reuses the Step 1 ownership and Phase 2 authorization boundary. | Owner/admin allowed; staff/patient/cross-tenant denied. |
| Clinic exposure of doctor availability | A clinic cannot expose, alter, or book a doctor-owned schedule merely through a clinic context. Exposure requires a future explicit assignment/publication relationship and does not transfer ownership. | **APPROVED** | Decision 19 deliberately defers the assignment/publication implementation while preserving doctor ownership. | Future assignment lifecycle and tenant/doctor authority tests. |
| Tenant-specific doctor schedules | No tenant-specific doctor schedule is created in the foundation; it is deferred to the future assignment/publication relationship. | **APPROVED** | Decision 19 prevents tenant context from becoming implicit doctor-schedule authority. | Future isolation and revocation tests. |
| Create/update/activate/deactivate | Same owner boundary as the Service Offering; lifecycle actions are audited. `clinic.manage` is required for clinic-owned availability. | **APPROVED** | Context selection alone never authorizes a change. | Authenticated ownership, membership revocation, status transition, audit-denial tests. |

## B. Recurring schedule vocabulary

| Decision | Proposed rule | Status | Why / downstream impact | Required tests |
| --- | --- | --- | --- | --- |
| Working period / break | Working periods establish candidate local-time periods; breaks subtract candidate time. Working and break periods must not overlap or duplicate; adjacent periods are allowed. A break must be contained within applicable working availability, and ambiguous relationships are rejected. | **APPROVED** | Decision 13 preserves deterministic availability without implicit capacity changes. | Overlap/duplicate rejection, adjacency, containment, and ambiguity tests. |
| Recurrence rule representation | Use a controlled RFC 5545-style recurrence representation. Initial support is weekly recurrence, selected weekdays, and effective dates only; malformed or unsupported recurrence is rejected. | **APPROVED** | Decision 11 provides a bounded grammar and excludes arbitrary monthly/yearly complexity. | Malformed/unsupported rejection, weekly expansion, selected-weekday, and effective-boundary tests. |
| Local start/end and day of week | Recurrence is authored in provider/clinic local time with local start/end and day-of-week semantics. | **APPROVED** | Required to preserve human-authored schedules across UTC offsets. | Local-to-UTC conversion and weekday boundary tests. |
| Effective period | Rules have timezone-aware `effective_from` and optional `effective_to`; invalid ranges fail validation. | **APPROVED** | Historical configuration must not be silently rewritten. | Adjacent ranges, invalid ranges, historical read tests. |
| Overnight periods | Overnight periods are not supported in the initial Availability Foundation. Every availability window must remain within one provider-local calendar day. | **APPROVED** | Decision 12 removes ambiguous weekday and DST-crossing ownership. | Cross-midnight rejection tests. |
| Overlapping working periods | Overlapping and duplicate working periods are rejected; adjacent working periods are allowed. | **APPROVED** | Decision 13 prevents duplicate candidate time and implicit capacity changes. | Duplicate/overlap rejection and adjacency tests. |
| Overlapping breaks | Overlapping and duplicate breaks are rejected; adjacent breaks are allowed. Breaks must be contained within applicable working availability. | **APPROVED** | Decision 13 keeps subtraction deterministic. | Duplicate/overlap rejection, adjacency, and containment tests. |
| Schedule duration limits | No arbitrary business minimum/maximum duration is approved or hard-coded. Any operational bounds remain configurable policy. | **DEFERRED** | Decision 14 prohibits embedded business maxima; values are not needed to model the foundation. | Configured-boundary tests when policy values are approved. |

## C. Exceptions

| Decision | Proposed rule | Status | Why / downstream impact | Required tests |
| --- | --- | --- | --- | --- |
| Exception categories | Leave, holiday, blocked period, and one-off availability are supported categories; break remains a recurring schedule subtraction. | **APPROVED** | Matches the approved model without inventing values. | Category validation and audit tests. |
| Exception precedence | Apply deterministic precedence: recurring working periods, breaks, holidays, leave, blocked periods, one-off availability, then existing reservations. One-off availability cannot override breaks, holidays, leave, blocked periods, or reservations. | **APPROVED** | Decision 15 keeps exclusions and reservation consumption authoritative. | Precedence and one-off-non-override tests. |
| Overlapping exceptions | Same-precedence conflicts fail closed/reject; the system must not silently choose an exception. | **APPROVED** | Decision 15 requires deterministic conflict handling. | Same-range and partial-overlap rejection tests. |
| Exceptions overriding recurrence | Leave, holiday, and blocked periods override recurring availability. | **APPROVED** | A conservative subtraction rule prevents accidental availability. | Override and effective-period tests. |
| One-off availability outside working time | One-off availability is an explicit additional working window and may add time outside recurring working periods. It uses the provider IANA timezone, must remain within one local day, may not overlap or duplicate another one-off window, and may not be in the past at creation. It cannot override higher-priority exclusions or mutate existing reservations. | **APPROVED** | Decision 16 authorizes additive configuration with deterministic safety and audit controls. | Timezone, same-day, overlap/duplicate, past-window, future-only, precedence, and audit tests. |

## D. Service configuration validation

| Decision | Proposed rule | Status | Why / downstream impact | Required tests |
| --- | --- | --- | --- | --- |
| Configuration fields | Slot duration, buffers, capacity, booking lead time, and booking horizon are provider configuration carried by immutable Service Offering versions. | **APPROVED** | Locked by Decision 10; no mutable current configuration may rewrite historical context. | Version reference/immutability tests. |
| Units and data types | Durations are stored as integer seconds; capacity is an integer. | **APPROVED** | Decision 14 provides exact canonical representation without selecting business values. | Exact-unit, serialization, and overflow tests. |
| Zero/negative values | `slot_duration > 0`, `buffer_before >= 0`, `buffer_after >= 0`, `capacity > 0`, `booking_lead_time >= 0`, `booking_horizon > 0`, and `booking_horizon` must exceed `booking_lead_time`. | **APPROVED** | Decision 14 gives field-specific validation without a business duration/capacity value. | Per-field zero/negative and horizon/lead relationship tests. |
| Maximum values | No arbitrary business maxima are hard-coded; any maximum remains configurable. | **DEFERRED** | Decision 14 intentionally separates policy values from the foundation schema. | Configured maximum boundary tests when values are approved. |
| Versioning | Configuration changes create a new Service Offering version; historical versions/prices remain immutable. | **APPROVED** | Preserves future appointment context and Step 1 immutability. | New-version selection and historical retrieval tests. |
| Active version mutation | An active Service Offering version is not changed in place. | **APPROVED** | The existing Step 1 database trigger already enforces immutable versions. | Direct UPDATE/DELETE rejection and superseding-version tests. |

## E. Timezone and DST

| Decision | Proposed rule | Status | Why / downstream impact | Required tests |
| --- | --- | --- | --- | --- |
| Timezone identifier | Use validated IANA timezone identifiers. | **APPROVED** | Required for deterministic local recurrence and DST behavior. | Invalid/unknown zone rejection. |
| Timezone source and history | Provider timezone is versioned configuration for the relevant offering/availability context; changing it creates a later version rather than rewriting historical instants. | **APPROVED** | Preserves historical schedule interpretation and appointment evidence. | Timezone-version and historical-read tests. |
| Nonexistent local time | A spring-forward nonexistent local occurrence is skipped. | **APPROVED** | Explicitly locked by the approved availability model. | Spring-forward skip test. |
| Ambiguous local time | A fall-back ambiguous local occurrence resolves to the earlier occurrence. | **APPROVED** | Defines deterministic fold selection. | Fall-back earlier-fold test. |
| UTC conversion | Candidate/reservation/appointment execution uses timezone-aware UTC instants derived from local recurrence. | **APPROVED** | Avoids local-time ambiguity in transactions. | Local/UTC round-trip and offset-change tests. |
| TZDB/version policy | Runtime timezone-library/TZDB version recording is not selected. | **DEFERRED** | It may be needed for reproducing historical calculations across rule changes, but is not required for the configuration-only foundation. | Reproducibility tests if approved. |

## F. Slot generation and caching

| Decision | Proposed rule | Status | Why / downstream impact | Required tests |
| --- | --- | --- | --- | --- |
| Calculation inputs | Active offering version/configuration, approved recurring rules, exceptions, IANA zone, requested horizon, and current reservation state are inputs. | **APPROVED** | Candidate calculation never replaces reservation validation. | Deterministic input snapshot tests. |
| Calculation horizon | Candidate generation, when implemented later, uses the versioned booking horizon and never a fallback/default. | **APPROVED** | Decision 14 provides the configured field and requires it to exceed lead time. | Configured horizon boundary tests. |
| Determinism and slot identity | Equivalent inputs must produce equivalent candidate instants; concrete slot ID/identity representation is not selected. | **DEFERRED** | This is required for a future read model/client reconciliation, not configuration persistence. | Stable identity and recomputation tests. |
| Capacity representation | Candidate capacity is derived/display-only; PostgreSQL reservation state decides actual capacity. | **APPROVED** | Prevents stale slot rows from authorizing bookings. | Stale-candidate and capacity-race tests. |
| Collision handling | Candidate collisions or ambiguous derived results fail closed. | **APPROVED** | No silent selection is permitted. | Collision rejection tests. |
| Persistence versus calculation | Persisted/materialized candidate slots versus calculation-on-demand is intentionally deferred. | **DEFERRED** | Decision 17 prohibits any persistent generated-slot table from becoming transactional authority. | Rebuild, invalidation, and parity tests. |
| Redis and invalidation | Redis may cache derived results only. Cache invalidation/rebuild must not grant a reservation or override PostgreSQL. | **APPROVED** | Redis is never transactional/authorization authority. | Stale-cache, outage, and rebuild tests. |

## G. Reservation boundary (future implementation)

| Decision | Proposed rule | Status | Why / downstream impact | Required tests |
| --- | --- | --- | --- | --- |
| Candidate to reservation | A candidate slot is advisory; reservation revalidates configuration, authorization, current time, and capacity in PostgreSQL. | **APPROVED** | Prevents client/cache authority. | Stale candidate and forged slot tests. |
| Transaction and locking | Reservation/reschedule operations use PostgreSQL transactions and lock rows/ranges in a documented global order. | **APPROVED** | Required for race safety; concrete capacity structure remains open. | Concurrent reserve/cancel/reschedule tests. |
| Capacity enforcement | Capacity belongs to the Service Offering version and reservations consume capacity units. PostgreSQL transactionally enforces capacity; Redis may cache but never decide validity, and no persistent generated-slot table is transactional authority. | **APPROVED** | Decision 17 locks the authority boundary while deferring the physical ledger/range implementation to reservation work. | Capacity >1, overlap, and contention tests. |
| Expiry | Expired reservations release capacity; expiry is rechecked transactionally on every action. | **APPROVED** | A worker may assist but is not correctness authority. | Expiry/retry/race tests. |
| Late payment | A payment fact after reservation expiry enters reconciliation and cannot automatically restore capacity or confirm an appointment. | **APPROVED** | Preserves Phase 4 provider/reconciliation boundary. | Late-success/reconciliation tests. |
| Reschedule ordering | Secure new capacity before releasing old capacity, in one transaction. | **APPROVED** | Prevents accidental loss of an existing booking. | Concurrent reschedule and rollback tests. |
| Deadlock-safe order | Use deterministic global lock ordering, lock only the smallest authoritative resource necessary, and never hold database locks while calling external services. Same-capacity concurrent operations serialize; reschedule secures new capacity before releasing old capacity; expiry/cancellation lock relevant reservation/capacity state. | **APPROVED** | Decision 18 defines the required transaction discipline; the concrete capacity resource is deferred with reservation implementation. | Two-session inverse-order, reschedule, expiry, cancellation, and external-call boundary tests. |

## H. Availability precedence

The following is the required deterministic evaluation order.

1. Start with applicable recurring working periods.
2. Subtract breaks.
3. Subtract holidays.
4. Subtract leave.
5. Subtract blocked periods.
6. Apply one-off availability only within the surviving higher-priority
   exclusions.
7. Render existing reservations as capacity consumption, not as a change to
   configuration; PostgreSQL remains authoritative at reservation time.

| Decision | Proposed rule | Status | Why / downstream impact | Required tests |
| --- | --- | --- | --- | --- |
| Precedence ambiguity | If records cannot be evaluated deterministically under the approved order, return no candidate availability and audit/configuration-error handling rather than choosing silently. | **APPROVED** | Fail-closed behavior protects capacity and patient expectations. | Ambiguous overlap and no-candidate tests. |
| One-off additive precedence | One-off availability is lower priority than breaks, holidays, leave, blocked periods, and existing reservations; it cannot override them. | **APPROVED** | Decision 15 prevents additive windows from defeating exclusions or capacity consumption. | Additive/subtractive collision and reservation-precedence tests. |

## I. Authorization, IDOR, and audit

| Decision | Proposed rule | Status | Why / downstream impact | Required tests |
| --- | --- | --- | --- | --- |
| Authentication | Every availability management operation requires an existing server-side session. | **APPROVED** | Reuses Phase 2 identity/session security. | Missing/revoked/expired session tests. |
| Doctor authority | Authenticated Account ownership of DoctorProfile is mandatory for doctor-owned availability. | **APPROVED** | Prevents profile-ID substitution. | Cross-account/doctor-profile IDOR tests. |
| Clinic authority | Active tenant membership and existing `clinic.manage` are mandatory for clinic-owned availability. | **APPROVED** | Context selection alone grants nothing. | Owner/admin allowed; staff/patient/cross-tenant denied. |
| Service ownership | Availability rules must be bound to an offering the actor is authorized to manage. | **APPROVED** | Prevents offering/tenant IDOR. | Offering/tenant/clinic substitution tests. |
| Tenant-specific schedules | No tenant context grants authority over an independent doctor schedule. | **APPROVED** | Network participation/membership never transfers doctor ownership. | Tenant-context impersonation tests. |
| Audit | Successful lifecycle changes and denied ownership/context/configuration actions use the existing audit boundary without sensitive schedule data beyond approved metadata. | **APPROVED** | Maintains Phase 2 audit controls. | Success/denial audit and metadata-safety tests. |

## J. Failure and reconciliation behavior

| Decision | Proposed rule | Status | Why / downstream impact | Required tests |
| --- | --- | --- | --- | --- |
| Invalid timezone / recurrence | Reject configuration and audit the denial; do not fall back to server timezone or guess recurrence. | **APPROVED** | Prevents silent schedule drift. | Invalid IANA/grammar tests. |
| Conflicting configuration | Fail closed and require an authorized correction; no automatic merge is implied. | **APPROVED** | Preserves deterministic availability. | Conflict/no-candidate tests. |
| Stale Redis/cache data | Treat it as a read-model miss; re-evaluate against PostgreSQL/configuration before reservation. | **APPROVED** | Redis cannot decide validity. | Stale-cache and cache-outage tests. |
| Reservation race/database failure | Roll back the transaction, return no confirmation, audit the failure, and retry only through an idempotent future boundary. | **APPROVED** | Prevents partial capacity consumption. | Transaction rollback and concurrent failure tests. |
| Expired reservation | Release capacity and reject normal continuation; a late provider fact enters reconciliation. | **APPROVED** | Matches Phase 4/Phase 5 lifecycle rules. | Expiry/late-payment tests. |
| Inconsistent derived availability | Do not confirm or reserve based on it; recompute and fail closed if conflict remains. | **APPROVED** | Derived slots are never authority. | Cache/configuration mismatch tests. |

## Deferred implementation boundaries

The following are approved as later work and do not block the
configuration-only Availability Foundation:

1. The explicit clinic/doctor assignment-publication mechanics required before
   a clinic exposes a doctor-owned Service Offering or schedule.
2. Tenant-specific doctor schedules, which belong to that same future
   assignment/publication lifecycle.
3. Candidate-slot identity, materialization versus calculation-on-demand,
   cache invalidation, and optional derived-slot read models.
4. The physical reservation/capacity ledger implementation and its detailed
   contention proof, despite the approved PostgreSQL authority and locking
   discipline.
5. Async reservation-expiry implementation, TZDB reproducibility recording,
   later booking/appointment behavior, payments, and reconciliation flows.
6. Exact configurable operational maximum values. No default or arbitrary
   business maximum is introduced by this matrix.

## Recommended smallest implementation slice

Implement only owner-authorized availability configuration for direct
doctor-owned and clinic-owned Service Offerings: controlled weekly recurrence,
local same-day windows, breaks, holidays, leave, blocked periods, one-off
availability, IANA validation, effective dating, audit, and DST expansion
tests. Do not generate persistent slots, create reservations, or implement
appointments, booking, or payments.

## Required database invariants

- Explicit FK to an authorized Service Offering/version; no polymorphic owner
  identifier as the only relationship.
- Owner/service party shape and active/version-effective checks at the service
  boundary; immutable historical configuration references.
- Valid IANA timezone, effective ranges, canonical recurrence payload, and
  deterministic exception precedence.
- No direct candidate-slot row or Redis entry can represent a reservation.
- Future reservations must enforce expiry/capacity in PostgreSQL, not through
  generated availability.

## Required concurrency and timezone tests

- Spring-forward nonexistent local occurrence skip and fall-back earlier-fold
  selection using IANA rules.
- Local/UTC conversion across effective-date, weekday, and midnight boundaries.
- Concurrent reservation/cancellation/expiry/reschedule, capacity greater than
  one, late payment after expiry, and global lock-order/deadlock tests before
  reservation work.
- Cache stale/rebuild/collision behavior proving derived slots are non-authority.

## Proposed migration boundaries

1. **Availability configuration migration:** only rules, local-time windows,
   subtractive exceptions, effective dates, timezone/recurrence validation,
   ownership FKs, audit references, and historical immutability controls.
2. **Derived-slot read-model migration (optional):** only rebuildable candidate
   rows/indexes; no reservation authority.
3. **Reservation migration:** separate PostgreSQL capacity ledger/range locks,
   reservation expiry, idempotency, and later appointment-intent references.

No migration is created by this planning document.

## Phase 5 Step 2 planning status

- Availability Foundation planning is **APPROVED** for implementation.
- The implementation scope is configuration-only.
- Candidate-slot persistence is optional and deferred.
- Reservations, appointments, payments, and booking remain outside this step.
- Clinic exposure of doctor-owned availability and doctor assignment remain
  outside this step.
