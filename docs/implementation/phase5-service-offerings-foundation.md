# theCliniQ Phase 5 Step 1 — Service Offering + Versioned Pricing Foundation

## Scope

This step implements only provider-owned Service Offerings and immutable,
versioned provider prices. It implements no availability, slots, reservations,
appointments, booking, `BOOK`/`REFER`, payment execution, Razorpay, refunds,
settlements, chat, files, Firebase migration, UI work, or deployment.

## Schema

`service_offerings` has exactly one explicit owner: either
`owner_doctor_profile_id` or `owner_clinic_id`. Both are foreign keys and an
exactly-one `CHECK` prevents both-owner and neither-owner rows. The offering
holds only provider-owned name, optional description, lifecycle status, and
standard creator/updater audit columns. A clinic assignment/publication table
is intentionally not implemented: future clinic exposure of a doctor-owned
offering must have its own lifecycle and authorization and cannot transfer
ownership.

`service_offering_versions` captures immutable, effective-dated offering
versions. It has an offering FK, positive version number, lifecycle status,
half-open effective range, and creator/time audit fields. A PostgreSQL GiST
exclusion constraint prevents overlapping ranges for the same offering.

`service_offering_prices` is one immutable integer-minor-unit price per
Service Offering Version. Its currency is an uppercase ISO-style three-letter
code and its amount is non-negative. Effective dates belong to the referenced
offering version, so exactly one active price can be selected at an instant.
There is no mutable current-price column, commercial allocation, commission,
tax, provider fee, or financial calculation in this module.

Both version and price rows are PostgreSQL-immutable. Corrections require a
new non-overlapping version; this preserves historical provider pricing for
future appointment references.

## Authorization and API boundary

All routes require the existing server-side session boundary.

- A doctor-owned offering can be created, read, updated, and versioned only
  when the authenticated Account owns the DoctorProfile.
- A clinic-owned offering can be managed only through active tenant context
  with existing `clinic.manage` permission. This permits the approved Clinic
  Owner/Admin bundle and denies staff/patients without that permission.
- Resource IDs never authorize access. Doctor ownership is queried with the
  Account at the repository boundary; clinic access is validated through the
  existing TenantContextService at the service boundary.

Foundation routes are `POST /v1/service-offerings`,
`GET/PATCH /v1/service-offerings/:offeringId`,
`POST /v1/service-offerings/:offeringId/versions`, and the authenticated
management-only applicable-version lookup. They do not expose booking APIs.

Successful creation, mutation, and version creation are audited. Ownership,
tenant-context, validation, and database-constraint denials are audited with
the existing audit repository and without pricing secrets or database details.

## Phase 4 boundary

The price is the provider's price input only. Phase 4 remains the sole owner
of commercial-rule evaluation, allocation snapshots, payment intent/provider
facts, refund, settlement, reconciliation, ledger, and legal-hold behavior.

## Verification and future work

The accompanying verification document records disposable PostgreSQL migration
UP/DOWN checks. Future work includes explicit clinic assignment/publication,
availability configuration/recurrence/DST behavior, PostgreSQL reservation
concurrency, appointment context, booking, and Phase 4 allocation invocation.
