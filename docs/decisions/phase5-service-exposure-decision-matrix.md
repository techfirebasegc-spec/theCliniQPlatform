# theCliniQ Phase 5 — Explicit Patient-Facing Service Exposure decision matrix

## Approved architecture

`OWNERSHIP != PATIENT-FACING EXPOSURE != NETWORK CAPABILITY`.

Ownership establishes who may manage a Service Offering. Patient-facing
exposure establishes whether a Patient may create an Appointment Intent through
that Offering's own provider. A network capability governs only its separately
approved network operation. `DISCOVER`, `CONTACT`, `BOOK`, and `REFER` never
create patient-facing exposure by themselves.

An `ACTIVE` Service Offering is **not** automatically patient-bookable.

## P5-SE-01 — Separate Service Exposure representation

**Status: APPROVED.**

Use a separate minimal `service_exposures` representation. One row represents
direct patient-facing exposure of exactly one `service_offering` through that
Offering's actual owner.

| Element | Approved decision |
| --- | --- |
| Resource exposed | `service_offering_id`, not a Service Offering Version. |
| Multiplicity | One direct exposure per Offering: `UNIQUE(service_offering_id)`. |
| Ownership | Exposure never owns or transfers the Service Offering. |
| Provider shape | Exactly one DoctorProfile XOR Clinic; it must exactly match the Offering owner. PostgreSQL must enforce this. |
| Tenant | `tenant_id` is `NULL` for doctor-owned exposure and server-derived from the owning Clinic for clinic-owned exposure. It is never client-selected. |
| Doctor-owned Offering through clinic | Prohibited. It requires the separately deferred clinic assignment/publication model. |
| Clinic-owned Offering to Patients | Allowed only through that Clinic's own published exposure. |
| Network | Network capabilities never create, substitute for, or activate exposure. |
| Versioning | Exposure is Offering-level. A booking still requires an active applicable immutable Offering Version and Price. |

### Required database invariants

- `service_exposures.service_offering_id` is a restrictive FK and unique.
- Explicit provider FKs plus a provider-XOR `CHECK` enforce the provider
  shape.
- A PostgreSQL trigger or equivalent invariant verifies that the exposure
  provider equals the Offering owner and, for clinic-owned exposure, that
  `tenant_id` equals the owning Clinic tenant.
- Exposure has no authority to change Offering ownership, provider identity,
  tenant ownership, or network capability state.

## P5-SE-02 — Exposure lifecycle

**Status: APPROVED.**

The lifecycle vocabulary is `DRAFT`, `PUBLISHED`, and `UNPUBLISHED`.

| From | To | Allowed | Authority | Audit event |
| --- | --- | --- | --- | --- |
| New | `DRAFT` | Yes | Owning doctor Account, or active clinic membership/context with `clinic.manage` | `SERVICE_EXPOSURE_CREATED` |
| `DRAFT` | `PUBLISHED` | Yes | Same owner-scoped authority | `SERVICE_EXPOSURE_PUBLISHED` |
| `PUBLISHED` | `UNPUBLISHED` | Yes | Same owner-scoped authority | `SERVICE_EXPOSURE_UNPUBLISHED` |
| `UNPUBLISHED` | `PUBLISHED` | Yes — republishing | Same owner-scoped authority | `SERVICE_EXPOSURE_REPUBLISHED` |
| `DRAFT` | `UNPUBLISHED` | No | Not applicable | Denied lifecycle mutation audit |
| `PUBLISHED` | `DRAFT` | No | Not applicable | Denied lifecycle mutation audit |
| `UNPUBLISHED` | `DRAFT` | No | Not applicable | Denied lifecycle mutation audit |

Only `PUBLISHED` authorizes a new Patient Appointment Intent. Doctor-owned
lifecycle operations require authenticated Account ownership of the
DoctorProfile. Clinic-owned lifecycle operations require active membership,
validated context, and `clinic.manage`; context selection never grants this
authority. Patients, unrelated doctors, unauthorized clinic staff, and network
participants cannot mutate exposure lifecycle.

Every create, publish, unpublish, republish, and denied lifecycle mutation is
recorded through existing append-only `audit_events`, using identifiers and
outcome only.

Underlying Offering or Offering Version inactivity does not automatically
change exposure lifecycle. It simply prevents new booking through normal
Offering/version/price/availability validation. Unpublishing likewise affects
new booking only: it never invalidates or mutates existing intents,
reservations, or later appointments.

## P5-SE-03 — Immutable booking exposure snapshot and retention

**Status: APPROVED.**

Each Patient Appointment Intent must immutably snapshot:

- `service_exposure_id` — the patient-facing publication authorization under
  which booking was created;
- `service_offering_id` — the business service identity;
- `service_offering_version_id` — immutable service configuration; and
- `service_offering_price_id` — immutable provider-price context.

Exposure is tied to the Service Offering, not its Version. The existing
version/price/provider/time snapshots and the new exposure snapshot preserve
historical interpretation when an exposure is unpublished, an Offering becomes
inactive, or a newer Offering Version becomes applicable.

### Referenced exposure retention

- A `service_exposure` may transition to `UNPUBLISHED`.
- It must not be hard-deleted while referenced by an Appointment Intent or a
  downstream appointment record.
- `appointment_intents.service_exposure_id` must be a restrictive FK to
  `service_exposures`; no cascade may delete historical booking evidence.
- The eventual downstream appointment model must apply the same restrictive
  retention principle.

## Authorization and booking effect

Patient Appointment Intent creation must lock and revalidate an exposure as
`PUBLISHED`, as well as existing patient authorization, provider eligibility,
Offering/version/price state, availability, lead/horizon, and idempotency.
Provider, service, clinic, tenant, and exposure IDs never authorize by
themselves.

The current Step 3.2 implementation must not be used as patient-facing booking
until this approved `PUBLISHED` exposure check and immutable snapshot exist.

## Required implementation scope

- `service_exposures` entity, ownership/provider consistency, tenant
  derivation, lifecycle, and restrictive retention;
- owner-scoped creation/publish/unpublish/republish authorization;
- append-only audit integration;
- Patient booking authorization requiring locked `PUBLISHED` exposure; and
- immutable exposure-ID snapshot in Appointment Intents.

## Deferred scope

- Clinic assignment/publication of doctor-owned Offerings.
- Multiple exposures per Offering.
- Publication channels/surfaces and public/private channel configuration.
- Scheduled publication, sophisticated workflows, marketplace ranking, and
  discovery.
- Tenant-specific doctor schedules and cross-clinic exposure.

## Prohibited scope

- Treating every `ACTIVE` Offering as automatically exposed.
- Allowing a network capability to substitute for exposure.
- Allowing a Clinic to expose a doctor-owned Offering without a separately
  approved assignment/publication model.
- Transferring Offering ownership through exposure.
