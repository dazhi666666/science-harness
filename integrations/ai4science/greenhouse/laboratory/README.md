# Staged laboratory devices

English | [中文](README.zh.md)

## Scope

`LaboratoryWorld` stores samples, devices, accepted operations, measurement references and revocations in `laboratory.sqlite`. `openLaboratoryProvider` exposes the existing execution-provider protocol. `LaboratoryClock` owns logical event advancement through the shared simulation clock; callers supply native participant readiness and event delivery, and close device connections after clock disposal.

The six-device [fixture](fixture.ts) covers a preparation and measurement chain. The [joint scenario](scenario.ts) defines six projects, 48 original samples, 20 device instances and 52 phase tasks with cross-project prerequisites. Water modules govern water-dependent processing. Thermal devices control preservation conditions under their declared power demand.

## Run from source

Install the environment through a standard `dsh` profile. The existing Mission Control displays laboratory, equipment, sample, project and committed-operation views. The profile creates physical devices and execution records; it creates no Agents or model requests.

```sh
python3 integrations/ai4science/greenhouse/laboratory/install.py --home .ai4science/laboratory-preview/home --directory .ai4science/laboratory-preview/run --seed 1 --port 0
DSH_HOME="$PWD/.ai4science/laboratory-preview/home" pnpm dsh --profile laboratory-environment
```

Open the printed Mission Control launch link. In environment mode, accepted operations, pending shipments and changing temperatures drive logical events. Quiet periods remain at the current tick. The authenticated laboratory snapshot endpoint accepts reads; execution submissions use the existing science dashboard.

The scripted Single workflow can be installed with the shared installer:

```sh
python3 integrations/ai4science/greenhouse/install-multi.py --environment laboratory --source scripted --mode single-agent --home .ai4science/laboratory-native-script-r4/home --directory .ai4science/laboratory-native-script-r4/run --seed 1 --port 0
python3 integrations/ai4science/greenhouse/run.py --home .ai4science/laboratory-native-script-r4/home --profile laboratory-single-scripted --no-proxy
```

Choose fresh runtime and profile directories for each new trial. The installer refuses an existing device or Router history. `evaluate.py <runtime> --offline` verifies a stopped, checkpointed run. Scripted integration uses the same physical tools, native Agent lifecycle and Router completion paths; the recorded model source is `scripted`.

## Physical operations

Volumes are integer microlitres. Aliquoting and processing require delivery to the selected device. Transfer reserves a compatible destination position; entering its processing stage places the sample on the robot. Cancellation or destination failure retains that location. Quarantined and expired material can be transported for isolation; processing requires an available unexpired sample.

Accepted work reserves its device and input sample. Loading and processing have separate committed events. Processing deducts input volume; successful work creates a linked child sample. Cancellation, expiry and device failure retain earlier deductions. Partial-volume processing requires space for both remaining input and output.

Methods declare preparation state, version, duration, operating temperatures, calibration requirements and cleaning requirements. Setpoint changes take logical time to reach; admission and processing transitions check the measured device temperature. Faults precede completions at the same logical tick. Samples remain usable through their declared expiry tick and are quarantined at the following tick. Queries never advance time or expose future faults.

Thermal drift, control and exposure use logical ticks. Temperature transitions notify before cumulative exposure exceeds the declared sample tolerance; failed preservation quarantines the sample. In-process material remains exposed after its input volume has been deducted. Shared power loss can fail processing while retaining earlier effects. Water-path faults block water-dependent work; refill adds water within tank capacity. Supply orders create shipments whose stock appears only at the declared arrival event.

`process` accepts a primary `sampleId` and optional `additionalSampleIds` for one device cycle. Each input must be delivered, compatible and owned by the operation project. `volumeUl` applies to each input; selected consumables cover the whole batch. Device `maximumBatchSamples` and `batchMultiple` govern batch size and balancing counts. Accepted work locks every input, and stage effects deduct every sample atomically. Outputs retain per-sample lineage and separate measurement IDs. Water use and processing duration apply to the physical cycle. The immutable artifact includes all measurements in `results`; its primary `result` remains available to single-sample readers.

## Records and recovery

An operation ID binds project, command and provider identity. Matching retries return its existing outcome. A device database binds to one execution domain. Changed scenario rules require a new directory; reopening matching rules preserves accepted work and stage effects.

Successful provider queries export immutable `result.json` files through the existing artifact protocol. Calibration review appends revocations and withdraws the current matching calibration. Original measurement records remain readable. Consumable selections reserve batch stock at admission and deduct it when processing starts; recalls quarantine exposed descendants and revoke their measurements.

Project deliveries require current method versions, distinct original samples and valid prerequisites. Scenarios with `externalReferences` require the exact current measurement references from prerequisite projects. Native delivery tools require prior verified artifact reads for both own and cross-project results. Same-project phase results must descend from the samples produced by their referenced prerequisite measurements. Logical method revisions withdraw affected deliveries. Replacement deliveries append new references and withdraw dependent deliveries that no longer match.

## Native participants

`mountLaboratoryAgents` composes a coordinator and three native specialist roles for facilities, experiments and quality. Single mode creates one root with the same aggregate physical tools and project access, and can keep independent device operations running concurrently. Each live incarnation obtains project-scoped execution contexts; foreign actors and project IDs are refused. The existing Router Board delivers named work messages through actual native parents and records mailbox receipts.

Domain tools expose paged samples and history, current device methods, physical commands, verified output reads, logical waits and phase delivery. Event waits return and acknowledge accepted unread Router mail, recording consumption with the corresponding mailbox receipt. A delivery requires prior verified reads by that participant. Router completion additionally requires a valid physical phase delivery. Revisions and withdrawals reopen affected assignments; later-phase evidence must use the actual prerequisite sample lineage. Temperature, utility, supply and project changes route to responsible roles through native inputs, with committed event delivery awaited before further logical advancement.

The native tests cover exact identities, peer messages, self-assignment, verified delivery, reopening and selective environmental input. A scripted native Single completes a physical phase through tool replies and event waits. The shared `install-multi.py --environment laboratory --source real-model` installer creates `laboratory-single` or `laboratory-multi` profiles, records the same model and compression policy, and snapshots laboratory and shared runtime sources. Startup rejects changed source snapshots. The explicit `--source scripted --mode single-agent` laboratory profile uses public tool replies for the complete scenario. Long scripted runs use the ordinary profile lifecycle, with no project runtime limit. Its provider reports scripted identity and production token usage remains zero. The native Multi scripted policy delegates released phases across facilities, experiments and quality while the coordinator controls dependency order. This integration policy uses serial phase dispatch to validate the complete shared evidence path. Real-model participants retain independent parallel operation submission.

## Verification

`evaluate.py` independently reads device state, execution records, artifact hashes, Router state and native Sessions. It checks current methods, distinct original samples, actual phase lineage, verified result reads before native delivery, mailbox input and stock accounting. It derives completion and task latency in logical ticks, records per-route usage and measures physical overlap, repeats and native compression continuity using Session event order. Latest completed Router deliveries must reach an actual owner response. The read-only `laboratory-report` profile displays immutable reports produced by `compare.py`; formal comparison readiness additionally requires real-model identity, matching recorded policies and observed direct model sockets. `--offline` requires a stopped host and checkpointed databases. The evaluator tests alter private copies to check artifact, lineage and native-read rejection.

Task completion rate uses all declared scenario tasks as its denominator; the live view also labels the completion rate for released tasks. An unfinished trial can have valid evidence. Material-state reachability includes possible outputs and measurements of in-flight processing or aliquoting. Terminal material loss requires every remaining task to be impossible even under that optimistic assessment, no active physical operations, and all scheduled faults, revisions and task releases applied. Resource shortages and slow model decisions alone do not end a trial.

Human intervention count is the number of execution operations submitted as `laboratory-operator`, including failed device actions. Re-reading or retrying the same accepted operation does not add an intervention. The evaluator records operation IDs and reconstructs autonomous deliveries immediately before the first intervention from device event sequence, preserving separate autonomous and assisted completion rates. Single and Multi require matching recorded assistance policies; assisted evidence is reported separately from autonomous comparison readiness. The live view marks intervention count as pending while execution actor records are unavailable.

`world.spec.ts` covers the physical chain, restart, cancellation, concurrent admission, storage reservations, expiry and calibration review. `provider.spec.ts` exercises the actual ExecutionEngine and artifact reader, identity checks and post-admission refusals.

`feasibility.spec.ts` completes all 52 tasks through the real ExecutionEngine while preserving the configured faults, supply recall and method revision. It verifies an executable recovery path with a scripted policy, including facility maintenance, water refill and supply ordering.

The clock retains exclusive ownership through failure and awaits pending delivery during disposal. Full real-model paired trials, repeated scenarios and final browser evidence remain part of experimental verification.
