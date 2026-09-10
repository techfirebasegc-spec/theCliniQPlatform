# theCliniQ Phase 5 Step 4 — Payment Handoff open decisions

## Approved with conditions — implementation gates

| ID | Decision needed | Why it blocks the minimum handoff | Owner / status |
| --- | --- | --- | --- |
| P5-PH-B01 | Resolve a non-secret server configuration `provider_key` through a validated adapter registry at startup and inject it through the composition root. | `payment_intents.provider_key` is required. It must never come from the request body, Appointment Intent, tenant, database row, or patient, and it must not enable Razorpay credentials or live provider calls. | **APPROVE WITH CONDITION** — configuration/adapter approval remains a gate. |
| P5-PH-B02 | Use a server-side selector limited to active commercial rules, approved/effective rule versions, and server-derived provider/service/`PATIENT_PROVIDER` scopes. | No match or ambiguous highest-priority match must fail closed before any allocation, payment-intent, or bridge row exists. No commercial value may be invented. | **APPROVE WITH CONDITION** — approve this fail-closed behavior and ensure applicable policy data exists when handoff is enabled. |
| P5-PH-B03 | Use the booking-owned one-to-one bridge with a shared-executor handoff repository/service, bridge guards, deferred `PAYMENT_PENDING` invariant, Appointment Intent transition guard, and allocation-component immutability correction. | Existing FinancialService transactional methods must not be nested inside the Appointment transaction. The bridge is the smallest linkage that preserves Phase 4 generic financial ownership. | **APPROVE WITH CONDITION AFTER DESIGN REVISION** — explicit shared-executor and narrowly scoped immutability-correction approval remain gates. |

## Decisions that may be resolved during implementation after the blockers

| ID | Decision | Required constraint |
| --- | --- | --- |
| P5-PH-T01 | Canonical server fingerprint encoding and server-derived provider idempotency-key format. | It must bind actor, Appointment Intent, operation, and client key; it must be opaque, collision-resistant, never logged, and stable on retry. |
| P5-PH-T02 | Exact JSON schema for immutable allocation `input_data`. | It must include only server-derived booking IDs/snapshots and selected-policy identifiers; bridge/trigger checks must reject a mismatch. It must not contain credentials, tokens, payment payloads, or unnecessary patient data. |
| P5-PH-T03 | SQL implementation form for the Appointment Intent transition guard, deferred bridge/intent consistency guards, and allocation-component immutability trigger. | The database, not only the service, must reject invalid direct-SQL state transitions, `PAYMENT_PENDING` without a consistent allocation/payment/handoff, and allocation-component UPDATE/DELETE. |
| P5-PH-T04 | Internal API error envelope and HTTP status mapping. | It must preserve existing generic authorization/conflict behavior and avoid revealing whether another Account owns an intent. |

## Explicitly deferred—not blockers for the internal handoff

- **P5-L02 provider/payment consequences:** Razorpay confirmation for provider
  orders, additional payments, refunds, credits, and reconciliation. This is a
  blocker for live provider operations, not for an internal `CREATED` payment
  intent after P5-PH-B01 is resolved.
- **P5-B03:** Clinic→Doctor `BOOK` workflow mechanics. Direct Patient handoff
  uses only a patient-owned direct booking context.
- **P5-B04/P5-L01:** cancellation, refund timing/category, and commercial
  treatment.
- **P5-B05:** reschedule product policy.
- **P5-B06:** completion evidence.
- **P5-B07/P5-L03:** home-visit/address and referral-consent policy.
- **P5-L04:** exceptional platform intervention.
- Shared provider capacity pools, clinic assignment/publication of
  doctor-owned offerings, UI, production deployment, Firebase migration, and
  payment-provider credential configuration.

## Guardrail

No open decision is resolved by a default, hard-coded money value, payment
provider behavior, credential, tax treatment, refund rule, or legal policy.
The remaining implementation gate is explicit approval of the shared-executor
design, allocation-component immutability correction, provider configuration,
and fail-closed commercial-rule behavior. Until then, Step 4 remains
planning-only and fails closed rather than implementing a partial financial
path.
