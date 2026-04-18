# agent-security

Defensive patterns for a multi-channel AI agent: tool-boundary invariants, outbound URL firewall, and adversarial boundary tests.

## What this is

A point-in-time snapshot of the agent subsystem from a private production Next.js codebase I built and operate. The system runs customer-facing AI assistants for small service businesses. Every defense documented here is applied to software I own, and the adversarial review loop that surfaces the findings targets my own deployment. This repo exists so a reader of the write-up can verify the cited code and run the tests in about five minutes, without needing access to the private repo.

Not a fork. No commit history carries over. Platform adapter implementations (Twilio, Gmail, Facebook, Instagram) and the Supabase runtime client are replaced by stubs that throw on call; tests mock them at the module boundary, so the stubs are never hit.

## The write-up

https://ggautomate.com/writing/defending-ai-agents-against-prompt-injection

## Running the tests

```
npm install
npm test
```

Target: 42 passing tests (15 from `prompt-injection-boundary.test.ts`, 17 from `outbound-firewall.unit.test.ts`, 10 from `service-area.unit.test.ts`). The count grows over time as adversarial review finds new bypass classes and adds regression tests.

```
npm run typecheck
```

For a type-check pass (zero errors expected).

## File map

Each defense in the write-up maps to a file below.

| Write-up section | File |
|---|---|
| The invariant, Defense 1 (tools as the boundary) | `app/api/agent/core/actions.ts` |
| Defense 2 (verification bound to a specific phone) | `app/api/agent/core/actions.ts` + `app/api/agent/lib/twilio-verify.ts` |
| Defense 3 (service-area fail-closed) | `app/api/agent/lib/service-area.ts` |
| Defense 4 (tag-based input isolation) | `app/api/agent/core/prompts.ts` |
| Defense 5 (outbound URL allowlist) | `app/api/agent/lib/outbound-firewall.ts` + hook sites in `app/api/agent/core/handler.ts` and `app/api/agent/lib/scheduled-send.ts` |
| Adversarial review harness | `__tests__/prompt-injection-boundary.test.ts` |
| Outbound filter unit tests | `__tests__/outbound-firewall.unit.test.ts` |

## What is in scope

- The agent runtime, its tools, the tool-schema validation layer
- The outbound URL firewall and its two hook sites
- The boundary test harness (Vitest, module-level mocks, no live Gemini/Supabase/Twilio calls)

## What is not in scope

- Webhook entry points (Twilio/Meta/email/SMS inbound routes)
- Platform adapter implementations (live send code for Twilio, Gmail, Facebook, Instagram)
- Email pipeline helpers (classifier, router, poller)
- Marketing site, admin dashboard, client dashboard, client onboarding flows, vertical landing pages
- Supabase migrations (schema lives elsewhere)

These all live in the private production repo.

## Stubs and how they work

Two files are replaced by throwing stubs for this snapshot:

- `app/api/agent/platforms/index.ts`: real version wires platform adapters. Stub throws on `getAdapter()`.
- `lib/supabase/server.ts`: real version imports `next/headers` and instantiates an env-configured client. Stub throws on `createServiceClient()`.

Tests pass because both are replaced via `vi.mock` at the module boundary before any code runs. A live run of the agent against these stubs would fail loudly on the first platform send or Supabase call. That's intentional: the snapshot is for review and test verification, not live operation.

## License

MIT. See `LICENSE`.
