# CliniQPlatform migration plan

## Status

Planning scaffold only. No migration is authorized or in progress. No reference project, Firebase service, database, VPS, production system, or credential has been accessed.

## Goal

When authorized, modernize the platform architecture and backend while preserving the existing CliniQ web UI, UX, workflows, and functionality. The legacy web application remains the user-visible source of truth; the existing Flutter application informs a future mobile effort.

## Required approval sequence

1. Authorize read-only reference discovery and document the current UI, routes, workflows, data contracts, and dependencies.
2. Approve the target architecture, data model, security model, and API contracts.
3. Approve a detailed source-to-target mapping and a non-production migration rehearsal plan.
4. Approve test environments, test data handling, and UI-regression baselines.
5. Approve controlled migration execution, reconciliation criteria, rollback plan, and cutover decision separately.
6. Approve any production access, deployment, or VPS setup as a distinct operation.

## Migration principles

- Keep the two existing CliniQ projects read-only.
- Do not copy data or code merely because it exists; authorize each source and scope.
- Prefer rehearsable, idempotent steps with auditable validation and rollback.
- Preserve data integrity, authorization boundaries, and user-visible behavior.
- Never weaken security, use unapproved production credentials, or commit secrets.
- Report discrepancies and unresolved business rules for user decision rather than inventing mappings.

## Evidence required before a future cutover

- Approved inventory and mapping of in-scope features/data.
- Security review of target access controls and sensitive-data handling.
- Successful non-production rehearsal with reconciliation results.
- UI/UX regression evidence against authorized baselines.
- Verified rollback procedure.
- Explicit user approval for the exact cutover scope and environment.
