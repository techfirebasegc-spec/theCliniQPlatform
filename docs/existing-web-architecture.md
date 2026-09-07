# Existing CliniQ web architecture inventory

## Inspection boundary and status

This is a read-only source inventory of `D:\project\theCliniQwebapp` performed on 2026-09-07. No source, configuration, dependency, Firebase, hosting, deployment, or GitHub state was modified. The Flutter reference at `D:\project\theCliniQ` was not inspected.

## Project structure

```text
theCliniQwebapp/
├── app/                         Next.js App Router public pages and metadata
├── components/                  React layout, content-directory, and embed components
├── lib/                         static public-content data and SEO metadata
├── public/                      legacy HTML pages, browser JavaScript, CSS, images, JSON data
├── functions/                   Firebase Functions v2 Express API
│   ├── routes/                  booking, contact, careers, support, prescription verification
│   ├── middleware/              async wrapper, error handler, not-found handler
│   └── utils/                   HTTP errors and request validation
├── scripts/build-hosting-output.mjs
├── .github/workflows/           production Hosting and pull-request preview workflows
├── firebase.json                Hosting, Functions, Storage, Auth provider configuration
├── firestore.rules / indexes    Firestore authorization and indexes
├── storage.rules                Firebase Storage authorization
├── next.config.ts               static-export Next configuration
├── package.json                 Next.js/React frontend dependencies and scripts
└── functions/package.json       Express/Firebase Admin/Functions backend dependencies
```

The repository also contains generated/local directories (`.next`, `.firebase`, `out`, `node_modules`) and an unusually large `.github/workflows/firebase-deploy_files/` directory of CSS/image artifacts alongside the workflow files.

## Frontend architecture

The application is a hybrid static Hosting build:

- **Next.js App Router** owns the current public routes. `next.config.ts` sets `output: "export"`, React strict mode, unoptimized images, and remote image support for Unsplash and Firebase Storage.
- **Static content modules** under `lib/public-data/` provide typed, compile-time doctor, service, specialty, health, location, author, reviewer, and content-reference data. Pages use static parameter generation, metadata, canonical links, and JSON-LD.
- **Shared React shell**: `app/layout.tsx` renders `SiteHeader` and `SiteFooter`; `app/globals.css` defines its design system.
- **Legacy transactional pages** remain raw HTML in `public/`, augmented by browser JavaScript. The current Next routes `/booking`, `/profile`, `/my-bookings`, `/chat`, and `/verify-prescription` render `LegacyTransactionalShell`, an iframe pointed at a copied `/legacy/*.html` artifact in production.
- **Build merger**: `scripts/build-hosting-output.mjs` runs `next build`, protects Next-owned output routes by hash, copies an allowlisted set of legacy assets/pages, moves embedded transactional pages to `out/legacy/`, injects the announcement script into copied legacy pages, and scans the output for server-credential patterns.

This means the published product is not a single frontend runtime: public content is React/Next, while patient transactional flows are legacy HTML with remote ESM React 18/HTM modules and direct Firebase browser SDK calls.

## Current Next.js routes

| Route | Implementation | Purpose |
| --- | --- | --- |
| `/` | `app/page.tsx` | Marketing home: doctors, services, health guides, process, app promotion, booking CTA. |
| `/about` | `app/about/page.tsx` | Platform information and feature/service/health/booking links. |
| `/doctors` and `/doctors/[slug]` | doctor components + static data | Directory and profile pages; profile links to booking with doctor context. |
| `/services` and `/services/[slug]` | service components + static data | Service directory/detail pages, linked doctors/specialties, booking CTA. |
| `/specialties` and `/specialties/[slug]` | specialty components + static data | Specialty directory/detail pages and related booking paths. |
| `/health` and `/health/[slug]` | health components + static data | Educational article hub/detail pages with attribution, sources, disclaimer, and related content. |
| `/locations` | `PublicRouteShell` | Service-area listing or unavailable state. |
| `/booking`, `/profile`, `/my-bookings`, `/chat`, `/verify-prescription` | `LegacyTransactionalShell` | Next metadata/header/footer around legacy iframe flows. |
| `/robots`, `/sitemap` | route handlers | Search indexing assets. |

The header also links to legacy public pages `/blog`, `/contact`, and the Google Play listing. Firebase Hosting rewrites `/blog/**` to the legacy blog post shell and `/verify-prescription/**` to the legacy verifier; `/api/**` routes to the `api` Function in `asia-south1`.

## Legacy HTML pages and JavaScript responsibilities

| Legacy page | Primary responsibility | Browser modules |
| --- | --- | --- |
| `index.html` | older marketing home and doctor/service CTAs | `app.js`, `doctors.js` |
| `services.html`, `doctors.html` | older service/doctor directories | `app.js`, optionally `doctors.js` |
| `booking.html` | multi-step consultation booking and payment UI; support modal | `booking-app.js`, `booking/booking-page.js`, `booking.js` |
| `profile.html` | sign-in and patient profile/address editor | `profile.js`, `booking/profile-page.js` |
| `my-bookings.html` | appointment list/actions | `my-bookings.js`, `booking/my-bookings-page.js` |
| `chat.html` | appointment-bound chat and attachments | `chat.js`, `booking/chat-page.js` |
| `verify-prescription.html` | QR/query-based prescription-integrity result | `verify-prescription.js` |
| `contact.html` | contact submission form | `contact.js`, `lib/forms.js`, `lib/api.js` |
| `careers.html` | career application and resume upload | `careers.js` |
| `join.html` | partner enquiry form | `join.js` |
| `blog.html`, `blog/index.html`, `blog/post.html` | client-rendered blog list/filter/detail | `blogs.js`, `blog-post.js` |

Shared legacy modules provide responsive navigation, booking/contact anchor behavior, active navigation, header scroll behavior, reveal animation, authentication-aware legacy navigation, form sanitization/validation, and JSON/FormData API helpers. `booking/config.js` centralizes Firebase browser SDK initialization, Google and phone-OTP login, auth-state watching, ID-token retrieval, and Functions/Firestore/Storage clients.

## Backend/API architecture

`functions/index.js` exports one Firebase Functions v2 HTTPS entry point named `api`, backed by Express in `asia-south1`. It enables CORS, JSON/urlencoded bodies, request logging, health endpoints, route modules, and centralized error/not-found middleware.

Observed REST routes include:

- `POST /api/contact` — contact document creation.
- `GET /api/booking/doctors` and `GET /api/booking/availability` — doctor and slot data for the booking UI.
- `POST /api/booking` and `POST /api/booking/request` — legacy booking request submission.
- `POST /api/careers` — career application with optional resume upload.
- `POST /api/support` — support request submission.
- `GET /api/prescriptions/verify` — prescription verification.
- `/health` and `/api/health` — API health responses.

The browser also calls named Firebase callable Functions for order creation, rescheduling, and cancellation. They are referenced by the booking/My Bookings code but no matching exports were found in the inspected local `functions/index.js`; treat this as a migration/runtime dependency that needs reconciliation before implementation.

## Assets, style, and reusable candidates

Assets live in `public/assets/images/` (14 PNGs including logo, doctor, healthcare, Google-login, and blog images) plus `public/data/` JSON files for legacy blog/doctor/testimonial content. The Next app additionally uses static TypeScript public-content data and some Firebase Storage/Unsplash image URLs.

Potential **future reuse candidates**, subject to explicit approval and licensing/ownership review:

- public-content data shape and public React component composition;
- visual tokens and shared layout patterns in `app/globals.css`;
- doctor profile module CSS and local brand/image assets;
- legacy behavior specifications for booking, profile, My Bookings, chat, and prescription verification;
- API validation and route contracts where they accurately reflect approved behavior.

Parts that should be **recreated, not copied as the target architecture**:

- the iframe/legacy-page bridge and static-output merge script;
- remote CDN React/HTM transactional runtime;
- duplicated Firebase initialization/auth navigation code;
- legacy HTML/CSS/JavaScript page implementations;
- direct browser-side backend/data coupling. 

No reuse action has been taken by this inspection.

## Build, deployment, tests, and dependencies

Root scripts are `dev`, `build`, `build:hosting`, `start`, `lint`, and `typecheck`. Root dependencies are Next.js 16, React 19, React DOM 19, TypeScript, and ESLint. The Functions package targets Node 20 with Express, CORS, Firebase Admin, Firebase Functions, and Multer.

Two GitHub Actions workflows were found: one builds and deploys the production Hosting target on pushes to `master`; the other builds and creates a Firebase Hosting preview for pull requests. They rely on repository deployment credentials and must not be replicated or enabled in the new platform without separate approval.

No unit, integration, component, browser, Playwright, Cypress, Jest, or Vitest test suite was found in the source inventory. The available checks are lint, TypeScript typecheck, and builds; no checks were run during this read-only inspection.
