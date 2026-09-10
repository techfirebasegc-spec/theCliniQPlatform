# theCliniQ Phase 5 Step 5 — Appointment Lifecycle Decisions

## Locked decisions

| ID | Status | Decision |
|---|---|---|
| P5-AL-01 | APPROVED | `PAYMENT_PENDING → CONFIRMED` requires authoritative, verified Razorpay success/capture reconciled to the internal payment intent. Unknown, delayed, conflicting, incomplete, or client facts go to reconciliation; payment success is not completion. |
| P5-AL-02 | APPROVED | Persistent Appointment states: `CONFIRMED`, `IN_PROGRESS`, `COMPLETED`; terminal outcomes: `PAYMENT_FAILED`, `EXPIRED`, `CANCELLED`. `RESCHEDULED` is an immutable event, never a state. |
| P5-AL-03 | APPROVED | Doctor starts after the scheduled window begins. Patient and Clinic Staff have no default start authority; clinic workflow only if explicitly supported; Support/Admin only controlled exception. |
| P5-AL-04 | APPROVED | Doctor completes; Clinic Owner/Admin completes clinic-owned appointments. Patient/Clinic Staff cannot by default. Completion is audited, concurrency-safe, settlement-eligible, and normally blocks cancellation/reschedule. |
| P5-AL-05 | APPROVED | Patient, participating doctor, and Clinic Owner/Admin for clinic-owned appointments may cancel under versioned policy. Original allocation is immutable; refund/adjustment records compensate and actors cannot choose amounts. |
| P5-AL-06 | APPROVED | Reschedule is event-based: reserve new slot before releasing old; immutable original allocation remains; same price needs no payment, higher price uses approved allocation/adjustment, lower price follows versioned policy. |
| P5-AL-07 | APPROVED | Support/Admin exception requires elevated permission, authenticated actor, appointment, mandatory reason, immutable audit, and no financial self-approval. |
| P5-AL-08 | APPROVED | PostgreSQL is transactional authority; Razorpay owns provider facts; theCliniQ owns internal appointment/commercial state; provider calls never occur under locks. |

## Implementation boundary

Appointment is separate from Intent: Intent/Reservation own booking capacity;
handoff/allocation/payment intent own finance; Appointment owns care lifecycle.
It references immutable patient/provider/clinic/tenant, exposure/offering/version/
price, booking context, local/UTC window, reservation, handoff, allocation and
payment evidence. Context alone grants no authority. Future chat, prescriptions,
and files require Appointment participation plus their own consent policies.

Allowed operational transitions are `CONFIRMED → IN_PROGRESS → COMPLETED`;
direct/reverse/terminal reactivation is forbidden. Confirmation, start,
completion, cancellation and reschedule are transactional and audited.

## Deferred, non-blocking decisions

Live Razorpay checkout/credentials and provider payload contract; exact
cancellation timing/fees/refund values; lower-price outcome; settlement execution;
chat, prescriptions, records/files; shared capacity; referral/BOOK capability;
UI and production deployment. No tax, payout, KYC, marketplace, or percentage
policy is introduced.
