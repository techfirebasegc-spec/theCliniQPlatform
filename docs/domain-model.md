# Proposed domain model

## Principles

This is a relational domain model proposal, not SQL or a Firestore-table conversion. It separates identity, organization, connection, appointment context, payment, and settlement so doctors/patients are never duplicated just because a clinic context changes.

| Entity | Purpose / important fields | Relationships and ownership |
| --- | --- | --- |
| Account | Global identity, status, verified contact methods, security metadata. | May link to Patient Profile, Doctor Profile, Authentication Methods, Tenant Memberships. |
| Authentication Method / Session | Google/phone/email verified method; session issuance/expiry/revocation. | Belongs to Account; security data, not tenant data. |
| Tenant | Independent clinic/organization operational workspace. | Authorization boundary; is not inherently doctor/patient/account. |
| Clinic / Tenant Membership | Clinic operating identity; membership role, scope, status, active dates. | A tenant can have staff and doctors; membership does not give broad connected-resource access. |
| Patient Profile / Address | Patient details, completion state, saved structured address. | Patient owns own record/address; participates in appointments, chats, prescriptions. |
| Doctor Profile | One global professional record: qualifications, specialties, languages, active/public state, media. | May be independent, have memberships, connect to many clinics, and receive direct or clinic-context appointments. |
| NetworkConnection | Requester/recipient, party types, connection type, capability set, status, lifecycle timestamps, audit. | Clinic–Doctor or Clinic–Clinic; neither ownership nor blanket access. |
| Referral/Booking Context | Optional source/destination connection and consent/reference data. | Links to destination Appointment where approved; source visibility is policy-limited. |
| Specialty / Service Offering | Public/billable discovery and care concepts, publication/booking mode/rule reference. | Links doctors, clinics where approved, availability, and appointments. |
| Availability / Slot / Reservation | Doctor/service/context/time/capacity; short-lived hold with expiry/idempotency. | Reservation safely becomes/releases an Appointment under transaction. |
| Appointment / Appointment Event | Patient, doctor, service, schedule, state, direct/clinic context, clinic, NetworkConnection snapshot, fee/allocation reference; immutable event history. | Core participant boundary for payments, settlement, chat, prescription, files, notifications. |
| Commercial Rule / Rule Version | Configurable scope, inputs, priority, effective period, approval state. | Evaluated at booking; percentages/taxes/schedules never hard-coded. |
| Financial Allocation Snapshot | Gross, approved discounts, tax/charges, platform/processing fees, doctor payable, refund/settlement basis, rule version. | Immutable historical result linked to appointment/payment intent. |
| Payment Order / Payment / Payment Event | Provider order, verified payment, webhook events, amount/currency/status/idempotency/reconciliation. | Links appointment and allocation; webhook outcome is authoritative. |
| Refund / Settlement / Reconciliation | Refund amount/status; doctor payable, eligibility, payout status/reference/retries; discrepancy resolution. | Settlement is independent from Payment and belongs to beneficiary doctor/allocation. |
| Chat Conversation / Message | Appointment-bound chat, allowed window, messages/read state/files. | Participant scoped; connection alone does not permit access. |
| File Metadata / Prescription / Verification | Object key/purpose/ownership/checksum/scan/retention; clinical document and minimal public verification result. | File access follows appointment/role/resource rules. |
| Notification / Support / Enquiry / Career Application | Communication, operations, public forms, employment data. | Separate retention and access policies; not automatically patient care data. |
| Health Article / Author / Reviewer / Source / Location / Blog / Testimonial | Public discovery/educational content. | Editorial ownership/scope requires approval. |

## Scenario fit

- **Clinic A booking Doctor X:** accepted Clinic A↔Doctor X connection capability is snapshotted on an appointment; Patient and Doctor X remain the same global identities; Payment and Allocation Snapshot determine CliniQ/doctor amounts; Settlement tracks doctor payout.
- **Direct Doctor X booking:** same Doctor Profile, direct appointment context, applicable direct commercial rule, no clinic connection.
- **Clinic A referral to Clinic B:** accepted Clinic A↔Clinic B connection and patient-consent-aware referral context route to a Clinic B appointment. Clinic A has no automatic access to Clinic B care/payment data.

The core model supports all three scenarios without redesign or identity duplication.
