# A2A Hybrid Agent Card Compatibility Design

## Goal

Allow both the technical diagnostics platform and the formal evaluation
platform to accept a narrowly defined hybrid Agent Card that uses an A2A 1.x
`protocolVersion` with the legacy top-level `url` and optional
`preferredTransport`.

The platform must normalize unambiguous compatibility cases without weakening
network safety, authentication boundaries, or validation of genuinely
conflicting declarations.

## Shared Architecture

Compatibility belongs in `src/a2a.js`, which is already the shared Agent Card
validation and interface-selection layer used by diagnostics, submissions,
pipelines, and A2A execution.

The compatibility layer will expose a normalized view of the submitted card.
It will not mutate the caller's object or rewrite the remote Agent Card.
Validation results will contain:

- the original validation outcome;
- normalized interfaces used for execution;
- compatibility warnings describing every inferred field.

Diagnostics and formal evaluation will consume the same normalized interfaces.
This prevents one platform from accepting a card that the other cannot
execute.

## Normalization Rules

### Native A2A 1.x

When `supportedInterfaces` is present, the card remains an A2A 1.x card and is
validated strictly. A top-level `url` or `preferredTransport` does not override
the explicit 1.x interfaces.

### Native A2A 0.3

When `supportedInterfaces` is absent and the top-level `protocolVersion` is
missing or starts with `0.3`, the existing 0.3-compatible validation remains
unchanged.

### Hybrid 1.x with top-level URL

When all of the following are true:

- `supportedInterfaces` is absent;
- `url` is a valid HTTP(S) URL under the active network policy;
- top-level `protocolVersion` starts with `1.`;
- `preferredTransport` maps to a supported binding;

the platform will synthesize one internal interface:

```json
{
  "url": "<top-level url>",
  "protocolBinding": "<normalized preferredTransport>",
  "protocolVersion": "<top-level protocolVersion>"
}
```

Supported transport aliases are the existing mappings:

- `JSONRPC` and `JSON-RPC` → `JSONRPC`
- `HTTP_JSON` and `HTTP+JSON` → `HTTP+JSON`

If `preferredTransport` is omitted, the platform will not guess. Validation
will fail with an error requesting an explicit transport.

### Conflicts and unsupported values

The platform will reject rather than infer when:

- `supportedInterfaces` is present but invalid;
- the hybrid card declares an unsupported transport;
- the version is neither 0.3-compatible nor 1.x;
- the URL violates the current public/private network policy;
- explicit 1.x interfaces conflict internally.

## Warnings and User Experience

Successful hybrid normalization will produce a warning equivalent to:

> 检测到 A2A 0.3/1.x 混合格式；平台已根据顶层 url、protocolVersion 和
> preferredTransport 生成兼容接口。建议提交前修正原始 Agent Card。

The warning will be returned by Card URL resolution and diagnostics results.
Formal evaluation will retain the warning in its validation metadata so the
submission remains auditable.

The original card remains visible to the user. Any normalized interface shown
by the UI must be labelled as platform-inferred.

## Data Flow

1. File/JSON input, Card URL resolution, or service discovery obtains the
   original card.
2. Shared validation derives normalized interfaces and warnings.
3. Diagnostics or submission checks the shared validation result.
4. A2A execution selects only from normalized interfaces.
5. Audit and UI projections preserve the original card plus compatibility
   warnings.

## Testing

Tests will be written before implementation and will cover:

1. A hybrid HTTP+JSON 1.0 card validates and yields one normalized interface.
2. A hybrid JSONRPC 1.0 card validates and yields one normalized interface.
3. A hybrid 1.x card without `preferredTransport` fails without guessing.
4. Unsupported transports and unsafe URLs remain rejected.
5. Native 0.3 and native 1.x behavior is unchanged.
6. Card URL diagnostics use the normalized interface.
7. Formal submission and pipeline validation accept the same hybrid card.
8. Compatibility warnings survive resolution and validation projections.

## Out of Scope

- Probing multiple bindings to guess an omitted transport.
- Modifying the remote Agent Card.
- Converting non-HTTP(S) endpoints.
- Relaxing Agent authentication or private-network policy.
- Treating a failed A2A call as a successful compatibility conversion.
