---
kind: upgrade-guide
description: "AI4Science first-loop tools replace JSON strings with structured fields, and in-process compositions use mountScene."
---
# Structured first-loop scene tools

English | [中文](guide.zh.md)

## Change

The optional AI4Science first-loop scene replaces `request_json` with direct tool fields. Its Loader entry `apply` returns void; compositions that need the installed services use `mountScene`. Existing persisted operations and artifacts are unchanged.

## Migration

1. Update prompts and scripted tool calls: pass the former JSON object's fields directly to `scenario_submit`, `scenario_analyze`, or `scenario_choose_followup`. See the [tool reference](../../../../integrations/ai4science/platform/README.md).
2. Replace in-process calls that consume the result of the scene's `apply(ctx, config)` with `mountScene(ctx, config)`. Loader configurations still load the same module.
3. Run `pnpm exec vitest run --config integrations/ai4science/platform/vitest.config.ts` from the repository root to check the actual Loader entry and provider/tool integration without external model calls.
