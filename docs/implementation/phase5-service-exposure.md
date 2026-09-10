# theCliniQ Phase 5 — Service Exposure implementation

## Scope

This implementation adds the approved minimum direct patient-facing exposure
boundary. `service_exposures` is separate from Service Offering ownership and
network capability. It does not add clinic exposure of doctor-owned Offerings,
multiple channels, discovery, scheduled publication, appointments, payment, or
capacity changes.

## Lifecycle and authorization

An exposure is created as `DRAFT`; allowed transitions are `DRAFT` to
`PUBLISHED`, `PUBLISHED` to `UNPUBLISHED`, and `UNPUBLISHED` to `PUBLISHED`.
The database validates transitions and immutable ownership context. Doctor
operations require Account ownership of the DoctorProfile. Clinic operations
require active tenant context with `clinic.manage`. All lifecycle outcomes use
the existing append-only audit boundary.

## Booking integration

`POST /v1/appointment-intents` accepts a `serviceExposureId`, local time, and
idempotency key. It accepts no provider, Offering, price, ownership, or tenant
authority from the client. The service locks a `PUBLISHED` exposure, derives
the Offering/provider, then applies existing active-version/price,
availability, timezone, lead/horizon, patient, and reservation checks.

New Appointment Intents snapshot the exposure, Offering, Version, Price,
provider, applicable tenant, time, price, buffers, and hold configuration.
Unpublishing prevents new intents only; it does not mutate existing intents or
reservations.

## Retention

The exposure FK in Appointment Intents is restrictive. Referenced exposures
may be unpublished but cannot be hard-deleted. Targeted migration rollback
fails safely if any Appointment Intent carries an exposure snapshot.
