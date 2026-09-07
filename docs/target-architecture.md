# Proposed target architecture

## Architectural position

CliniQ is a healthcare platform/network marketplace, not a single-clinic system. Independent clinics/organizations operate in their own workspaces while forming controlled clinic-to-doctor and clinic-to-clinic relationships. Doctors and patients are global platform identities; appointments retain the exact clinic and network context through which care was booked. Existing patient UI/UX remains the source of truth.

This is design only: no implementation, connection, migration, or infrastructure work is authorized.

## System architecture: modular monolith

```text
Patient Web/Mobile       Future Clinic Manager       Future Doctor Manager
       └────────────────────── HTTPS ───────────────────────┘
                                  │
                           Nginx / edge
                         ├── Next.js (TypeScript)
                         └── CliniQ Core API (Node.js/TypeScript)
                               ├── PostgreSQL
                               ├── Redis
                               ├── private object storage
                               ├── Razorpay, SMS/email, FCM/APNs adapters
                               └── worker process (same codebase)
```

The Core API starts as one modular monolith, with internal modules for identity, tenancy, network, provider directory, availability, appointments, commercial rules, payments, settlements, chat, files, notifications, prescriptions, and support. This avoids premature microservices while retaining clear module boundaries.

## Frontend/backend boundaries

- Next.js owns pages, rendering, accessibility, responsive states, SEO, and UI parity. It replaces legacy iframe/HTML/CDN runtime implementation but preserves its user experience.
- The Core API owns validation, authorization, commercial evaluation, appointment transactions, payment verification, settlement lifecycle, files, and integrations.
- The browser uses versioned REST endpoints and short-lived signed file flows. It never queries PostgreSQL, calculates commissions, decides payment success, or holds provider secrets.

## Identity, tenancy, and network

An **Account** is one global CliniQ identity. It can independently link a patient profile, doctor profile, clinic memberships, and verified Google/phone/email authentication methods; none are assumed to coexist.

A **Tenant** is an operational/authorization workspace for an independently operated clinic or organization. It is not synonymous with a doctor, patient, or account. Tenant membership grants only scoped operational rights. Whether an independent doctor needs a separate workspace is a business decision, not an automatic technical rule.

`NetworkConnection` is a first-class audited relationship between eligible parties:

- Clinic ↔ Doctor
- Clinic ↔ Clinic

It records requester, recipient, party types, connection type, explicit capabilities, status, requested/accepted/rejected/revoked/blocked timestamps, and actor/audit context. A working lifecycle is `PENDING`, `ACCEPTED`, `REJECTED`, `REVOKED`, and `BLOCKED`; final lifecycle semantics remain a business decision. A connection is neither ownership nor membership, and does not grant broad access to doctor/patient records.

## Appointment, payment, and settlement model

An appointment records patient, doctor, service, schedule, state, and immutable **booking context**: direct platform booking or clinic-context booking. A clinic-context appointment records the clinic and accepted NetworkConnection that enabled the booking. It does not duplicate patient or doctor records.

Clinic-to-clinic referrals use an approved, consent-aware referral/context record. The destination appointment remains in the destination clinic context. An originating clinic has no implied access to destination appointment, chat, prescription, or payment details.

Commercial rules are configurable and versioned, never hard-coded. Evaluation creates a historical **Financial Allocation Snapshot** with gross amount, discounts if approved, taxes/charges, platform fee, processing fee where applicable, doctor payable, refund/settlement basis, and rule/version references.

**Payment** records patient-to-CliniQ payment: order, attempts, provider references, verified webhooks, refunds, and reconciliation. **Settlement** separately tracks an amount payable to a doctor: eligibility/holds, status, payout reference, failure/retry, and reconciliation. Payment success never automatically means settlement is due or paid. Razorpay webhooks are authoritative for payment state where applicable; Razorpay payout/marketplace capabilities, fund flow, taxes, KYC, and regulations require later confirmation.

## Authentication, authorization, and security

- CliniQ-owned sessions use Secure HttpOnly cookies. Google Sign-In, phone OTP, and email OTP are linked methods with verified ownership and Redis-backed rate limits/attempt controls.
- Authorization evaluates account, role, tenant membership, resource ownership, appointment participation, NetworkConnection capability, explicit permission, and patient consent where applicable.
- Appointment participation remains the principal boundary for chat, prescription, clinical files, and booking history. A clinic connection or staff membership alone is never enough.
- PostgreSQL is the transaction/system-of-record layer; Redis supports cache, rate limits, OTP, short-lived holds, jobs, retries, locks, and idempotency coordination but never becomes the money/appointment source of truth.
- Private object storage holds files; PostgreSQL stores authorization/ownership/checksum/retention metadata; API-issued signed URLs enforce access.

## Jobs, API, environments

REST APIs are versioned, typed, validated, idempotent where retried, and transaction/audit/outbox backed. Workers handle OTP, notifications, file scanning, reservation expiry, provider reconciliation, settlements, and delivery retries.

DEV is a separately approved Docker/Nginx VPS environment with synthetic or approved non-production data and non-production providers. Production is separately provisioned later with independent credentials, backup, monitoring, access, incident, and deployment approvals. No infrastructure is configured by this document.
