# Mars greenhouse environment

English | [中文](README.zh.md)

## Scope

Run three synthetic chambers with shared power, water, a sampling robot, assay equipment and computation. The environment profile starts no Agents and makes no model requests. It is the environment foundation for single-Agent versus multi-Agent experiments, not evidence of an architectural advantage. Plant physiology and scientific conclusions are not evaluated.

## Run from source

Use the repository's installed dependencies and native addon; see the [source setup](../../../README.md). From the repository root:

```sh
python3 integrations/ai4science/greenhouse/install.py --home .ai4science/greenhouse-demo/home --directory .ai4science/greenhouse-demo/runtime --port 0
DSH_HOME="$PWD/.ai4science/greenhouse-demo/home" pnpm dsh --profile greenhouse-environment
```

Open the printed Mission Control launch link. Its token stays local. The existing frontend adds a greenhouse view; execution, Provider and artifact views use the same engine and device records. The greenhouse view explicitly identifies environment-only mode. No separate frontend database is created.

Submit a synthetic inspection using the existing New experiment form: Provider `greenhouse`, a unique request key such as `inspect-B-1`, and input `{"action":"inspect","chamber":"B"}`. A completed operation exports `result.json`, which the existing artifact preview verifies and displays. This is an operator action, not an Agent action.

Stop with Ctrl+C. This stops this host's clock and listeners without deleting state. Restarting the same profile resumes persisted logical ticks and accepted device actions; offline time is not simulated. Use separate runtime directories for comparisons. Existing state rejects a changed scenario instead of silently continuing under different rules.

## Simulation and actions

[scenario.json](scenario.json) owns all initial values, durations, physical coefficients, task requirements and scheduled disturbances. The bundled demonstration advances one synthetic minute per one-second tick. A real-time minute-per-minute experiment sets `tickMs` to 60000 in a separate scenario and uses a fresh runtime directory. The clock runs independently of queries and is exclusively owned per device directory. There is no total token, request-count or runtime cap.

Actions are `light`, `temperature`, `water`, `inspect`, `calibrate`, `sample`, `assay` and `analyze`. [schema.ts](schema.ts) owns their JSON fields. They use the public Provider protocol; simulated operations charge zero monetary budget while recording actual actions and resource use. Water and power are physical scenario resources, not a model-spending limit. Depleted water has no refill action in this foundation version.

Samples require an available task in the same chamber and its declared light/watering conditions. Required watering must finish after that task becomes available; an older batch cannot satisfy a new batch’s preparation. Assays require completed samples. Analysis verifies distinct samples, spacing and any declared cross-task reference, then saves numerical summaries; it does not evaluate a biological claim. The same completed sample cannot satisfy multiple independent-observation requirements by repeated assays.

At ticks 20, 30 and 40 the bundled scenario reduces power, offsets B's moisture sensor and adds a C task; power returns at tick 80. These are evaluator-side definitions. Agent/frontend observation omits future disturbances and sensor bias. Inspection and assay tools provide independent observations. Requested light is proportionally reduced when load exceeds supply; the UI shows both requested and effective values.

## Records and lifecycle

The device's `greenhouse.sqlite` stores environmental state, operations, samples, assays and events. This is the Provider's device journal, distinct from the platform's existing `execution.sqlite`. Reads never advance state. A separate clock lock prevents duplicate tick owners. Clock failure is reported and retains ownership until disposal.

Operation IDs deduplicate across restart. The device binds to one canonical execution-domain directory. A known pre-effect refusal after platform admission settles as failed; an uncertain storage/identity failure is not reported as successful cancellation. Action effects occur atomically at completion in this synthetic model, so running actions can be cancelled before effects. Completed result files are immutable and validated on subsequent reads.

## Validation and next integration

```sh
pnpm exec vitest run --config integrations/ai4science/greenhouse/vitest.config.ts
pnpm exec tsc -p integrations/ai4science/greenhouse/tsconfig.json --pretty false
pnpm exec vitest run --config integrations/mission-control/vitest.config.ts
```

The tests exercise autonomous clock progress, deterministic disturbances, admission, resource conflicts, cancellation, restart deduplication, cross-task evidence and authenticated frontend access. A real `dsh --profile greenhouse-environment` launch and browser submission also verify the entry and current Mission Control UI. They do not validate Intern-S2, Agent coordination or context compaction.

The native multi-Agent composition below adds domain tools and Router-backed task/mailbox exchange. Single-Agent entry verification, real-model compaction evidence and paired scoring have separate scopes below. Both modes must share scenario definitions and execution abilities. Do not commit model credentials.

## Native multi-Agent collaboration

The multi-Agent profile creates a native lead and three continuable chamber coordinators. It reuses Agent Router's `Board` for assignments and mailboxes; Harness remains the sole Agent runtime. Member names resolve to exact project Session IDs, and new incarnations are registered only through native continuation. Cross-chamber work mail is relayed through the recipient's actual native parent with the original sender recorded in its envelope and execution facts. This application mailbox does not change the native peer-result authorization protocol. Foreign recipients and obsolete Agent objects are refused.

Structured `greenhouse_*` tools expose the eight device actions, observations, verified results, cancellation and event waiting. `greenhouse_history` recovers paginated operation IDs by task or chamber after context compaction; the Agent then reads the existing verified outputs rather than repeating device work. Chamber coordinators execute chamber actions; the multi-Agent lead receives coordination, observation, history, result and cancellation tools, and delegates physical work through messages. The single-Agent root retains all domain actions. Both modes receive the same continuous-care rules and explicit instructions distinguishing Router assignment IDs from experiment IDs. Known resource contention is handled by program-side observation and stable-key resubmission before dispatch; unknown owners block new work. Waits also recognize completed target operations and unread mail. `after_seq` uses the explicit `greenhouse_observe.eventCursor`; a value beyond the current device log is refused with the actual cursor, while valid waits retain no project deadline.

`lab_assign`, `lab_message`, `lab_inbox`, `lab_status` and `lab_complete` use the real Router task board. Completion requires the actual successful analysis for the assigned greenhouse task. Delivery acceptance, explicit mailbox reads and actual experiment completion remain distinct facts. A settled child can receive new work through native cold continuation. Tool and turn checkpoints use the existing Session persistence service; coordinator messages carry the producer-owned `greenhouse-coordination` source accepted by Session V4.

For a reproducible scripted integration run, use a fresh directory:

```sh
python3 integrations/ai4science/greenhouse/install-multi.py --home .ai4science/greenhouse-team/home --directory .ai4science/greenhouse-team/run-20261103-v4 --source scripted --port 0
DSH_HOME="$PWD/.ai4science/greenhouse-team/home" pnpm dsh --profile greenhouse-multi-scripted
```

This profile uses [a declared three-task baseline](fixtures/baseline.scenario.json), with disturbances disabled. The scripted adapter reads actual tool results, shares B assay references with C and explicitly reads completion notices. It reports zero production-model token usage. The frontend labels this mode as scripted and displays actual members, assignments, mailbox receipts and operations. It is neither Intern-S2 evaluation nor evidence of long-term greenhouse care, context-compaction quality or a multi-Agent advantage. After the fixed baseline tasks finish, the environment continues but the scripted workers do not autonomously maintain moisture.

Verify the persisted snapshot independently:

```sh
python3 integrations/ai4science/greenhouse/verify.py .ai4science/greenhouse-team/run-20261103-v4
```

The verifier reads native Session headers, device actions, execution outcomes, artifact hashes, Router assignments and mailbox receipts. The B reference used by C’s successful analysis must appear earlier in that Agent’s native input, through an authenticated Router message or a successful `greenhouse_result` read. The same rule applies to both modes. `referenceEvidence` records the observed channels, and `directPeerReferenceBeforeEveryAnalysis` reports direct peer-message coverage separately; reading a shared result does not establish prior direct messaging. Board mail must match its producer’s written facts and accepted native delivery. Completion notices must reach the owner’s model.

Explicit mailbox-read receipts are reported separately; native input delivery does not require a second `lab_inbox` call. The verifier reports operating violations separately and never scores scientific claims or architecture superiority. Verification can fail while required tasks or records are not yet complete. It does not stop the run or rewrite evidence. After stopping the host, use `--offline` for checkpointed databases; this explicit assertion is unsafe on a live host, and a nonempty WAL file is refused.

`install-multi.py --source real-model` generates an Intern-S2 profile with a conservative 256000-token context declaration and native compaction configured before capacity. `--base-url` selects the official endpoint, `--api-key-env` selects the primary credential reference, and repeated `--extra-key-env` arguments add credentials to the same request pool. Native request preparation rotates provider routes for both single- and multi-Agent modes; actual selected routes remain in Session headers. Model requests, input/output tokens and errors are recorded globally and per route; credentials never enter those records. Token counts include reported cache usage and reasoning output, but failures may be billed without returning usage. No quota-based scheduling or spending cap is applied. Native compaction follows the latest routed model by default, so summary requests can use the credential routes as well.

The real-model profile loads the native `llm-retry` executor as well as provider retry settings. Transient request failures retry the failed native step, preserving completed tool effects and durable retry events. A terminal Agent failure makes the frontend report attention-required state; the host staying alive does not imply experiment success. Per-request transport failure detection and output capacity are separate from a total run cap.

`--direct-interface` together with `--direct-address` selects the model origin’s local source address and DNS-resolved IPv4, retaining TLS hostname verification. The owning Agent plugin installs this transport before creating any Agents; independent plugin list order is not an initialization guarantee. This optional local TUN-proxy bypass does not modify system settings. Each new connection reads the physical interface address again; temporary interface loss rejects that request, and lookup completion is asynchronous so socket bind errors reach the request handler. An unavailable interface still fails at startup. Refresh `--direct-address` when the model origin’s public DNS changes. Run `audit-network.py <runtime-directory>` on macOS while model requests are active: it discovers the live clock-owner PID and records the actual model socket interfaces through `nettop`. A configuration log alone is not direct-egress evidence; an idle process produces an inconclusive record. The comparison requires matching transport settings and observed direct interfaces for both runs.

While assignments remain unfinished, a native `agent/turn-stopping` listener supplies a logged steering notice containing their actual Router and experiment IDs. Both modes use this listener; the lead also receives currently available unassigned tasks. A short final answer or one truncated model response therefore does not abandon those assignments. The listener adds no round, token or runtime limit, does not override cancellation, and permits settlement when current work is complete. Future releases still wake members through the existing environmental notification and native continuation path.

## Dynamic environmental feedback

Committed power and new-experiment events notify the lead; sensor anomalies and sensor-visible range transitions notify only the responsible chamber coordinator. Notices are coalesced per recipient, written to the same Router mailbox and delivered through native continuation. Already-settled members can therefore receive new work without model polling. Device completion continues to use existing operation waits rather than sending duplicate notifications.

The observer advances its cursor only after the selected native deliveries accept the batch. An uncertain delivery stops that observer, preserves the original device events and reports attention-required state in the frontend; it does not claim that the recipient processed the notice or automatically resend indefinitely. Shutdown cancels and awaits pending delivery before closing member and storage resources.

Range alerts use the same sensor-visible measurements as the observation tool, including any sensor bias; they never expose hidden true moisture. The observation tool also provides declared operating ranges and the light power coefficient for explicit resource decisions. Device-journal metrics continue to measure actual violations independently.

`dynamic.spec.ts` uses native cold continuation and actual domain tools to exercise power coordination, inspection-driven calibration and completion of the later C experiment. Its model responses are scripted, and it does not also claim completion of the initial three research tasks. The fixed baseline demo adapter still does not provide general continuous greenhouse care; dynamic model-policy effectiveness, long-term operation, compaction and the single-Agent comparison remain unverified.

## Single-Agent comparison entry

After establishing native team coordination, the same Agent plugin accepts `mode: single-agent`. It creates only the lead, permits self-assignment to the same Router task board, and routes all environmental notices to that member. No peer mailbox traffic is fabricated. The sole Agent can use all chamber tools, submit independent operations concurrently, wait for events and read persisted results. Multi-Agent mode continues to use separate native members and actual work messages. Both modes use the same device rules, resources and analysis evidence requirements.

Install a fresh scripted single-Agent run with the existing installer:

```sh
python3 integrations/ai4science/greenhouse/install-multi.py --home .ai4science/greenhouse-single/home --directory .ai4science/greenhouse-single/run-20261103 --mode single-agent --source scripted --port 0
DSH_HOME="$PWD/.ai4science/greenhouse-single/home" pnpm dsh --profile greenhouse-single-scripted
python3 integrations/ai4science/greenhouse/verify.py .ai4science/greenhouse-single/run-20261103
```

The fixed single-Agent script completes the same three baseline tasks and 17 device operations, using B assays directly as C reference evidence. Its sequential policy is a fixture choice; the separate capability regression verifies concurrent independent operations. Script timings and zero production-token counters are not a model-performance comparison. The frontend identifies the single-Agent mode; the verifier checks one persisted root and self-owned assignments without requiring peer messages. A real-model profile uses `--source real-model`, selects the same Intern route/compaction configuration and is named `greenhouse-single`.

## Saved comparison reports

Use an immutable JSON report already written by `compare.py --output`. `install.py --home <home> --report <report.json> --port 0` installs `greenhouse-report`; launch it with `run.py --home <home> --profile greenhouse-report`. This entry serves the existing Mission Control UI without model credentials, Agents, an execution database or an environment clock. It loads one report at startup, retains its source labels and recorded compaction threshold, and shows reference-input channels separately from direct member messages. Missing or malformed reports fail at startup. An incomplete saved comparison remains labelled incomplete; viewing it does not establish architecture superiority. Stop the report profile before selecting another saved file.

A mode label or successful connectivity check does not establish single/multi-Agent effectiveness, natural 256K compaction or continuous care. Use the [experiment protocol](experiments/README.md) to generate longer workloads and compare independently verified records. The installer saves source bytes, hashes and effective model/compaction settings with each fresh run. Source changes after installation reject startup before device state is created; reinstall an unused profile to record its new inputs. `--comparison-file` displays a saved evaluator pair inside the greenhouse view without supplying it to Agents; an absent file is pending, while malformed report data fails the snapshot request visibly. No total token, request or runtime cap is added by either mode.

`run.py` launches only an installed greenhouse `dsh` profile. Supply `--home`, `--profile` and optionally `--credentials-file` containing plain `NAME=value` lines; values are copied into the child environment without shell evaluation or printing. `--no-proxy` clears proxy variables in that process only; the profile’s direct-interface configuration handles a TUN proxy. The launcher installs no project deadline.
