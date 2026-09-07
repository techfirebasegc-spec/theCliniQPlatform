# Firebase-to-PostgreSQL mapping

## Mapping rule

This is a conceptual replacement map, not a schema or data migration. The new network, commercial-rule, settlement, and referral capabilities have no established Firebase equivalent in the reports and must not be invented as historical data.

| Firebase area | Current responsibility | Target replacement | Difficulty / risk |
| --- | --- | --- | --- |
| Firebase Auth | Google/phone OTP, auth state, ID tokens; email/password configured. | Account, linked authentication methods, CliniQ sessions, Google/phone/email OTP. | High: identity matching and non-portable credentials. |
| Firestore users/doctors | Patient profile/address and doctor profile/operations. | Account, Patient Profile, Address, Doctor Profile, optional Tenant Membership. | High: mixed role/profile data; doctors cannot be duplicated per clinic. |
| Appointments/availability/locks | Booking, capacity, doctor/date availability. | Availability/Slot, Reservation, Appointment, Event. | Very high: capacity/payment/deployed callable contracts. |
| Chats/messages | Participant messages, read state. | Appointment-bound Chat Conversation/Message. | High: preserve time window and participant scope. |
| Prescriptions/files | Prescription/verification and Storage objects. | Prescription/Verification/File Metadata + private object storage. | High: clinical privacy, retention, signed access. |
| Support/forms/catalog/notifications | Operational/public submissions and rule-covered configuration. | Separate Support/Enquiry/Career/Notification/catalog domains. | Medium/unknown: authority/active use not established. |
| **No verified Firebase source** | Clinic↔Doctor/Clinic↔Clinic marketplace, referral, commission, payout/settlement. | NetworkConnection, Capability, Referral Context, Commercial Rule/Allocation, Settlement/Reconciliation. | Critical discovery: determine historical treatment explicitly. |
| Functions/Express | REST plus browser-referenced callable payment/reschedule/cancel flows. | TypeScript Core REST API, jobs, verified Razorpay webhooks. | High: source/deployed callable discrepancy. |
| Security/Storage Rules | role/participant/path-based Firebase authorization. | API relationship/tenant/capability checks, private infrastructure, signed files, audits. | Very high: connection/membership must not become broad access. |
| Hosting | static output, rewrites, legacy bridge, deployment workflows. | Dockerized Next/API/worker behind Nginx, separately approved CI/CD. | Medium: URLs, SEO, UX and deployment safety. |

Existing appointments may lack verified clinic/network/allocation/settlement context. Historical policy must decide whether to map evidence, mark unknown, or apply the new model only to new-platform activity. Razorpay payout capabilities and legal/commercial treatment require provider and legal confirmation before settlement execution design.
