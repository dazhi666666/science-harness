# AI4Science agent tools

English | [中文](README.zh.md)

## Reference

Organization tools accept either an explicit member ID or a unique visible role: `org_message` and `org_send_result` use `target_id` or `target_role`; `org_authorize` uses `child_id` or `child_role` and `peer_child_id` or `peer_role`. Supply exactly one selector per member. Role selectors also require `org_discover` in the caller’s tool allowlist. Missing or ambiguous roles fail; discovery does not grant permission. Native ancestry, both parents' consent, and result-access checks still apply. Tool responses include the resolved IDs. Existing ID calls remain supported.

`execution_facts(operations_only=true)` omits project history while returning accessible operations. Omit the flag to keep the full response. Use `execution_result(operation_id)` when the operation is already known.

The [first-loop scene](scenes/first-loop.ts) exposes structured arguments: `scenario_submit(requestKey, phase, conditions, decisionId?)`, `scenario_analyze(operationIds, method, rationale)`, and `scenario_choose_followup(branch, analysisIds, conditions, rationale)`. Each condition contains `value` and `samples`. These tools no longer accept JSON encoded inside `request_json`; see the [migration guide](../../../docs/upgrade-guide/v0.2.1-alpha.2/science-scene-tools/guide.md).

`scenario_report(markdown, source_ids?)` infers sources from links to existing project artifacts and operation output files. Project paths are normalized relative to the report directory; linked sources must remain accessible and pass size/hash checks. Explicit `source_ids` must be artifact IDs with corresponding links, never operation IDs. Broken links under `project-artifacts/`, `artifacts/`, or `../artifacts/` are rejected. Scientific conclusions are not scored.

The scene's Loader entry `apply` returns no installation object; in-process compositions use `mountScene`. Scene-specific branch names and experiment stages remain confined to this example. These tool changes introduce no fixed team size, forced message exchange, model-request budget, or project runtime limit; execution and experiment policies remain configured separately.
