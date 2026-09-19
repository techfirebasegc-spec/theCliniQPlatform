# theCliniQ Phase 5 — Scheduling modes decision matrix

## Status and boundary

This decision formally extends the approved Phase 5 architecture to support
both fixed-slot and queue-based scheduling. Phase 5.8 implements and verifies
the Queue persistence/schema and PostgreSQL capacity infrastructure. Runtime
queue booking operations, service-layer workflow, API, and UI remain deferred;
existing fixed-slot reservation behavior remains implemented.

## Decision 5 — Queue Scheduling Policy

**Status: APPROVED.** `QUEUE` is a provider/service-specific, versioned
scheduling interpretation of the same Availability Foundation as
`FIXED_SLOT`; it is not a second availability system. This approval selects no
numeric capacity, cutoff, duration, no-show, or operational business value.
Its physical PostgreSQL schema and global lock order are resolved separately by
the approved Phase 5.8 Decision 6 below.

Phase 5.8 Decision 6 implements that persistence design: Queue Windows are
the PostgreSQL capacity resources; Queue Entries preserve immutable
position/window evidence; and a Queue Window lock plus deferred capacity guard
is the verified authoritative concurrency boundary. Runtime booking workflow
remains deferred.

| Decision | Approved rule | Status | Required future evidence |
| --- | --- | --- | --- |
| Scheduling-mode selection | The provider/service scheduling context selects `FIXED_SLOT` or `QUEUE`. The choice is versioned with the applicable Service Offering scheduling configuration; it is not a global provider setting or a hard-coded patients-per-hour rule. Different services for the same provider may use different modes. | **APPROVED** | Version/history selection, authorization, and cross-service isolation tests. |
| Shared availability | Both modes use one availability foundation: provider/service ownership, validated IANA timezone, recurring working periods, breaks, leave, holidays, blocked periods, one-off exceptions, approved DST rules, and a bookable schedule/window. | **APPROVED** | Same local/UTC/DST and exception-precedence outcomes for each mode. |
| `FIXED_SLOT` | A Patient receives an exact appointment start time. The Service Offering Version duration and buffers apply. Capacity is reserved against the applicable exact UTC interval/resource. | **APPROVED** | Interval capacity, exact-time snapshot, concurrency, expiry, cancellation, and reschedule tests. |
| `QUEUE` | A Patient books a defined provider-local consultation-window start/end with server-derived UTC bounds, not a guaranteed consultation start time. The authoritative booking facts are that window, its maximum capacity, deterministic queue position, and queue status. | **APPROVED** | Window eligibility, position assignment, capacity, cancellation/no-show, and concurrency tests. |
| Queue capacity | Every queue window has an explicit maximum capacity configured by the applicable provider/service scheduling context. A full queue is rejected deterministically. PostgreSQL atomically reserves queue capacity and assigns position; Redis is cache/supporting infrastructure only. | **APPROVED** | Two-session capacity and position-order tests; Redis outage/staleness tests. |
| Queue position and status | The server assigns a deterministic, concurrency-safe position; the Patient cannot select it, and positions are booking evidence not casually renumbered. Queue status must distinguish at least booked/waiting, called/in-progress, completed, cancelled, and no-show without replacing the authoritative Appointment lifecycle. | **APPROVED** | Position uniqueness/order, status/lifecycle separation, authorization, and audit tests. |
| Booking cutoff | Queue booking cutoff is a validated, versioned configuration of the applicable provider/service scheduling context. No default cutoff value is selected by this decision. | **APPROVED** | Boundary and version-history tests once configuration is implemented. |
| Cancellation and no-show | Existing appointment cancellation/refund behavior remains authoritative. Any queue-capacity release is transactional and preserves original queue-position evidence. No-show timing, authority, release/advance effect, and financial consequence remain configurable/versioned future policy, not an implied new refund rule. | **APPROVED** | Transactional capacity release/retention and policy-snapshot tests. |
| Provider queue operations | The delivering Doctor and the existing authorized clinic operational boundary may advance/manage a queue only through auditable, appointment-scoped operations using normal lifecycle authorization. Clinic Staff gains no authority by this decision. Patient and unrelated/network participants have none. | **APPROVED** | Participation, ACTIVE+VERIFIED doctor revalidation, clinic permission, denial, and audit tests. |
| Estimated wait | Estimated wait time is a derived informational estimate. It is not an appointment start time, consultation-time guarantee, capacity authority, or financial/lifecycle fact. | **APPROVED** | Derivation/staleness display tests; no authorization or reservation decisions based on the estimate. |
| Network booking | Direct and network/referral booking use the selected mode's same availability and PostgreSQL reservation rules. Network capability never overrides schedule eligibility, capacity, appointment authorization, payment, or lifecycle controls. | **APPROVED** | Directional capability, patient consent/referral, cross-tenant, and mode-capacity tests. |

## Common conceptual model

```
Provider Availability
        ↓
Bookable Schedule
        ↓
Scheduling Mode
   ┌────┴─────┐
   ↓          ↓
FIXED_SLOT   QUEUE
```

`FIXED_SLOT` and `QUEUE` are scheduling interpretations of the same bookable
schedule. They are not separate availability systems. The shared foundation
continues to apply exception precedence, local-time authoring, UTC execution,
provider/service ownership, lead time, horizon, authorization, audit, and DST
handling before either mode may reserve capacity.

## Concurrency and historical boundaries

For either mode, PostgreSQL is the transactional source of truth. A booking
transaction must lock the smallest applicable capacity authority, revalidate
the bookable schedule and authorization, atomically consume capacity, and
persist immutable booking evidence. Idempotent replay must return the original
outcome; a conflicting request must not leave partial capacity, appointment,
payment, or financial records. No external provider call occurs while these
locks are held.

For `QUEUE`, the capacity authority is the selected consultation window rather
than an exact consultation interval. The implemented PostgreSQL Queue Window
and Queue Entry persistence serialize concurrent capacity consumption and
deterministic position assignment, verified with two independent connections.
Runtime booking operations must retain this authority and ordering.

The selected mode, bookable-window context, and resulting exact interval or
queue position must be snapshotted with the Appointment Intent/Appointment as
applicable. Existing immutable Service Offering, version, price, reservation,
financial allocation, payment, participant, appointment-event, cancellation,
and reschedule evidence remains unchanged.

A later change to queue configuration affects only future booking eligibility.
It must not mutate already booked queue-window, position, scheduling, price,
financial, or appointment evidence.

## Explicitly deferred

- runtime queue booking repositories/services, API/UI, and provider queue
  operations. Queue Window/Queue Entry persistence and PostgreSQL verification
  are implemented;
- numeric capacity, booking-cutoff, no-show, and queue-advance business values
  and the detailed no-show state/authority/release/financial policy;
- provider queue-management API/UI and patient estimated-wait presentation;
- generated queue/read-model caching and Redis implementation details;
- any change to payment, settlement, financial allocation, appointment
  lifecycle, cancellation/refund, rescheduling, network-capability, or
  referral/patient-consent rules.
