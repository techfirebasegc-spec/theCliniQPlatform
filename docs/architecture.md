# CliniQPlatform architecture

## Current state

This repository is a workspace scaffold only. It contains no application code, database configuration, MCP configuration, infrastructure provisioning, Firebase migration, VPS connection, or production connection.

## Workspace boundaries

- `web/` will contain the future web implementation.
- `agents/`, `skills/`, `docs/`, and `infrastructure/` are reserved workspace areas.
- `.github/` contains AI-development instructions, specialist agent definitions, and reserved skill directories.

The following projects are external, read-only reference implementations and are out of scope for all writes and operations:

- `D:\project\theCliniQwebapp`: established web UI/UX and functionality source of truth.
- `D:\project\theCliniQ`: future mobile reference implementation.

Read-only inspection of either reference requires separate explicit user authorization. No copying or migration is implied by reference inspection.

## UI and behavior preservation

The future web application must reproduce the established CliniQ visual design, navigation, interaction patterns, workflows, and functionality. Modernization concerns architecture and backend, not a redesign. Any intentional UI, UX, workflow, or behavior change requires explicit user approval.

## Planned MCP architecture

The following integrations are planned but are not configured:

| MCP | Intended role | Boundary |
| --- | --- | --- |
| GitHub | Source-control and review workflows | Repository-scoped, least privilege; no secrets in repository content. |
| Filesystem | Workspace-local file operations | Restricted to `D:\project\CliniQPlatform`; reference projects excluded. |
| PostgreSQL | Future development/test database work | Non-production only until separately approved; no credentials committed. |
| Playwright | Future local/test UI verification | No reference-project or production automation without explicit approval. |
| VPS/DevOps | Future deployment operations | Deferred; requires a separately approved restricted-permission design. |

## Approval gates

User approval is required before application implementation, reference inspection, database connectivity, schema work, Firebase migration, MCP setup, credentials, VPS access, production access, infrastructure provisioning, CI/CD configuration, or deployment.
