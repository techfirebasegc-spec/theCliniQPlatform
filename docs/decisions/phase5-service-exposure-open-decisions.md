# theCliniQ Phase 5 — Service Exposure decision status

## Approved and resolved

| ID | Decision | Approved position |
| --- | --- | --- |
| P5-SE-01 | Explicit patient-facing exposure model | A separate minimal `service_exposures` representation is required. It is one direct exposure per Offering, preserves DoctorProfile XOR Clinic ownership, derives clinic tenant context server-side, and is independent of network capability. |
| P5-SE-02 | Exposure lifecycle | `DRAFT -> PUBLISHED`, `PUBLISHED -> UNPUBLISHED`, and `UNPUBLISHED -> PUBLISHED` are the only allowed lifecycle transitions. Only `PUBLISHED` permits new Patient Appointment Intents. |
| P5-SE-03 | Historical booking exposure evidence | Patient Appointment Intents snapshot exposure, Offering, Offering Version, and Price IDs. The exposure FK is restrictive; referenced exposure may be unpublished but not hard-deleted. |

## Deferred, non-blocking decisions

| ID | Decision | Approved deferred position |
| --- | --- | --- |
| P5-SE-D01 | Clinic assignment/publication of doctor-owned Offerings | Deferred. A Clinic cannot expose a doctor-owned Offering in this phase. |
| P5-SE-D02 | Multiple exposures and channels | Deferred. Initial scope has one direct exposure per Offering and no channel/surface model. |
| P5-SE-D03 | Publication workflow sophistication | Deferred. No moderation, private/public modes, scheduled publication, marketplace ranking, or discovery behavior. |
| P5-SE-D04 | Tenant-specific doctor schedules and cross-clinic exposure | Deferred. Exposure does not alter availability ownership or create a clinic-managed doctor schedule. |
| P5-SE-D05 | Network `BOOK`/`REFER` workflow mechanics | Deferred and independent. Network capability does not create patient-facing exposure. |

## Implementation status

The Service Exposure architecture is approved and implementation-ready. The
deferred decisions above do not block the minimum direct patient-facing
exposure implementation.
