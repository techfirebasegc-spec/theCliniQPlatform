# Phased migration plan

## Guardrails

No phase touches reference applications, Firebase, VPS, production, or data without separate approval. Existing patient UI/UX is the acceptance reference. Each phase stops safely in non-production until its evidence gate passes.

| Phase | Objective | Dependencies / deliverables | Risks | Rollback |
| --- | --- | --- | --- | --- |
| 0 — Business/architecture approval | Approve tenant/network, financial, legal/compliance, and UI-parity decisions. | Decision log and approved target model. | Undefined commission/payout/referral rules. | Plans only. |
| 1 — Platform foundation | Approved modular-monolith, DEV Docker/Nginx, secrets/observability/test design. | Phase 0 and future DEV access approval. | Premature credentials/infrastructure. | Remove newly approved DEV only. |
| 2 — Identity/access | Accounts, sessions, Google/phone/email OTP, core roles, tenant membership, audit. | Provider policy and non-production accounts. | Duplicate accounts/broad access. | Disable target auth path; no unapproved merge. |
| 3 — Network/tenant foundation | Clinic/Tenant, Doctor Profile, NetworkConnection/capabilities, optional referral context. | Approved lifecycle/capability/consent rules. | Connection confused with ownership/access. | Isolated DEV records only. |
| 4 — Financial foundation | Commercial rule versions, allocations, payment/settlement/refund state, Razorpay capability validation. | Provider sandbox and business/legal decisions. | Illegal/incorrect fund/payout/tax treatment. | No payment/payout enablement. |
| 5 — Core database/API | PostgreSQL domains, Redis, files metadata, authorization, outbox/jobs. | Phases 2–4 and approved model. | Wrong mapping/data leakage. | Reversible DEV work only. |
| 6 — Public pages | Recreate public UI/SEO/assets/content routes. | UI baselines, content authority. | UI/route drift. | Legacy routes remain authoritative. |
| 7 — Booking | Network-aware booking, capacity, address check, allocation intent. | Phases 3–5 and booking parity baseline. | Double booking/wrong context/allocation. | Release holds; disable target flow. |
| 8 — Profile/My Bookings | Recreate patient profile/address and booking history/cancel/reschedule UX. | Auth/appointments/approved policies. | Data/access regressions. | Keep legacy pages. |
| 9 — Payments/settlements | Razorpay orders/webhooks/refunds/settlements/reconciliation. | Booking, financial foundation, sandbox/provider/legal approval. | Money loss/duplicate events/unauthorized payout. | Stop new orders/payouts and reconcile; never silently reverse funds. |
| 10 — Chat/prescription/other | Appointment chat/files, verification, support/contact/careers. | Files, authorization, retention/consent policy. | Clinical/file disclosure. | Disable target route/endpoint. |
| 11 — Testing/UI parity | UI, accessibility, security, performance, data, payment/settlement rehearsal. | Complete DEV and approved baselines. | Baseline gaps. | Do not enter production. |
| 12 — Controlled production migration | Approved coexistence/cutover, reconciliation, monitoring/support, rollback window. | All prior gates and exact production approval. | Data/payment/chat divergence. | Safe route rollback plus approved reconciliation. |
| 13 — Firebase retirement | Retire only after verified replacement, retention/export and rollback closure. | Stable production and explicit approval. | Premature data/recovery loss. | Pause retirement; never delete without approval. |

**Foundational change:** Network/tenant capability and commercial/settlement design now precede booking. Booking cannot be safely implemented before direct-vs-clinic context, allowed connection, allocation snapshot, and payment/settlement lifecycle exist.
