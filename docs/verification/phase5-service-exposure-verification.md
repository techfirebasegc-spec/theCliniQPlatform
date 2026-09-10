# theCliniQ Phase 5 — Service Exposure disposable PostgreSQL verification

Run only against a fresh disposable database after all Phase 2, Phase 4, and
Phase 5 migrations. Never use production or application data.

1. Apply migrations through `20260914000000_phase5_service_exposures`.
2. Run `phase5-service-exposure-verification.sql` inside its transaction. It
   uses deterministic disposable fixtures and verifies doctor/clinic exposure,
   provider mismatch, provider-XOR/tenant-shape failures, invalid lifecycle
   transitions, restrictive referenced deletion, and immutable intent snapshot.
3. Verify through the API/service layer that a published exposure permits a new
   eligible Appointment Intent and an unpublished exposure denies a new intent.
4. Verify targeted DOWN succeeds only when no Appointment Intent references an
   exposure; otherwise it must fail without deleting historical evidence.
5. After successful targeted DOWN, verify Service Exposure objects are removed
   while earlier Phase 2/4/5 objects remain intact.
