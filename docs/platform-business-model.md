# CliniQ Platform Business Model

## 1. Platform Overview

CliniQ is a healthcare platform/network marketplace. Patients pay CliniQ for eligible consultations. Clinics and independent doctors participate through explicit relationships. Existing patient UI/UX remains the source of truth.

## 2. Participants

- CliniQ: platform operator, Core API/security operator, payment collection context, configurable commercial-rule owner.
- Clinics: independent organizations/tenant workspaces.
- Doctors: global professional identities, independent or connected to multiple clinics.
- Patients: global accounts/profiles booking directly or through clinic context.
- Clinic staff/admins: tenant-scoped operational accounts.

## 3. Clinic Model

A clinic operates independently in a tenant workspace. It can connect to doctors and clinics; it does not own their identities by default.

## 4. Doctor Model

One Doctor Profile may work independently, join clinics, form multiple connections, and receive appointments through direct or clinic contexts without duplication.

## 5. Patient Model

One Patient Profile can book directly or through clinics. Records are not duplicated; sharing is based on appointment, consent, ownership, role, and policy.

## 6. Clinic ↔ Doctor Connections

An accepted NetworkConnection enables only approved capabilities, such as clinic-context booking. It is not employment, ownership, or broad access.

## 7. Clinic ↔ Clinic Connections

An accepted connection may support approved referrals. Destination care remains destination-clinic context; source visibility is limited by consent/policy.

## 8. Network Connection Lifecycle

Proposed states: PENDING, ACCEPTED, REJECTED, REVOKED, BLOCKED. Records retain parties, capabilities, lifecycle timestamps, actors, and audit. Final semantics are a business decision.

## 9. Appointment Model

Appointment retains Patient, Doctor, service/time/state, direct or clinic context, clinic, NetworkConnection/referral context, Payment, Settlement, and financial allocation snapshot.

### Required scenarios

**Patient → Doctor X through Clinic A:** accepted Clinic A↔Doctor X connection permits the context. Appointment snapshots Clinic A/connection; patient pays CliniQ; allocation calculates configurable platform and doctor amounts; settlement pays Doctor X as applicable.

**Patient → Doctor X directly:** same Doctor X, direct context, no clinic connection, applicable direct commercial rule.

**Clinic A → Clinic B referral:** an accepted connection and patient consent enable referral. The appointment belongs to Clinic B context; Clinic A has no automatic access to Clinic B appointment/payment/chat/prescription data.

All scenarios use the same core model without identity duplication or core redesign.

## 10. Payment Collection

Patient payment to CliniQ uses Razorpay where applicable. Razorpay webhooks are authoritative for payment state.

## 11. CliniQ Platform Commission

Commission is a configurable, versioned commercial-rule result. It can represent gross, platform fee, taxes/charges, processing fee, doctor payable, refunds, and settlement basis. No percentage is hard-coded.

## 12. Doctor Settlement

Settlement is distinct from Payment and tracks payable amount, eligibility/holds, payout status/reference, failures/retries, and reconciliation. Payout method/capability is unconfirmed pending provider/legal review.

## 13. Refunds and Cancellations

Full/partial refunds, fees, cancellation, allocation effects, settlement holds/reversals, and communication are configurable business policies.

## 14. Rescheduling

Rescheduling changes availability/appointment context and may affect payment/allocation/settlement only under approved rules. Existing reschedule UX remains a parity requirement.

## 15. Reconciliation

Reconciliation compares appointment/payment/refund/settlement records to verified provider events and payout evidence, recording discrepancies/resolution audit.

## 16. Authorization Model

Authorization considers identity, role, tenant, membership, connection capability, appointment participation, ownership, explicit permissions, and consent. Connection or membership alone never grants broad access.

## 17. Future Clinic Management Application

Clinic Manager will consume Core API for memberships, connections, scoped availability/appointments, and permitted operations. No UI is built now.

## 18. Future Doctor Management Application

Doctor Manager will use Core API for profile, connections, availability, appointments, prescriptions, and permitted settlement visibility. No UI is built now.

## 19. Patient Web/Mobile Application

Patient applications consume Core API while preserving existing discovery, booking, payment, profile, My Bookings, chat, verification, and notification behavior.

## 20. Business Decisions Still Requiring Confirmation

### Technical decisions

- Final connection capabilities/lifecycle, referral record, realtime transport, object-storage provider, independent-doctor workspace requirement, and Razorpay product capabilities.

### Business decisions

- Commission scope/priority, clinic/doctor agreements, fees, discounts, payout schedule, refund/cancel/reschedule policy, connection authority, referral/status visibility, historical migration scope.

### Legal/compliance decisions

- Fund flow/payout legality, tax/invoicing, KYC/beneficiary obligations, health-data consent/referral disclosure, retention/deletion/audit requirements.

No commercial percentage, tax treatment, payout schedule, or regulatory conclusion is defined here.
