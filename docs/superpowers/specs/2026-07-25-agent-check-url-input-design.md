# Agent Check URL Input Design

## Goal

Allow the public `/agent-check` diagnostics page to obtain an A2A Agent Card from either a complete Agent Card URL or a service root URL, while preserving JSON upload and paste.

## Input model

The diagnostics form offers three mutually exclusive sources:

1. Agent Card JSON (file upload or paste).
2. Complete Agent Card URL.
3. Service root URL, resolved as `/.well-known/agent-card.json` on the same origin.

The client sends exactly one of:

- `agentCard: object`
- `cardSource: { type: "card-url" | "service-url", url: string }`

The Agent service target remains authoritative only when declared inside the resolved Card.

## Server flow

`POST /api/agent-diagnostics` remains the only public diagnostics API and continues to require the platform access key. For a URL source, it calls the existing `resolveAgentCard()` before Card validation and A2A execution. No unauthenticated resolver route is added to the public allowlist.

Remote Card retrieval inherits the existing protections: HTTP(S) only, no URL credentials, no local/private destinations by default, DNS address validation and pinning, no redirects, a 1 MB response limit, and a 12-second timeout.

The diagnostics report records the source type and final resolved Card URL in the `card-input` check. Retrieval failures are returned as a normal diagnostics report with later stages blocked, so DNS, TLS, timeout, HTTP, invalid JSON, and invalid Card failures remain understandable to the user.

## User interface

A source selector switches between JSON, complete Card URL, and service root URL. JSON parsing and Card previews keep their existing behavior. URL sources are resolved when the user starts diagnostics; while unresolved, the interface shows the entered URL and indicates that the Agent target will be learned from the Card.

After resolution, the result shows the source type and resolved Card URL. Clearing the form removes the URL and returns the source selector to JSON.

## Compatibility and documentation

Existing JSON request bodies remain valid. Legacy top-level `url` and `sourceType` request fields remain rejected. The diagnostics guide documents all three inputs, URL discovery behavior, security limits, and representative errors.

## Verification

Tests cover mutually exclusive input validation, both URL modes, URL resolution failure reports, API integration, page controls, and documentation. The full suite and JavaScript syntax checks must pass before deployment.
