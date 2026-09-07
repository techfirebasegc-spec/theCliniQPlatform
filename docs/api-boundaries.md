# Proposed Core REST API boundaries

## Rules

The initial Core API is REST-first, versioned (proposed `/api/v1`), typed, validated, and modular-monolith based. Protected operations evaluate role, tenant membership, resource ownership, appointment participation, NetworkConnection capability, explicit permission, and consent where relevant.

| Domain | Candidate endpoint group | Boundary |
| --- | --- | --- |
| Auth | Google, phone/email OTP, session, logout, linked methods. | CliniQ session/auth ownership; provider verified and rate limited. |
| Accounts / Patients | `/me`, patient profile, saved addresses. | Self-service by default; clinical/operational access is relationship scoped. |
| Tenants / Clinics | Clinic/tenant and membership endpoints. | Membership is limited operational scope, not blanket data access. |
| Network Connections | Request/list/accept/reject/revoke/block; capability review. | Eligible party/authorized actor only; audit every lifecycle change. |
| Referrals | Approved referral/context create/view/status. | Requires connection capability and patient-consent policy; no destination-record leakage. |
| Doctors / public content | Doctors, services, specialties, health, locations, blog. | Public directory data remains curated; management writes are separate. |
| Availability / slots | Read available slots, authorized schedule management, transactional reservations. | Availability view never reserves capacity by itself. |
| Appointments | Appointment intent/create/list/detail/cancel/reschedule. | Stores direct/clinic/referral context and connection snapshot; participant protected. |
| Commercial rules | Privileged rule/version management/evaluation if later approved. | Versioned configuration only; never browser computed. |
| Payments / settlements | Order creation/status, Razorpay webhook, refunds, settlement/reconciliation operations. | Webhook is authoritative/idempotent; beneficiary/operational views are distinct. |
| Prescriptions / chat / files | Issue/read/verify, appointment chat/messages/read state, signed upload/download. | Appointment/role/resource scope governs every call and file access. |
| Notifications / support | Recipient notifications/read state; support/contact/partner/career forms. | Worker-backed and retention/rate-limit controlled. |

Direct Doctor X bookings, Clinic A-context bookings, and Clinic A→Clinic B referrals use the same appointment/payment APIs with different approved context references. They do not require duplicate identities or separate API families.
