# Existing web migration risk assessment

## Status and scope

This assessment is planning evidence only. No migration, connection, test, Firebase operation, VPS operation, production operation, package installation, or code copying is authorized or has occurred.

## Highest-priority risks

| Risk | Evidence from source | Impact | Required control before migration |
| --- | --- | --- | --- |
| Hybrid frontend boundary | Next public routes coexist with legacy HTML iframe transaction pages, a custom output merger, and two CSS systems. | High risk of visually or behaviorally breaking booking/profile/chat while modernizing public pages. | Capture browser UI baselines and replace flows one bounded route at a time without changing UX. |
| Incomplete backend contract | Browser source calls named callable order/reschedule/cancel Functions; the inspected local Functions export exposes only REST `api`. | Payment/appointment actions may depend on missing, deployed-only, or divergent backend behavior. | Perform approved source/deployment contract reconciliation before target design or any cutover. |
| Direct client Firebase coupling | Legacy browser modules directly query/write Firestore and Storage and encode appointment/chat behavior. | High authorization, data-integrity, and backward-compatibility risk. | Model explicit APIs/authorization; preserve participant-scoped access; validate rules/query behavior. |
| Payment criticality | Booking uses Razorpay checkout, order creation, payment confirmation polling, and rescheduling. | Revenue/appointment confirmation failures and duplicate or lost bookings. | Obtain approved end-to-end payment state model, idempotency approach, failure/retry behavior, and non-production test plan. |
| Healthcare data sensitivity | Profiles, appointments, chats, uploads, and prescriptions are present. | Privacy/security exposure if controls are broadened or mappings guessed. | Security review, least privilege, data classification, retention decisions, and access tests before migration. |
| UI parity requirement | Public and transactional systems have distinct visual components and responsive styles. | A technically successful rewrite could violate the source-of-truth UI/UX requirement. | Establish approved desktop/mobile visual and interaction regression baselines before recreation. |

## Significant implementation risks

1. **Duplicated and mismatched frontend dependencies.** The root uses Next 16/React 19, while transactional browser pages load React 18, React DOM, and HTM from a remote CDN. Recreating the UI should not copy this mixed runtime; the UX needs a clean component implementation with parity tests.
2. **Duplicate client configuration.** Firebase initialization appears in multiple browser modules. The source also contains inline client configuration and payment-key material. Do not replicate values into the new workspace; use approved non-production configuration and secrets boundaries.
3. **Iframe integration.** `LegacyTransactionalShell` changes source path by environment and dynamically measures iframe height. It has potential routing, accessibility, focus, resize, SEO, browser-history, and responsive regression risk. The new architecture should replace the bridge only after equivalent transactional screens are verified.
4. **Static-export constraints.** The current app relies on static generation, Hosting rewrites, and a custom allowlist/route-snapshot build script. Dynamic server behavior and route ownership must be planned carefully so that legacy artifacts cannot overwrite modern output.
5. **Rules/query compatibility.** The client uses filtered appointment queries and real-time subscriptions. Target database/API design must preserve patient/doctor participant isolation and test query authorization; broad user-document reads are not an acceptable shortcut.
6. **Chat and uploads.** Chat availability is calculated from appointment status/time in the browser and supports text, image, file, and prescription message types. Storage object path ownership, metadata, content validation, upload limits, signed/download URL policy, and message ordering need explicit target requirements.
7. **Profile/address dependencies.** Home physiotherapy communicates a saved-address prerequisite; profile completion and structured address data are part of booking expectations. Preserve field semantics and incomplete/error states unless the user approves a change.
8. **Legacy API overlap.** Both `/booking` and `/api/booking` paths are mounted; legacy form code and modern booking code use different contracts. Inventory actual usage and deprecate only through an approved compatibility plan.
9. **Deployment exposure.** Existing GitHub workflows deploy a production Hosting target on main-branch push and create PR previews. The new platform must not inherit this behavior until CI/CD, environments, credentials, and approval gates are separately designed.
10. **Limited automated coverage.** No dedicated test suite was found. Lint, typecheck, and build scripts do not establish functional parity for user workflows.

## Existing technical debt indicators

- Two distinct page/component/style architectures coexist in the same deliverable.
- Public Next routes and legacy routes overlap conceptually; the custom output merger maintains the boundary.
- Legacy HTML includes older marketing pages while transactional pages are React mounted into static shells.
- The large legacy stylesheet combines global, page, component, state, payment, chat, and responsive rules.
- Browser modules use remote unpinned-by-lockfile CDN imports for core UI/runtime dependencies.
- Static legacy JSON, TypeScript public-content data, Firestore data, and API-returned data coexist as sources of truth.
- Checked-in workflow artifact files increase repository noise and obscure CI configuration.
- Local source lacks an evident dedicated automated test suite and no browser parity evidence was produced here.

## Migration sequencing recommendation (planning only)

1. Obtain approval for a read-only feature/data/API contract inventory, including live/deployed behavior only where separately authorized.
2. Capture approved UI/UX baselines for all public and transactional routes, viewport sizes, form/empty/error/auth/payment states, and CTA destinations.
3. Approve the target architecture, API boundary, database model, authorization model, and non-production environments.
4. Recreate public route components first with visual regression evidence; preserve existing URLs and metadata behavior as required.
5. Recreate transactional flows individually: authentication/profile, doctor availability/booking, payment confirmation/rescheduling/cancel, My Bookings, then chat/uploads/prescription verification.
6. Rehearse data/API migration in non-production with reconciliation, idempotency, rollback, and participant-access tests.
7. Present exact cutover scope, production checklist, rollback plan, and evidence for explicit approval. Do not deploy or connect production as part of planning.

## Decisions still required from the user

- Whether the new platform should retain every legacy public URL and static page, including older marketing/blog routes.
- Whether legacy static public data is authoritative, transitional, or must be reconciled with Firebase data.
- The source of truth and approved backend contract for payment/order/reschedule/cancel behavior.
- Target hosting/runtime, PostgreSQL scope, and whether any Firebase service will remain after migration.
- Data-retention, transfer, and access policies for health-related profile, appointment, chat, attachment, and prescription records.
- Required UI parity level and approved browsers/devices for acceptance testing.
