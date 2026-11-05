# Greenhouse experiment protocol

English | [中文](README.zh.md)

## Comparison requirements

Compare the same Intern-S2 model, 256000-token capacity, output settings, native compaction policy, credential pool, world JSON, virtual clock policy, initial resources and domain tools. A single Agent can use all chambers and concurrent device operations; its model calls remain sequential because it is one Agent. The team divides chamber responsibilities and exchanges actual references through Router. Do not give the team stronger models, more water, different virtual clock rules or an exclusive credential allowance. Run matched trials separately to avoid competition for the same model service, and repeat them in alternating order. Record service failures as possible confounders.

First establish real-model task completion in the three-task baseline. Then use disturbances and repeated task releases to examine delegation, shared-device contention, cross-chamber dependencies, sensor diagnosis and continuing care. Scripted runs validate execution mechanics only. A failure, incomplete handoff or poor care remains in the record; do not rewrite a failed trial as a successful restart.

## Repeated workload

From the repository root, generate a fresh scenario:

```sh
python3 integrations/ai4science/greenhouse/make-scenario.py .ai4science/greenhouse-long/scenario.json
```

The defaults release eight batches of three experiments, one batch every 30 simulation ticks. The final batch arrives at tick 210. Tick values are virtual laboratory time; `tickMs` controls host pacing in legacy timer mode only. The installer defaults to `--clock-mode event-driven`; both modes use the same `--idle-review-ticks` (default 30). Quiet intervals advance directly to a virtual review event, while model generation and runnable decisions hold virtual time. Each batch contains separate A light, B irrigation and C reference experiments; C requires that same batch’s B assay. Shared power reductions, rotating sensor offsets and normal moisture loss continue to require coordination and care. The schedule releases work; it is not a host deadline. The host and Agents continue after the final release and no token, request or total-runtime cap is added. `--batches` and `--interval-ticks` change workload size and virtual release spacing; `--tick-ms` changes only legacy timer pacing. Event advancement holds after every declared task and handoff finishes, with no active device operation; the host then remains available for owner inspection.

Use the existing installer with that exact scenario for both modes. `--mode multi-agent` creates the native team; `--mode single-agent` creates the sole root. Keep different runtime directories. Supply the same `--base-url`, `--api-key-env` and repeated `--extra-key-env` arguments. The installer records credential references, never key values. See the [runtime reference](../README.md) for direct-network routing and the launch entry.

## Measurements

Retain the world/device journal, execution database, immutable artifacts, native Sessions, Router board, generated profile and frontend screenshots. Preserve which model source produced each run. Measure completed experiments, task-release-to-analysis latency in ticks, actual result delivery/read receipts, resource occupancy in ticks, duplicate actions, interventions, operating violations, request retries and token use. The report includes physical-operation overlap, per-resource busy ticks, repeated successful assay/analysis effects and task closures after native compaction. Continuity counts only own assignments received before the summary and unfinished then; it does not measure information loss. Virtual time holds during model generation and runnable decisions, so tick latency does not measure inference throughput. Local timestamps remain raw audit metadata; wall-clock elapsed time, sleep duration and local calendar values are not evaluation inputs. Show context growth against per-Agent request indices or Session event order. Record the observed simulation-tick interval; a later screenshot of a host still running is not evidence of productive care during that interval.

Use `verify.py` for independently linked task/action/artifact evidence; the [verification reference](../README.md) defines accepted native input channels and separate communication observations. `compare.py` reads two installed runtime directories, reports completion ticks, per-route token use, retries, manual device submissions and compaction event counts, and rejects a descriptive real-model comparison when its matching checks fail. Matching includes recorded source hashes, effective model/compaction policies and the union of actual shared tool declarations across members. Per-role tool partitioning is part of the architecture; the single Agent retains the same aggregate execution abilities. Use `--offline` only after both hosts have stopped and checkpointed, or `--single-offline` / `--multi-offline` for one stopped host. A saved `--output` report can be shown by a profile installed with `--comparison-file`; the table includes its observation length and labels unmet comparison conditions. A pair is descriptive evidence about those runs, not a statistical conclusion or an automatic assertion of architecture superiority. Scientific conclusions are not scored.

## Context compaction

For the natural-capacity trial, retain the declared 256K capacity and observe real `compaction/start`, `compaction/summary` and `compaction/end` events. Identify tasks unfinished before the summary and inspect subsequent tool calls, recovered operation IDs, completed analysis and actual reference use. A configured compaction plugin, a large cumulative token bill or a successful compaction transaction alone does not establish continuity or information loss.

A separate low-threshold test may exercise the same native compression mechanism earlier. `install-multi.py --compaction-policy <file>` merges explicit native configuration overrides into the normal policy and records the effective values. A test file can set `thresholdRatio` to `0.04` and `retainTokens` to `1024` while retaining the declared 256K model capacity; native validation still applies. Label its effective threshold explicitly and apply the same setting to both modes; it cannot stand in for a natural 256K result. Compare recovery of pending tasks, dependencies and completed device work, including unnecessary repeats and human intervention. `greenhouse_history` and the Router board remain equally available to both modes. Do not deliberately cripple single-Agent memory to manufacture an advantage.

## Interpretation

The expected benefit is division of simultaneous work and smaller role-specific histories under ongoing environmental changes. The evidence must show that benefit after model-service instability, physical-device serialization, coordination overhead and compression recovery are accounted for. More messages, more Agents or a faster scripted fixture are not sufficient. Report failed and successful trials together, with actual UI screenshots and source-labelled records.
