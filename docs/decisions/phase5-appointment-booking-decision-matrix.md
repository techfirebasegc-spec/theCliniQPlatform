# theCliniQ Phase 5 — Appointment & Booking decision matrix

## Approved and locked decisions

| ID | Decision | Locked position |
| --- | --- | --- |
| P5-A01 | Booking relationships/capabilities | Patient→Doctor and Patient→Clinic are allowed. Clinic→Doctor requires explicit bilateral `BOOK`. Clinic→Clinic requires approved referral plus patient consent. Doctor→Doctor is prohibited. `DISCOVER`/`CONTACT` never grant booking; `REFER` remains separate. |
| P5-A02 | Service and pricing | Doctor/clinic providers own Service Offerings and versioned provider prices. Price changes affect future bookings only. Phase 4 commercial rules calculate platform allocation; historical pricing/allocation context is immutable. |
| P5-A03 | Availability/capacity | IANA timezone; recurring working periods, breaks, leave, holidays, blocked/one-off exceptions; duration/buffer on offering version; capacity reservation; derived slots rebuildable only; PostgreSQL authority; Redis cache-only; explicit expiry; new capacity before old release; DST testing. |
| P5-A04 | Primary lifecycle | `APPOINTMENT_INTENT → SLOT_RESERVED → PAYMENT_PENDING → CONFIRMED → IN_PROGRESS → COMPLETED`, with `CANCELLED`, `EXPIRED`, `PAYMENT_FAILED`, `RESCHEDULED`, and reconciliation paths. Payment success alone is not confirmation. |
| P5-A05 | Completion | Doctor completes. Clinic owner/admin completes clinic-owned appointments. Staff, patient, support/admin have no default completion authority. Completion is audited and makes settlement policy-evaluable; patient confirmation is not required. |
| P5-A06 | Cancellation/refund | Patient self-cancel, doctor participant cancel, clinic owner/admin clinic-context cancel, and controlled exceptional platform cancellation. No caller chooses refund amount; policy determines effects; no ordinary post-completion cancellation; corrections use controlled adjustment/reversal. |
| P5-A07 | Reschedule/payment | Secure new capacity before releasing old. Same price creates no additional payment; higher/lower difference uses new allocation/adjustment under policy. Provider facts are server-verified/reconciled; PostgreSQL serializes concurrent reschedules. |
| P5-A08 | Creation/payment timing | Validate service/context, reserve capacity, create immutable allocation before payment intent, persist `PAYMENT_PENDING`, then verify/reconcile provider facts before confirmation. Expiry releases capacity; late facts enter reconciliation; Razorpay remains non-production. |
| P5-A09 | Service Offering ownership and assignment | Every Service Offering has exactly one explicit PostgreSQL-enforced owner: `owner_doctor_profile_id` or `owner_clinic_id`, never both/neither. Doctor-owned and clinic-owned mutation follow existing Account ownership and tenant-permission boundaries. A clinic can expose a doctor-owned offering only through a future explicit assignment/publication relationship; that relationship has its own authorization/lifecycle and never transfers ownership. |
| P5-A10 | Availability configuration vocabulary | Versioned/configurable vocabulary includes slot duration, buffers, capacity, booking lead/horizon, recurrence rule, IANA provider timezone, and exception type. No numeric/default/business values are approved. Local recurring availability resolves to UTC appointment instants; DST ambiguity/nonexistent-time policy is an implementation decision requiring tests. PostgreSQL reservations, not configuration or derived slots, remain booking authority. |

## A. Remaining business decisions

| ID | Decision | Status | Required outcome before implementation |
| --- | --- | --- |
| P5-B01 | Service Offering ownership/assignment architecture | **APPROVED / RESOLVED** | Exact-one doctor-or-clinic ownership, explicit FK/check enforcement, and non-transferring future clinic assignment/publication are locked by P5-A09. Publication/moderation and a clinic's exposure of doctor-owned offerings remain later business decisions. |
| P5-B02 | Availability configuration vocabulary | **APPROVED / RESOLVED** | The versioned vocabulary and IANA/local-time model are locked by P5-A10. Concrete values and recurrence/holiday/exception vocabulary remain business configuration inputs; no defaults are implied. |
| P5-B03 | `BOOK` and `REFER` workflow mechanics | NEEDS BUSINESS DECISION | Proposal/acceptance/revocation/re-grant semantics, actor authority, and whether a clinic action creates a patient-facing context. |
| P5-B04 | Cancellation timing and category semantics | NEEDS BUSINESS DECISION | Eligible states/windows and patient/doctor/clinic/platform/no-show/provider-unavailable categories; no financial values are selected. |
| P5-B05 | Reschedule product policy | NEEDS BUSINESS DECISION | Whether service/provider/context changes are allowed and customer communication/credit behavior. |
| P5-B06 | Completion evidence | NEEDS BUSINESS DECISION | Required doctor/clinic evidence and any future staff authority configuration. |
| P5-B07 | Home-visit/address eligibility | NEEDS BUSINESS DECISION | When address is required, who sees it, and how location eligibility is determined. |

## B. Remaining legal, compliance, and accounting decisions

| ID | Unresolved decision | Required outcome before affected functionality |
| --- | --- | --- |
| P5-L01 | Refund/reschedule commercial treatment | Configurable refund percentages, tax/fee/commission and provider-payable effects, with accounting approval. |
| P5-L02 | Provider/payment consequences | Razorpay/provider confirmation for additional payment, refund, credit, and reconciliation effects. |
| P5-L03 | Health/location privacy and referral consent | Consent, disclosure, retention, and destination-visibility legal policy. |
| P5-L04 | Exceptional platform intervention | Least-privilege legal/audit requirements for support/admin cancellation or correction. |

## C. Technical decisions resolvable during implementation

| ID | Decision | Required proof |
| --- | --- | --- |
| P5-T01 | Materialized slots versus derived-only read model | Performance/correctness comparison; canonical reservation remains PostgreSQL. |
| P5-T02 | Range exclusion plus capacity accounting versus equivalent locked capacity ledger | Disposable PostgreSQL contention, capacity, expiry, and reschedule-race tests. |
| P5-T03 | Timezone/DST library and ambiguity policy implementation | Deterministic IANA/DST unit and integration tests. |
| P5-T04 | Idempotency retention/schema layout | Replay, changed-payload conflict, crash/retry, and authorization tests. |
| P5-T05 | Async expiry/reconciliation job mechanism | Job retry/recovery proof; database state remains authoritative. |
| P5-T06 | Appointment API shape and future UI compatibility | REST security contract plus Playwright parity baseline; no UI redesign. |

## D. Historical Firebase migration decisions

| ID | Decision | Current position |
| --- | --- | --- |
| P5-H01 | Scope | No historical Firebase appointment/booking migration is approved in Phase 5. |
| P5-H02 | Evidenced fields | Existing inventory supports appointment, doctor/date, availability, and payment-confirmation evidence only. |
| P5-H03 | Missing context | Clinic, network, referral, allocation, payment, settlement, and deployed callable facts may be absent; mark `UNKNOWN` or exclude after approved mapping. |
| P5-H04 | Legacy contract | Reconcile browser callable order/reschedule/cancel usage with deployed behavior before compatibility/cutover planning. |

## Preconditions before coding

1. P5-B01 and P5-B02 are resolved architecturally by P5-A09/P5-A10. Resolve
   only the remaining P5-B03–P5-B07 and P5-L01–P5-L04 that apply to the
   intended implementation slice. Concrete availability values are later
   configuration inputs, not an authorization to invent defaults.
2. Approve a concrete `BOOK` capability workflow before any Clinic→Doctor
   booking implementation, and a separate `REFER`/consent workflow before
   Clinic→Clinic referral work.
3. The Service Offering ownership/version architecture is approved. Approve
   publication/moderation and clinic assignment/visibility policy before any
   clinic exposure of a doctor-owned offering.
4. Establish the PostgreSQL concurrency and browser parity evidence gates.
5. Authorize a small reviewed implementation sequence; this document is not
   implementation approval.
