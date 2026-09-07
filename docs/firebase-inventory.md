# Existing CliniQ Firebase inventory

## Inspection scope

This is source-only documentation from the read-only web-project inspection. It does not confirm live Firebase configuration, deployed Function revisions, Firestore documents, indexes in use, Storage objects, authentication provider settings, or rules deployment state. No Firebase connection was made.

## Project services and configuration

- Firebase Hosting is configured for a production target, with static `out/` output, clean URLs, one doctor redirect, API-to-Function rewrite, blog rewrite, and prescription-verification rewrites.
- A Firebase Functions v2 HTTPS Function named `api` is configured in `asia-south1`; it hosts an Express application.
- Firebase Storage rules are configured in `storage.rules`.
- Firebase Authentication configuration declares email/password and Google Sign-In providers. Browser code also implements phone-OTP authentication with invisible reCAPTCHA.
- `firestore.rules` and `firestore.indexes.json` are present. The indexes file is substantial, but indexes were not evaluated against a live project.

## Browser Firebase usage

The legacy transaction modules import Firebase Web SDK version 10.12.5 from the Google CDN. A shared booking config module initializes Auth, Firestore, Functions (`asia-south1`), and Storage.

| Service | Observed browser use |
| --- | --- |
| Authentication | Auth-state subscription; Google popup with mobile/blocked-popup redirect fallback; phone number normalization and OTP/reCAPTCHA flow; sign-out; ID-token retrieval for authenticated REST calls. |
| Firestore | Reads/writes patient user profiles; reads appointments for My Bookings and chat eligibility; creates/updates chat roots and message subcollections; watches doctors, appointments, and messages in real time; reads appointment confirmation after payment. |
| Storage | Uploads chat images/files under appointment chat paths and retrieves download URLs. Career client code also imports Storage APIs; server careers route owns resume persistence. |
| Functions | REST API via Hosting rewrite and named callable calls for order creation, reschedule-order creation, and appointment cancellation. |
| Analytics/notifications | Browser config includes an analytics measurement field, but no Analytics initialization was found. Rules define user/doctor notification paths, but no web UI or FCM/messaging implementation was found. |

The inspected browser source contains inline client Firebase configuration and client payment configuration. This report deliberately does not reproduce values. The new platform must move configuration to approved environment/secrets handling and conduct a security review before any migration.

## Firestore data and access patterns seen in source

| Area | Observed collections/paths and use |
| --- | --- |
| Patients | `users/{uid}` stores `profile`, `address`, completion flags/progress, and update timestamp. Nested `users/{uid}/notifications` has rules. |
| Doctors | `doctors/{doctorId}` is read by booking/chat and queried by REST booking route; source reads nested/basic/professional fields. Nested doctor notifications and availability paths have rules. |
| Appointments | `appointments/{appointmentId}` is queried by patient ID and doctor/date, read after payment confirmation, and used for appointment participant/chat-window checks. |
| Availability | `doctor_availability/{doctorId}_{date}` is read by booking REST logic. |
| Chats | `chats/{doctorId}_{userId}` root with `messages` subcollection; client writes text/image/file messages and metadata. |
| Support | `support_requests` is created by Express support route; rules also mention it. |
| Prescriptions | `prescriptions/{prescriptionId}` is read by verification API; rules restrict authoring/reading. |
| Legacy form data | Express routes write `contacts`, `bookings`, and `applications`; careers may write resumes to Storage under `career-resumes/`. |
| Other rule-covered data | medicines, lab tests, counters, location services, banners, offers, coupons, app config, notifications, employee records, slot locks, and additional nested user/doctor paths. These were not all found in active web UI code. |

## Rules model observed in source

Firestore rules define signed-in, active-admin, active-doctor, appointment-participant, and chat-participant helpers. The principal patterns are:

- admin/doctor role checks derive from the caller's user document;
- patient profile access is tied to ownership with specific admin/doctor exceptions;
- appointment reads are limited to admin or appointment participant, while client writes have constrained fields;
- chat roots/messages and chat attachment metadata use participant checks;
- prescription creation is doctor-only, with doctor/admin read access;
- configuration has public read but admin write;
- various catalog/operations collections are signed-in read or admin-only write.

Storage rules separately gate prescriptions, chat attachments, profile media, doctor media, payslips, promotional images, and career resumes. Chat attachment authorization derives from the linked Firestore chat document. The rules should be tested against target query shapes before migration; rules are not query filters.

## Functions/REST API observed in source

| Endpoint/function area | Behavior |
| --- | --- |
| `api` Function | Express wrapper, CORS, body parsing, request logging, health, route mounting, error handling. |
| Booking REST | Active-doctor lookup, availability from doctor availability + appointment counts, and legacy booking-request creation. |
| Contact | Contact form persistence. |
| Careers | Multipart career application validation/persistence and optional resume upload. |
| Support | Support request creation with priority derived from reason. |
| Prescription verification | Reads prescription by ID and validates provided verification hash/status information. |
| Callable order/cancel flows | The browser calls create-order, reschedule-order, and cancel-appointment callable names. No matching callable exports were found in the inspected local Functions entry point; reconcile the deployed/source contract before migration. |

## Hosting and deployment

Hosting serves `out/`, generated by a guarded mixed Next/legacy build. GitHub Actions includes a main-branch Hosting deploy and pull-request Hosting preview workflow. Both depend on deployment credentials; no credential values are included here.

## Environment/configuration variable names only

The checked-in environment template lists these names only:

- `NEXT_PUBLIC_SITE_URL`
- `NEXT_PUBLIC_FIREBASE_API_KEY`
- `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
- `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
- `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`
- `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`
- `NEXT_PUBLIC_FIREBASE_APP_ID`

The template explicitly states that server-only Firebase Admin credentials, payment-provider secrets, and service-account keys do not belong in browser environment files.
