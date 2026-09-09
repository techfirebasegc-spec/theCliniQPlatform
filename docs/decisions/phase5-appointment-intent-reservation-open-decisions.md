# theCliniQ Phase 5 Step 3 — genuinely open decisions

## Shared provider capacity across multiple services

- **Question:** Can two Service Offering versions owned by one provider consume one shared physical capacity pool in Step 3?
- **Why it matters:** Per-version capacity is safe only when each bookable Offering has independent capacity.
- **Recommended option:** Do not support shared pools in Step 3. Use `service_offering_version_id` as the canonical capacity identity and reject any future shared-pool claim until an explicit capacity-pool model is approved.
- **Alternatives:** explicit provider pool; explicit clinic resource pool; generic pool abstraction.
- **Impact:** Must be decided before exposing multiple offerings as sharing one provider/resource capacity; it does not block the initial per-version reservation foundation.

## Clinic-to-Clinic referral booking handoff

- **Question:** What approved referral record and patient-consent evidence authorizes Clinic→Clinic booking?
- **Why it matters:** `REFER` is distinct from `BOOK`, and patient sharing/consent is not part of Phase 2.
- **Recommended option:** Exclude Clinic→Clinic creation from Step 3 routes until the referral/consent model is approved.
- **Alternatives:** implement a later referral-bound intent; retain manual/offline referral only.
- **Impact:** Does not block Patient/Clinic→Doctor foundation, but blocks Clinic→Clinic booking.
