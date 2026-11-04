---
kind: upgrade-guide
description: "Greenhouse Agent profiles default to event-driven time, unlimited native retries and tick-based comparison fields."
---
# Greenhouse event-driven profiles

English | [中文](guide.zh.md)

## Change

New greenhouse Agent profiles use event-driven simulation instead of host-paced ticks. Model generation and runnable decisions hold virtual time; blocked participants permit advancement to the next virtual event. Completed declared workloads hold advancement without stopping the host. The environment-only profile retains timer mode. Generated real-model profiles use native `retryPolicy.mode: always`, retrying until success or owner cancellation/disposal.

Comparison reports use `timeReference: simulation-ticks`, `taskCompletionTick`, `taskLatencyTicks` and `allTaskCompletionTick`; wall-clock completion fields are removed. Matching requires event-driven profiles with identical virtual clock settings. Older timer trials remain historical evidence and fail that matching condition.

## Migration

1. Preserve existing runtime directories, source snapshots and reports. Agent profiles require fresh task boards; do not restart a used trial to change its protocol.
2. Run [install-multi.py](../../../../integrations/ai4science/greenhouse/install-multi.py) for fresh single- and multi-Agent directories with the same scenario, model pool and `--clock-mode event-driven --idle-review-ticks 30`. Reinstall unused profiles after source edits. Use `--clock-mode timer` only for explicitly labelled legacy diagnostics.
3. Update report consumers to the tick fields above. Treat stored host timestamps as audit metadata, without computing evaluation durations from them.
4. Confirm each installation records event-driven `clockPolicy`, verify its actual tasks and artifacts, then run [compare.py](../../../../integrations/ai4science/greenhouse/compare.py). Check the clock-policy matching conditions alongside all other conditions. See the [experiment protocol](../../../../integrations/ai4science/greenhouse/experiments/README.md) for interpretation.
