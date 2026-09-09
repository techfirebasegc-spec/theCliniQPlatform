# theCliniQ Phase 4 — Financial Foundation implementation plan

## Boundary and non-goals

Phase 4 establishes theCliniQ's internal financial domain only. It does not
create appointments, booking, slots, a customer checkout endpoint, live
Razorpay operations, payout execution, Firebase migration, or UI work.
PostgreSQL is the transactional source of truth; Redis is only suitable for
coordination and future retry scheduling.

## Money convention

All money is a signed `bigint` count of minor currency units paired with a
three-letter ISO currency code. Floating point and FX conversion are prohibited
in Phase 4. Allocation inputs that represent charges are non-negative; ledger
debits and credits use non-negative amounts and their direction conveys sign.

## Domains and tables

* Commercial policy: `commercial_rules`, `commercial_rule_versions`, and
  `commercial_rule_scopes` hold controlled rule types, priority, effective
  periods, calculation/bearer/funding decisions, and versioned JSON policy
  data. A same-priority match is rejected by the evaluation service.
* Versioned policy: `refund_policy_versions`, `settlement_policy_versions`,
  `retry_policy_versions`, and `retention_policy_versions` hold effective
  policy data. No business percentage or window is in application code.
* Allocation: immutable `financial_allocation_snapshots` and
  `financial_allocation_components` preserve selection inputs, selected rule
  versions, exact calculation outcome, and component-level monetary values.
  `financial_adjustments` and `financial_adjustment_approvals` correct history;
  they never alter an allocation.
* Operational finance: `payment_intents`, `payments`, `refunds`,
  `settlements`, `settlement_attempts`, and `provider_references` model
  idempotent lifecycle state without appointment foreign keys.
* Provider/webhook/reconciliation: `provider_webhook_events` is immutable and
  deduplicated by provider/event identity. `reconciliation_records` preserves
  deterministic provider/internal matching and manual-review state.
* Ledger: `ledger_accounts`, `ledger_transactions`, and `ledger_entries` form
  an append-only balanced double-entry ledger. A deferred PostgreSQL trigger
  rejects unbalanced posted transactions; triggers reject updates/deletes of
  posted ledger records and allocation snapshots.
* Retention: `legal_holds` attaches a category/context legal hold to prevent
  future retention processing. No deletion worker is included.

## State machines

* Payment intent: `CREATED → PENDING_PROVIDER → AUTHORIZED → SUCCEEDED`, with
  `FAILED`, `EXPIRED`, or `RECONCILIATION_REQUIRED` terminal/operational paths.
* Payment: `PENDING → SUCCEEDED|FAILED|EXPIRED|RECONCILIATION_REQUIRED`.
* Refund: `REQUESTED → PROCESSING → SUCCEEDED|FAILED|RECONCILIATION_REQUIRED`.
* Settlement: `PENDING_ELIGIBILITY → ON_HOLD → ELIGIBLE → SCHEDULED →
  PROCESSING → SUCCEEDED`, with `FAILED`, `REVERSED`, and
  `RECONCILIATION_REQUIRED` alternatives. A settlement cannot be made eligible
  until a future appointment-completion signal is supplied.
* Webhook: `RECEIVED → AUTHENTICATED → PERSISTED → PROCESSING → PROCESSED|
  RETRY_PENDING|RECONCILIATION_REQUIRED|UNKNOWN`. Valid unknown types remain
  persisted without changing financial state.
* Adjustment: `REQUESTED → APPROVED|REJECTED → EXECUTED`; self-approval is
  forbidden and sensitive/threshold behavior comes from policy data.

## Provider abstraction and webhook model

`PaymentProvider` supplies server-only boundaries for order creation,
verification, signature verification, refund, settlement, and reconciliation.
`RazorpayPaymentProvider` is a configuration-free adapter boundary: it has no
live credential, network, checkout, or payout call in Phase 4. Webhook events
are signature-verified before persistence by the provider boundary; the
repository stores an authenticated event identity, immutable raw payload,
parsed JSON payload, payload hash, and handler/schema metadata. It never stores
the webhook signature or provider credential. Provider facts are never
overwritten.

## Authorization and audit

There are no public financial routes in this phase. Services require a
server-derived authenticated account and fail-closed financial-authorization collaborator;
caller-supplied tenant/provider identity cannot establish authority. Financial
service outcomes use the existing audit boundary and omit raw provider secrets,
webhook signatures, and payload values from metadata. Future platform financial
roles remain intentionally unpersisted.

## Idempotency, concurrency, and retention

Every mutation carries a caller-generated idempotency key scoped by operation;
PostgreSQL unique constraints own duplicate prevention. Repositories lock
operational rows with `FOR UPDATE` before state transitions. Webhook provider
event identity is the primary deduplication key and payload hash is only an
integrity fingerprint. Retention policy versions and legal holds are modeled;
the future worker must honor holds and audit every action.

## Test strategy

Unit tests cover exact minor-unit arithmetic, rule matching/priority/effective
dates/ambiguity, allocation immutability, state transitions, idempotency,
provider boundary, webhook replay/out-of-order/unknown events, adjustment
separation of duties, and ledger balance. The migration verification uses a
fresh disposable PostgreSQL database to prove constraints, append-only triggers,
and reversible UP/DOWN behavior. Existing identity, tenancy, membership, and
network tests remain required regressions.

## Future dependencies

Booking will provide appointment completion/context and invoke allocation and
payment-intent services. A separately approved provider/legal decision is
required before Razorpay Route, beneficiary onboarding, live payment, payout,
or settlement execution. Historical Firebase financial migration remains
explicitly out of scope.
