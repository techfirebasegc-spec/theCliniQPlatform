# theCliniQ Phase 5 Step 2 — Availability Foundation implementation plan

## Scope and non-goals

This plan implements the approved configuration-only Availability Foundation.
It extends, but does not rewrite, the immutable Phase 5 Step 1 Service
Offering/version/price history.

It does **not** implement generated slots as authority, reservations,
appointments, booking, payments, Razorpay, Redis authority, Firebase,
clinic/doctor assignment-publication, tenant-specific doctor schedules, or
Doctor-to-Doctor scheduling.

## 1. Domain model

Availability is a versioned configuration of a single Service Offering version.
It describes when a directly owned doctor or clinic may be available; it does
not reserve, confirm, or book time.

```text
ServiceOffering (exactly one doctor or clinic owner)
  └── ServiceOfferingVersion (immutable/effective dated)
        └── AvailabilityConfiguration (one immutable configuration)
              ├── AvailabilityRule (controlled weekly RFC 5545-style rule)
              │     └── AvailabilityWindow (WORKING or BREAK)
              └── AvailabilityException (HOLIDAY, LEAVE, BLOCKED, ONE_OFF)
```

The configuration is selected through the applicable immutable Service
Offering version; no mutable “current availability” record may rewrite
historical interpretation.

## 2. Ownership model

- **Doctor-owned Offering:** only the authenticated Account that owns the
  Offering’s DoctorProfile may create, read, change, activate, or deactivate
  its Availability Configuration.
- **Clinic-owned Offering:** only an authenticated Account with an active
  tenant membership and existing `clinic.manage` permission for the owning
  Clinic may manage availability.
- Resource IDs, tenant context, a network relationship, and a doctor profile
  ID never grant access by themselves. Repository/service queries must bind
  doctor ownership to the authenticated Account and clinic authority to the
  resolved active membership.
- A clinic must not create, view as a manager, alter, publish, or book a
  doctor-owned Offering’s availability through clinic context. The future
  assignment/publication model is the sole possible extension point.

## 3. Availability configuration entities

The smallest normalized schema is:

### `availability_configurations`

One row per `service_offering_versions.id`, with a unique FK to that version.
It contains a UUID primary key, `provider_timezone`, the six approved integer
configuration fields, lifecycle status, and standard creator/time audit fields.

- `slot_duration_seconds > 0`
- `buffer_before_seconds >= 0`
- `buffer_after_seconds >= 0`
- `capacity > 0`
- `booking_lead_time_seconds >= 0`
- `booking_horizon_seconds > 0` and greater than booking lead time

The values are configuration vocabulary only. This plan selects no duration,
capacity, lead time, horizon, or maximum value.

### `availability_rules`

An immutable/effective-dated controlled recurrence declaration for a
configuration. It has a UUID primary key, `availability_configuration_id` FK,
canonical recurrence payload, timezone-aware `effective_from` and optional
`effective_to`, lifecycle/audit fields, and an effective-range index.

The payload accepts only the approved RFC 5545-style weekly profile: weekly
frequency, selected weekdays, and effective dates. Unsupported features,
including arbitrary monthly/yearly recurrence, are rejected.

For effective-range conflict detection, a rule’s deterministic identity is the
pair of its Availability Configuration and its canonical recurrence identity.
The canonical recurrence identity is the normalized controlled weekly payload
(weekly frequency plus normalized selected-weekday set), excluding effective
dates, lifecycle, and audit data. The database stores that canonical identity
as a comparable value and rejects overlapping effective ranges for the same
`availability_configuration_id` and canonical recurrence identity. This adds
no provider/business concept; it distinguishes the same logical recurrence
from its separately effective-dated revisions.

### `availability_windows`

Normalized local-time windows belonging to an Availability Rule. Each row has
a UUID primary key, `availability_rule_id` FK, `kind` (`WORKING` or `BREAK`),
local weekday, local start/end as integer seconds since local midnight, and
audit fields. A window has `start < end`; no window crosses midnight.

### `availability_exceptions`

An immutable/effective-dated exception record belonging to a configuration,
with UUID primary key, `availability_configuration_id` FK, `kind`
(`HOLIDAY`, `LEAVE`, `BLOCKED`, or `ONE_OFF`), provider-local start/end input,
the corresponding timezone-aware instant range, lifecycle/audit fields, and
conflict controls appropriate to the exception kind and precedence class.

Holiday, leave, and blocked records are subtractive. A one-off record is an
explicit additional working window. One-off input must be same-day local time,
strictly future at creation, and cannot overlap or duplicate another one-off
window.

Provider-local input plus the referenced configuration’s validated
`provider_timezone` is authoritative for exception interpretation. The server
derives the stored UTC instant range from that input; callers cannot submit or
independently edit the derived range. Server-side conversion applies the
approved DST rules: skip a nonexistent spring-forward local occurrence and
resolve an ambiguous fall-back occurrence to the earlier occurrence.

## 4. Recurrence representation

The service accepts a controlled RFC 5545-style weekly recurrence profile,
then canonicalizes it before persistence. The canonical form expresses only
weekly frequency, selected weekdays, and effective dates.

The parser rejects malformed syntax, unknown fields, unsupported frequencies,
monthly/yearly rules, and interpretation-dependent input. It never silently
falls back to the server timezone or an alternative recurrence grammar.

Local day-of-week and local window times are stored separately from the
canonical recurrence declaration. This keeps the grammar bounded and permits
database overlap checks without evaluating arbitrary RFC rules.

## 5. Working-period and break representation

Working and break windows are authored in the configuration’s IANA timezone
and remain inside one local calendar day.

- Working windows may be adjacent but not overlap or duplicate on the same
  applicable rule/day.
- Break windows may be adjacent but not overlap or duplicate on the same
  applicable rule/day.
- A break must be wholly contained in one applicable working window. If rule,
  weekday, effective range, or containment cannot be determined
  unambiguously, the write is rejected.
- Windows are configuration only; they cannot increase capacity or authorize
  a reservation.

## 6. Leave, holiday, and blocked-period representation

`HOLIDAY`, `LEAVE`, and `BLOCKED` exceptions are explicitly classified,
auditable subtractive intervals. The service captures provider-local input
using the configuration timezone and validates a non-empty range before
storing its deterministic UTC range.

Records in the same precedence class that conflict are rejected/fail closed;
the system must not invent a merge or implicit winner. A subtraction never
modifies the recurrence record, Offering version, or any future reservation
state.

## 7. One-off availability representation

`ONE_OFF` is an explicit additional working interval, not a mutation of the
recurrence. It may add availability outside recurring working periods, but is
lower priority than breaks, holidays, leave, blocked periods, and reservations.

At creation/update validation, the local start/end must be within one local
day, the interval must be non-empty and future, timezone conversion valid, and
duplicate/overlapping one-off windows or same-precedence ambiguity rejected.

Configuration changes affect future availability only. Existing reservations
are never changed by this Step; reservations themselves are not implemented.

## 8. Effective dating and versioning

- A configuration references exactly one immutable Service Offering version.
- A configuration change requires a new Offering version and a new linked
  Availability Configuration; it must never update a historical active version
  in place.
- Rules use timezone-aware effective ranges with `effective_from` and optional
  `effective_to`; invalid or overlapping ranges for the same configuration and
  canonical recurrence identity are rejected.
- Exceptions retain their original local-time input and derived instant range.
  Local input plus the referenced configuration timezone is authoritative; the
  derived range is server-generated and not independently mutable. They are
  not rewritten if a later Offering version changes timezone or configuration.
- Deactivation is a lifecycle operation on a configuration/rule/exception;
  historical records remain readable for audit and future appointment context.

## 9. IANA timezone handling

`provider_timezone` must be an IANA timezone identifier validated by the
server-side timezone library at command handling time. The database stores the
validated string; application code converts local inputs to UTC instants.

The database also enforces non-empty timezone text and configuration/version
ownership. It must not use the PostgreSQL server-local timezone as an implicit
interpretation.

## 10. DST expansion behavior

Expansion is a pure server-side calculation from the canonical weekly rule,
local windows, effective range, local exceptions, and the configuration’s IANA
timezone:

- a spring-forward nonexistent local occurrence is skipped;
- a fall-back ambiguous local occurrence resolves to the earlier occurrence;
- generated execution instants are UTC; and
- cross-midnight windows are rejected rather than normalized.

The same validated server-side conversion is used for exception local input
and its persisted derived UTC range. A write is rejected if the local input
cannot be converted under these rules; no client-provided UTC range is trusted.

Candidate calculation, slot identity, and persistence are deferred. This Step
only supplies validated configuration and reusable expansion logic/tests.

## 11. Exception precedence

Availability evaluation is deterministic:

1. recurring working periods;
2. breaks;
3. holidays;
4. leave;
5. blocked periods;
6. one-off availability; and
7. existing reservations as future capacity consumption.

One-off availability cannot override any preceding exclusion or reservation.
Same-precedence conflicts fail closed/reject. This Step has no reservation
table or execution path; the final reservation stage is documented solely to
preserve the approved future boundary.

## 12. Validation rules

At service/repository boundaries, reject and audit:

- unauthenticated, unauthorized, cross-owner, cross-tenant, or inactive
  context writes;
- unknown IANA timezones, malformed/unsupported recurrence, and missing
  selected weekdays;
- overnight or empty windows;
- duplicate/overlapping working windows or breaks;
- breaks not contained in applicable working availability;
- invalid effective ranges or conflicting same-precedence exceptions;
- past, duplicate, or overlapping one-off windows;
- `slot_duration_seconds <= 0`, negative buffers/lead time, `capacity <= 0`,
  `booking_horizon_seconds <= 0`, or horizon not exceeding lead time; and
- updates that would mutate immutable Offering/version/pricing history.

No arbitrary maximum duration, capacity, lead time, or horizon is hard-coded.

## 13. Authorization rules

Every availability command requires the existing Step 3 server session.

- For doctor-owned Offerings, resolve the Offering owner through
  `DoctorProfile.account_id = authenticated_account_id` at the repository
  boundary.
- For clinic-owned Offerings, resolve active tenant membership/context and
  require existing `clinic.manage` at the existing authorization boundary.
- Context selection is input to authorization, never authority itself.
- All reads and mutations scope by both the requested resource and the
  resolved authorized owner/context. Missing and unauthorized resources use
  the established non-enumerating denial category.

No global role, network capability, clinic exposure, or assignment is added.

## 14. Audit requirements

Use the existing Phase 2 audit boundary for successful and denied
security-sensitive operations:

- configuration create/change/activate/deactivate;
- recurrence/rule/window/exception create/change/deactivate;
- one-off availability lifecycle actions; and
- ownership, membership/context, validation, and IDOR denials.

Audit metadata may include non-sensitive resource IDs, action, lifecycle
outcome, and validation category. It must not contain session secrets, Firebase
credentials/tokens, raw internal database errors, or unnecessary schedule
content.

## 15. Repository and service boundaries

`AvailabilityRepository` owns parameterized PostgreSQL reads/writes,
transactions, parent-row locking where lifecycle changes require it, and
database-constraint mapping. It does not authenticate or decide tenant
permissions.

`AvailabilityService` owns canonical recurrence parsing, local-time/IANA/DST
validation, effective-date and overlap/containment validation, precedence,
owner/context authorization orchestration, audit calls, and stable generic
error mapping.

Routes are thin: authenticate through the existing session boundary, validate
request shape, call the service, and return no database/ownership details.
They may not duplicate ownership policy or become a second authorization path.

## 16. PostgreSQL constraints and indexes

The migration should provide, at minimum:

- FKs from configuration to Service Offering version and from rules/windows/
  exceptions to their parents, with lifecycle-safe restrictive delete behavior;
- unique `availability_configurations.service_offering_version_id`;
- `CHECK`s for integer-seconds/capacity relationships and non-empty local or
  instant ranges;
- enum/check vocabulary limited to approved rule/window/exception/lifecycle
  states;
- a no-overnight `CHECK` for local windows (`start_seconds < end_seconds` and
  both constrained to a local-day representation);
- unique indexes preventing duplicate windows and duplicate one-off windows;
- partial/exclusion indexes, or a constraint trigger where a plain index is
  insufficient, to reject same-rule/day working or break overlap and same-class
  exception conflict;
- a GiST exclusion constraint over configuration, canonical recurrence
  identity, and effective range to reject overlapping revisions of the same
  logical recurrence rule; and
- indexes supporting parent lookup, effective-range lookup, local date/range
  conflict validation, and authorized Offering/version retrieval; and
- immutable-history enforcement consistent with existing Service Offering
  version/price immutability triggers.

Cross-row break containment and recurrence-effective-range interpretation may
require a transactionally safe constraint trigger or equivalent service
validation rechecked under a parent-row lock. The chosen mechanism must fail
closed and be tested by direct SQL as well as application paths.

## 17. Transaction boundaries

Creation or replacement of one Availability Configuration, its recurrence
rules, windows, and exceptions occurs in one PostgreSQL transaction:

1. lock the authoritative Offering version/configuration parent needed to
   serialize concurrent configuration changes;
2. revalidate ownership/context before writes;
3. insert the new immutable configuration graph;
4. rely on database constraints for final integrity; and
5. write the success audit event in the same transactional boundary where the
   existing audit infrastructure supports it.

Failure rolls back the complete configuration graph; no partial schedule,
exception, or audit-success record remains. No external service is called
while a database transaction/lock is held.

## 18. Concurrency implications (no reservation implementation)

This Step serializes competing configuration writes for the same Offering
version/configuration so overlap, containment, effective-date, and one-off
conflict checks are not vulnerable to TOCTOU races.

It neither creates capacity-consumption records nor locks future reservation
resources. The approved future reservation boundary is PostgreSQL-only:
capacity belongs to the Offering version, same-capacity operations serialize,
reschedule obtains new capacity before releasing old capacity, and external
payment calls occur outside locks. The physical capacity ledger/range model and
exact resource-level lock implementation remain deferred.

## 19. Migration boundaries

Create one new reversible Availability Configuration migration. It adds only
the four configuration entities and their constraints/indexes/triggers. It
must not alter the Phase 5 Step 1 migration, Service Offering ownership, price
history, Phase 2 authorization schema, Phase 4 financial tables, or network
tables.

**Proposed name:**
`database/migrations/20260912000000_phase5_availability_foundation.js`

The `DOWN` path drops only objects introduced by this migration in
dependency-safe reverse order. It must not delete or rewrite Service Offerings,
versions, prices, financial data, memberships, or network data. A later
reservation/appointment migration must prevent unsafe rollback if it depends
on these objects rather than discard data.

## 20. Test strategy

### Unit tests

- controlled RFC weekly parser/canonicalizer: valid weekly/weekday/effective
  input; malformed/unsupported/monthly/yearly rejection;
- canonical recurrence identity: equivalent normalized weekly input resolves
  to one identity, while overlapping effective ranges for that identity are
  rejected;
- integer-seconds and all approved numeric relationships;
- same-day/overnight rejection, adjacency acceptance, duplicate/overlap
  rejection, and break containment;
- IANA timezone rejection, spring-forward skip, fall-back earlier-fold, and
  local-to-UTC conversion, including proof that exception local input and the
  derived UTC range cannot diverge or be independently edited;
- precedence: one-off addition without overriding breaks, holiday, leave,
  blocked periods, or future reservation consumption; and
- one-off future-only and conflict validation.

### API/service integration tests

- doctor Account ownership and clinic active-membership plus `clinic.manage`;
- staff/patient/inactive/revoked membership denial;
- cross-account, cross-doctor-profile, Offering ID, Clinic ID, Tenant ID, Rule
  ID, Window ID, and Exception ID substitution/IDOR denial;
- immutable Offering/version/price history remains unchanged;
- audit success and denial behavior without secret/schedule leakage;
- transaction rollback leaving no partial graph after a failing child insert;
  and
- concurrent conflicting configuration writes yielding one valid outcome and
  one constraint/validation failure.

### PostgreSQL disposable integration tests

- direct SQL rejects invalid FKs, invalid numeric checks, forbidden enum
  values, overnight/empty windows, duplicate/overlapping windows, invalid
  break containment, conflicting same-precedence exceptions, and duplicate or
  past one-off windows;
- direct SQL cannot bypass immutable Offering/version history or make a
  generated slot/reservation authority because neither is introduced; and
- direct SQL verifies indexes, range/overlap controls, effective dating, and
  reversible UP/DOWN behavior.

## Smallest reversible implementation slice

1. Add the migration and database-only integrity rules for configuration,
   controlled recurrence/windows, and exceptions.
2. Add the Availability module repository/service/parser/timezone utilities.
3. Add authenticated management routes using existing session, authorization,
   and audit boundaries.
4. Add focused API, unit, DST, and disposable PostgreSQL verification tests.

This sequence produces no slot, reservation, appointment, or payment state.

## Expected implementation files

- `database/migrations/20260912000000_phase5_availability_foundation.js`
- `api/src/modules/availability/availability.ts`
- `api/src/modules/availability/postgres-availability-repository.ts`
- `api/src/modules/availability/recurrence.ts`
- `api/src/modules/availability/timezone.ts`
- `api/src/routes/availability.ts`
- `api/src/app.ts` (route registration only)
- `api/test/availability.test.ts`
- `docs/verification/phase5-availability-foundation-verification.md`
- `docs/verification/phase5-availability-foundation-verification.sql`

File names are a proposed minimal module layout; no files are created by this
plan.

## Database invariants

1. A configuration belongs to exactly one Service Offering version and cannot
   rewrite historical Offering/version/price data.
2. Durations are integer seconds and meet all approved sign/relationship
   checks; capacity is positive.
3. Every local window is same-day and non-empty; working/break overlap and
   duplicates are rejected, while adjacency is allowed.
4. Breaks are contained within applicable working availability.
5. Recurrence grammar and exception/window vocabulary are restricted to the
   approved profiles; overlapping effective ranges for the same canonical
   recurrence identity are impossible.
6. Same-precedence exception conflict, duplicate/overlapping one-off windows,
   and past one-off creation fail closed. Exception UTC ranges are derived only
   by the server from authoritative local input and validated IANA timezone.
7. No generated slot table, reservation state, or Redis record is introduced
   as authority.

## Live disposable database verification plan

Use a fresh disposable PostgreSQL database only. Apply the foundation through
the proposed Availability migration, then execute a dedicated verification SQL
fixture with deterministic IDs. Verify schema objects, FKs, checks, unique and
overlap constraints, immutability compatibility, direct-SQL negative cases,
and controlled fixture rollback. Never use production, existing application
data, Firebase, or a payment provider.

## UP/DOWN verification plan

1. Run migration `UP` from a clean disposable database after required prior
   migrations; confirm only the expected Availability objects are added.
2. Run the direct-SQL positive and negative verification fixture inside a
   rollback-safe transaction/savepoint structure.
3. Run the targeted Availability migration `DOWN`.
4. Confirm only the Availability objects are removed and Step 1 Service
   Offering/version/price objects plus all Phase 2/Phase 4 objects remain.
5. Reapply `UP` on the same disposable baseline if the procedure requires
   repeatability evidence.

## Intentionally deferred implementation details

- exact operational maximum policy values;
- TZDB version recording;
- candidate slot identity, materialization, caching, and invalidation;
- physical reservation/capacity-ledger structure and exact reservation lock
  resource;
- reservation expiry worker, appointments, booking, payments, and provider
  reconciliation; and
- clinic/doctor assignment-publication and tenant-specific doctor schedules.
