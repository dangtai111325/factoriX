# Skill manifest

Status of this repository: **PARTIALLY VERIFIED**.

This file records which skills from master plan section 18 are on disk. It does not mean those skills were applied to the whole product, and it does not mean the master plan is complete.

## Installed public skills

Twenty-five of the twenty-seven public skills are in `.agents/skills`:

- interface-design
- design-system-patterns
- shadcn
- emil-design-eng
- animate
- review-animations
- web-design-guidelines
- vercel-react-best-practices
- playwright-cli
- architecture-patterns
- system-design-review
- backend-service-design
- api-contract-design
- data-modeling-and-storage
- distributed-systems-reliability
- security-privacy-review
- observability-and-debugging
- python-clean-code
- auth-implementation-patterns
- testing-strategy
- code-review-and-quality
- test-driven-development
- verification-before-completion
- writing-plans
- performance-engineering

Two public skills from the same list are on disk only under `.cursor/skills`, not under `.agents/skills`:

- ui-ux-pro-max
- impeccable

`.cursor/skills` also contains other skills that are not part of that list of 27: ui-styling, slides, design, design-system, brand, and banner-design.

## Still missing

These items named by the master plan are not in the repository:

- custom skill `factorix-resource-modeling`
- custom skill `factorix-connector-engineering`
- custom skill `factorix-signal-semantics`
- custom skill `factorix-edge-reliability`
- custom skill `factorix-product-ux`
- root `AGENTS.md`
- `.cursor/rules`

## What the English operator pass used

The console pass used the installed UI skills as the review standard: operator language, semantic navigation tokens, a light sidebar with the Avenue red active rail, readable hierarchy presets, and a formula editor that colors tokens and renames identifiers outside quotes.

## Still not done

Checked against master plan sections 16–19. These remain absent:

- Layout is a name form, not the React Flow canvas in S05.
- Relationships is a neighbor list, not the graph in S06.
- Add data is a Modbus-only four-step form, not the six-step wizard for Modbus, OPC UA, MQTT, and HTTP.
- OPC UA, MQTT, and HTTP have read-only connectors and live protocol tests. They do not yet run through the Edge scheduler into the historian. Only Modbus has that cycle.
- No Center, Web, or Edge Docker image, no single-origin nginx, and no OpenAPI file.
- The 654-case catalog is not implemented.

Current proof before this note was 25 domain tests, 4 live protocol reads, and 1 Modbus Edge cycle. That evidence is not a release claim.
