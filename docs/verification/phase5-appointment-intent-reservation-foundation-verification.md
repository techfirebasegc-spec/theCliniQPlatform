# theCliniQ Phase 5 Step 3.1 — database foundation verification

Use a fresh disposable PostgreSQL database after Phases 2, 4, and 5 Steps 1–2.

The companion SQL fixture runs entirely inside `BEGIN`/`ROLLBACK` with deterministic prerequisite data: Accounts, an independent DoctorProfile, a Clinic, doctor-owned and clinic-owned Service Offerings, immutable versions/prices, and reservation policies. It verifies all three Step 3.1 tables and integrity triggers; doctor-only and clinic-only provider shapes; provider XOR fail-closed behavior; Offering/version/price/provider/policy snapshot consistency; positive and unique reservation policies; actor-plus-idempotency-key uniqueness; representative foreign keys; immutable appointment and reservation capacity context; explicit `RELEASED` state representation; and non-reactivation of a released reservation. Every expected failure is checked against its expected PostgreSQL SQLSTATE and causes fixture failure if the invalid statement succeeds or fails for a different reason.

Because the Appointment Intent context trigger executes before table CHECK constraints, invalid both-provider/neither-provider inserts are rejected by that trigger before the provider-XOR CHECK is evaluated. The fixture separately asserts the XOR CHECK exists in PostgreSQL's constraint catalog. This is fail-closed behavior, not an application-layer substitute for the constraint.

The database guarantees only `(booking_actor_account_id, idempotency_key)` uniqueness. It does not distinguish same-versus-different `request_fingerprint` conflicts; resolving an idempotent replay versus a conflicting request is intentionally later application processing.

Step 3.1 verifies database foundation invariants only. It does not verify concurrent reservation processing, booking API behavior, reservation expiry-worker behavior, payment or Razorpay flows, appointment confirmation, or the full appointment lifecycle. Targeted DOWN must remove only Step 3.1 objects and leave earlier phases intact.
