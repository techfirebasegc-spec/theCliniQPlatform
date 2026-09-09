# Phase 5 Step 2 — Availability Planning Baseline

**Status:** Planning only. This document records the resolution of the former
Availability Foundation questionnaire. It authorizes no application code,
migration, schema, route, test, UI, booking, payment, appointment, Firebase,
or deployment work.

Decisions 11–19 are **APPROVED**. They resolve the former Step 2 planning
blockers without selecting business values such as a particular duration,
capacity, lead time, or horizon.

## Approved decisions

| Decision | Approved baseline |
| --- | --- |
| 11 — Recurrence grammar | Controlled RFC 5545-style recurrence: weekly recurrence, selected weekdays, and effective dates only. Malformed or unsupported recurrence is rejected; arbitrary monthly/yearly complexity is excluded initially. |
| 12 — Overnight periods | Not supported. Every window remains within one provider-local calendar day. |
| 13 — Working periods and breaks | Working/break overlaps and duplicates are rejected; adjacent periods are allowed. Breaks must be contained in applicable working availability; ambiguous relationships are rejected. |
| 14 — Units and validation | Durations use integer seconds. Slot duration, capacity, and booking horizon are positive; buffers and lead time are non-negative; horizon exceeds lead time. No arbitrary maxima are hard-coded. Configuration is versioned with the Service Offering and historical active versions are immutable. |
| 15 — Exception precedence | Evaluate recurring working periods, breaks, holidays, leave, blocked periods, one-off availability, then existing reservations. One-off availability cannot override higher-priority exclusions or reservations. Same-precedence conflicts fail closed/reject. |
| 16 — One-off availability | An audited explicit additional working window. It may lie outside recurring working time, uses the provider IANA timezone, is same-day local time, cannot overlap/duplicate another one-off window, cannot be created in the past, changes only future availability, and never mutates existing reservations. |
| 17 — Physical capacity | Capacity belongs to the Service Offering version. Reservations consume capacity units and PostgreSQL is the concurrency authority. Redis/cache and generated slots never decide reservation validity; capacity changes affect future reservations only. |
| 18 — Lock ordering | Use deterministic global ordering and lock the smallest authoritative resource required. Never hold database locks while calling external services. Same-capacity operations serialize; reschedule secures new capacity before release; expiry/cancellation lock relevant state; late payments enter reconciliation and do not resurrect expiry. |
| 19 — Doctor availability / clinic exposure | A doctor owns doctor availability and a clinic owns clinic availability. Clinic context does not control doctor availability. Clinic exposure and tenant-specific doctor schedules require a future explicit assignment/publication lifecycle that does not transfer ownership. Doctor-to-doctor scheduling is not permitted. |

## Remaining deferred decisions

These are intentionally outside the Step 2 configuration-only implementation;
they are not planning blockers for it.

1. **Clinic/doctor assignment-publication mechanics** — the explicit,
   authorized lifecycle that can expose a doctor-owned Service Offering through
   a clinic.
2. **Tenant-specific doctor schedules** — dependent on the future
   assignment/publication model.
3. **Candidate-slot implementation details** — stable slot identity,
   calculation-on-demand versus optional materialization, cache invalidation,
   and rebuild behavior.
4. **Reservation/capacity ledger implementation details** — the physical
   PostgreSQL capacity structure and its concurrent contention proof.
5. **Later booking concerns** — reservation expiry worker mechanics,
   appointments, booking, payments, provider reconciliation, and related
   financial flows.
6. **Operational maximum policy values** — values remain configurable and are
   not selected or hard-coded here.
7. **TZDB reproducibility recording** — optional historical-calculation
   reproducibility detail for later approval.

## Phase 5 Step 2 planning status

- Availability Foundation planning is **APPROVED** for implementation.
- The implementation scope is configuration-only.
- Candidate-slot persistence is optional and deferred.
- Reservations, appointments, payments, and booking remain outside this step.
- Clinic exposure/doctor assignment remains outside this step.
