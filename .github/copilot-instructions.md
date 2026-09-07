# CliniQPlatform development instructions

## Scope and safety

Work only inside `D:\project\CliniQPlatform` unless the user explicitly expands scope. Do not inspect, copy from, modify, move, rename, delete, format, install packages in, commit in, deploy from, or otherwise operate on either reference project:

- `D:\project\theCliniQwebapp` — read-only reference for the established web UI and UX.
- `D:\project\theCliniQ` — read-only reference for the future mobile application.

Do not create application code, migrate Firebase, connect to a VPS, configure production access, or add MCP credentials unless the user explicitly authorizes that work.

## Product and implementation rules

The future `web\` application must preserve the established CliniQ UI, UX, navigation, workflows, visual language, and functionality. The web reference is the source of truth when the user later authorizes reference inspection. Do not redesign, simplify, replace, or invent user experiences. Treat any material behavior, schema, architecture, or dependency decision as needing explicit user approval.

Inspect the relevant implementation before changing it. Make the smallest safe change, preserve existing functionality, explain significant changes before making them, and avoid unrelated rewrites. Never expose, hard-code, log, or commit secrets. Never modify production without explicit approval.

## Collaboration and approvals

Use the specialist agents for bounded work. The Architect defines an approved plan; Developer implements only the approved scope; Database and Migration agents govern data changes; Security reviews boundaries; Testing verifies behavior; DevOps handles non-production operational work only after approval. Escalate conflicts, unclear requirements, production-impacting actions, destructive work, credentials, network access, schema changes, and UI deviations to the user.

## Planned MCP architecture (documentation only)

Planned MCPs are GitHub, Filesystem, PostgreSQL, and Playwright. They must use least privilege and separate development/test resources from production. No MCP server, VPS access, production access, credential, or connection is configured at this stage. A future VPS/DevOps MCP requires a separately approved, restricted design.
