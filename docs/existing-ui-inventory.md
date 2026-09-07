# Existing CliniQ UI and UX inventory

## Preservation rule

This is an inventory, not a redesign proposal. The existing web application's UI, navigation, interaction patterns, and workflows are the future web application's source of truth. All findings below are based on read-only source inspection; no visual browser run or responsive-device test was performed.

## Shared experience

### Current Next public shell

- A top development/coming-soon announcement strip with scrolling text and reduced-motion handling.
- A secondary promo banner that links to My Bookings.
- Sticky, pale-blue header with brand logo; Home, Doctors, Services, About, Blog, Contact, app-download link, auth/account control, and prominent booking CTA.
- Guest account chip leads to Profile/Login. Authenticated users see an account dropdown with Profile, My Bookings, and Logout. It closes on outside pointer-down, Escape, selection, auth sign-out, and unmount.
- Footer has logo/tagline, service/specialty/doctor/health links, email, app promotion, and copyright.
- Mobile header uses a hamburger navigation panel; account chip is visually hidden while booking CTA remains compact.

### Shared visual language

- Blue/teal healthcare palette: primary dark blue, teal secondary/accent, pale-blue surfaces, white cards, rounded 12–18px corners, thin blue borders, soft elevation.
- Poppins/Inter-oriented heading and control typography; uppercase tracked eyebrow labels; dark-blue titles; muted body copy.
- Reused controls: primary filled blue button, secondary white bordered button, small button, arrow-bearing text link, card hover lift, chips/pills, breadcrumbs, and consistent focus styling.
- Responsive breakpoints at approximately 820px, 767px, 560px, and 480px. Directory grids collapse from two columns to one; header changes to mobile menu; hero/CTA layouts stack; primary actions often become full-width on narrow screens.

## Major pages and workflows

| Page/route | Purpose and major UI | Navigation/forms/modals | Responsive behavior |
| --- | --- | --- | --- |
| Home (`/`) | Split hero with consultation image and two CTAs; offer cards; doctor cards; service cards; physiotherapy/health resource links; three-step process; app promotion; final CTA. | Book, Doctors, doctor/service/health deep links. | Hero and 3/2-column sections become one column; doctor cards remain compact horizontal cards on mobile. |
| About (`/about`) | Informational sections and four content cards for Doctors, Services, Health, Consultation; app and final CTAs. | Deep links to public directories and booking. | Shared card grid becomes one column. |
| Doctors (`/doctors`) | Directory header and doctor-card grid. Cards include image, designation, name, specialty, qualifications/location, and profile link. | Profile links; global booking. | Two-column grid to one; cards become vertical on smaller screens. |
| Doctor detail (`/doctors/[slug]`) | Breadcrumbs, photo, credential/experience/location block, about, languages, consultation modes, related specialties/services, home-visit note, app promotion. One physiotherapist profile has an expanded bespoke layout: credentials, care areas, what-to-expect numbered steps, related-care links, repeated CTA. | Booking URL preselects doctor; links to related service/specialty/content. | Standard profile photo/text stacks; bespoke profile collapses hero/content/action grids. |
| Services (`/services`) | Directory header, service card grid, app promotion. | Service cards and global booking. | Two-column to one. |
| Service detail (`/services/[slug]`) | Breadcrumbs, explanatory detail sections, commercial booking CTA, app promotion, related specialty/doctors, final booking CTA. | Booking URL may preselect doctor and service. Home physiotherapy messaging describes saved-address prerequisite. | Shared detail-page spacing and wrapped actions. |
| Specialties (`/specialties`, detail) | Specialty-card directory; detail ties specialty to doctors/services and booking information. | Related links and booking CTA. | Shared directory/detail responsive system. |
| Health hub/article (`/health`, detail) | Article link list; article has breadcrumb, title/excerpt, author/reviewer/dates, rich headings/paragraphs/lists/callouts, disclaimer, sources, app promotion and related content. | Article and related resource links. | Article measures remain readable; attribution shifts to a vertical layout. |
| Locations (`/locations`) | Minimal route-shell with title and comma-separated service areas or unavailable message. | Global shell only. | Inherits route shell. |
| Legacy marketing (`/index.html`, `/services.html`, `/doctors.html`) | Earlier marketing visual system: page hero, card grids, service imagery, testimonials/trust/CTA patterns. | Legacy responsive navigation and booking/contact anchors. | Legacy stylesheet defines mobile nav, cards, and mobile booking bar. |
| Booking (`/booking` via legacy iframe) | Four-step React-in-HTML flow: select Teleconsultation/Home Physiotherapy, doctor card, five-date picker/slot grid, review/payment success state. Includes fee display, doctor avatars, login modal, confirmation state, support modal, trust/payment reassurance. | Google/phone OTP login; calls doctor/availability API; Razorpay checkout; supports query-prefilled doctor/service and reschedule mode. Support modal closes by button, backdrop, or Escape. | Legacy stylesheet supplies booking-specific mobile layouts; source requires browser validation for exact rendering. |
| Profile (`/profile` via legacy iframe) | Authenticated patient toolbar, guest login CTA, profile-completion indicator, personal details and saved-address form. | Google/phone OTP modal; save action. Fields include name, DOB, gender, and structured address. | Legacy form grid responds through legacy CSS. |
| My Bookings (`/my-bookings` via legacy iframe) | Structured patient appointment list/cards with appointment/date/doctor/service/slot/status/payment details and action controls. | Login state; Open Chat; cancel (confirmation behavior must be baselined); reschedule navigates to booking with appointment context. | Legacy card/list layout. |
| Chat (`/chat` via legacy iframe) | Doctor toolbar with online/offline state, chat-permission status, message list, text input, image/file upload actions, upload progress, prescription attachment card. | Login modal. Unlocks only around an eligible appointment window; messages and attachment links are live Firestore/Storage-backed. | Legacy chat shell/input row; exact small-screen behavior needs browser baseline. |
| Prescription verification | Result badge, title/message, integrity-check list and metadata. | Reads prescription ID/hash from query string and calls verifier API. | Simple legacy page; inherits header/footer/layout styles. |
| Contact, Careers, Partner | Form-panel pages alongside explanatory/trust sections. | Contact and partner forms submit name/email/message; careers adds role, optional resume and cover letter. Inline validation/loading/success/error states. | Legacy form/card grid responsive system. |
| Blog list/detail | Legacy health-content listing, category filter chips (All, Teleconsultation, Physiotherapy, Care Guidance), dynamic detail page, related articles and CTAs. | Client-side data/rendering and blog routes. | Legacy blog grid/detail responsive styles. |

## CSS and style dependencies

There are two independent style systems:

1. `app/globals.css` (about 20 KB) is the current Next public design system: root tokens, global reset/base, shell/header/footer, cards, directories, detail/article pages, home sections, app promotion, and mobile rules. `doctor-profile.module.css` supplies the special physiotherapist profile.
2. `public/assets/css/styles.css` (about 80 KB / 4,000 lines) is the legacy visual system. It includes page heroes, grids, forms, cards, blog patterns, booking/payment/profile/chat controls, modal states, mobile booking bar, animation, and responsive media queries.

The legacy transactional iframe pages depend on absolute legacy references, `legacy-embed.js`, `app.js`, the large legacy CSS file, Firebase browser modules, and—in booking—Razorpay checkout plus remote ESM React/React DOM/HTM.

## UI preservation baselines to capture before recreation

- Header states: desktop/mobile menu, guest/authenticated account menu, outside click, Escape, item selection, and logout.
- Exact booking flow: every step, prefilled doctor/service links, unavailable slot, login, payment dismissal/failure/success/pending confirmation, support modal, and reschedule state.
- Profile: guest vs authenticated state, profile completion, validation, saved address, save/error states.
- My Bookings: empty/loading/error/status variants, cancel/reschedule/chat availability.
- Chat: missing link, guest/login, locked/unlocked window, message types, upload progress/error, responsive composer.
- Public-page typography, spacing, hover/focus, card grids, breakpoints, and all CTA destinations.

## Reuse versus recreation classification

**Preserve directly as behavior/design specifications:** route purpose, content hierarchy, navigation labels/destinations, card and CTA patterns, visual tokens, responsive breakpoints, forms/states, booking progression, patient profile fields, appointment actions, chat window rules, and prescription verification feedback.

**Candidate assets/components for future approved reuse:** logo and locally owned images, the shared Next header/footer/public-content components, static public-content structures, current design tokens, and the bespoke doctor-profile stylesheet. Reuse requires separate authorization; nothing was copied.

**Recreate in the new app rather than carry forward:** legacy HTML shells, iframe embedding, remote ESM React/HTM runtime, duplicate header/auth implementations, raw DOM scripts, and the output-merge mechanism. Their UX should be preserved, but their implementation should not define the new architecture.
