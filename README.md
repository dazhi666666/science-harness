# science-harness — Infrastructure v0.1

AI4Science Harness is a small, plugin-oriented foundation for scientific Agent organizations and execution Providers. It keeps Agent lifecycle, sessions, native parent-child execution, residency, messaging, and shutdown in DeepSeek Harness while adding configurable organization policy, durable operation records, resource and budget control, result provenance, cancellation, and restart reconciliation.

The repository is intended for community development. A Provider can implement the public `describe / prepare / submit / query / cancel` interface and register through configuration without changing the execution core. The reference integrations include a simulated instrument and a resumable long-running computation. The original first-loop research scenario remains an example application rather than a platform rule.

This release targets one trusted management domain on one machine. It does not claim physical-device safety, distributed high availability, multi-tenant isolation, model-thought recovery, or scientific correctness of model-authored reports. The upstream Harness baseline and local host changes are recorded in [UPSTREAM.json](UPSTREAM.json). The license for new AI4Science additions is still pending project-owner selection; upstream Harness and third-party components retain their existing licenses.

**The license for the AI4Science additions has not yet been selected. These additions are not presented as released under an open-source license.** Harness and third-party components retain their existing licenses. Local validation records do not establish the status of GitHub-hosted CI.

## Project Vision

The long-term vision of science-harness is to provide a foundation for scientific systems that can advance research from an initial question to evidence-supported conclusions. Given a research scope, available capabilities, and operating constraints, such a system could formulate hypotheses, develop experimental plans, collect observations, analyze results, revise its assumptions, and decide which investigation to pursue next. Each decision should remain connected to the evidence and execution history that motivated it.

Research is iterative. An experiment may fail, a hypothesis may be contradicted, or a result may expose a better question. We want the infrastructure to support that uncertainty: preserve unsuccessful attempts, distinguish observations from interpretations, and let researchers revisit earlier decisions without losing their provenance. Reports and papers are outputs of this process; the underlying measurements, computational artifacts, methods, and limitations must remain inspectable.

Agent organizations should follow the needs of the research problem. A small task may use one researcher and one execution capability. A larger investigation may involve several research branches, shared analysis specialists, and participants responsible for different instruments or computational jobs. These organizations should be able to form during work, delegate within explicit limits, and establish authorized collaboration as new needs emerge. Scientific responsibilities can change while the host continues to own Agent execution and the infrastructure preserves the facts of the project.

Scientific methods and execution capabilities should also evolve independently. We want a community contributor to integrate a simulator, an existing analysis program, a long computation, or an instrument through a focused plugin interface. Other contributors should be able to develop research strategies, role configurations, statistical methods, or reporting tools on the same foundation. Computational research, simulation, and eventual laboratory or robotic integrations will have different requirements; each adapter must describe and validate the behavior it actually supports.

Research records must outlive individual conversations and Agent instances. A new authorized participant should be able to understand the task, inspect previous operations and results, and continue managing unresolved work. Persistent records should make it possible to trace a claim back through its analysis and source data, understand which inputs and configurations produced a result, and distinguish a completed operation from one whose outcome is still uncertain.

Greater autonomy depends on dependable execution and clear authority. Models can propose research actions and interpret observations, while programs enforce permissions, resource ownership, budgets, operation identity, and lifecycle rules. The infrastructure should support human review where a project requires it and preserve useful records when an operation cannot safely or reliably continue. More capable production models can improve research decisions while using the same execution and accountability mechanisms.

We intend to develop this foundation through community use: practical adapters, reproducible examples, documented failures, and interfaces that improve as different research groups exercise them. Infrastructure v0.1 establishes an initial contribution path through configurable organizations, a public Provider interface, and recoverable execution records. Broad scientific autonomy, reliable physical-device integration, and strong scientific reasoning remain long-term goals that require separate evidence. Current infrastructure progress is measured by whether developers can change an organization, connect a capability, and retain control of a long-running operation through failure and restart.

## Quick Start

You need Node.js 22.19+ (local validation used 22.23.1), pnpm 11.19.0, Python 3, and a C++ build toolchain. The validated platform is macOS arm64; other operating systems have not been verified.

Run these commands from the repository root:

```sh
python3 integrations/ai4science/platform/setup.py
python3 integrations/ai4science/platform/install.py --home .ai4science/home --config integrations/ai4science/platform/examples/local.config.json
python3 integrations/ai4science/platform/manage.py --home .ai4science/home create --project example --budget 10000
python3 integrations/ai4science/platform/manage.py --home .ai4science/home describe --project example
python3 integrations/ai4science/platform/manage.py --home .ai4science/home start --project example --provider compute --key compute-1 --input integrations/ai4science/platform/examples/compute-input.json --wait
python3 integrations/ai4science/platform/manage.py --home .ai4science/home status --project example
```

The setup script installs dependencies from the two existing lockfiles, compiles the host's `fs-ext` dependency, and builds type declarations. The application entry remains `dsh --profile ai4science`; `manage.py` launches it from source. Configuration determines project and device directories. Git ignores generated example data.

## Capabilities

- Configure roles, instructions, models, tools, creation permissions, participant limits, and delegation depth. Create participants at runtime through native Harness mechanisms.
- Exchange persistent result references and correlated replies between participants with different real parents, after both parents independently authorize the relationship. Preserve the original sender, exact live-instance checks, and default denial.
- Store projects, request identities, resources, budgets, operation states, results, and task facts in one SQLite execution database. Repeated requests return the original operation across restarts.
- Use two independent reference Providers: a shared simulated instrument and a hash computation that continues in chunks. Independent device journals record actual execution to detect duplicate actions.
- Wait in program code, request cancellation, reconcile after restart, verify result integrity, and export artifacts. Keep the original first-loop research scenario as an example application.

## Development Entry Points

| Development task | Entry point |
|---|---|
| Integrate a device or computation capability | [Public SDK](integrations/ai4science/platform/sdk.ts), [Provider test utilities](integrations/ai4science/platform/testing.ts) |
| Explore reference Providers | [Simulated instrument](integrations/ai4science/platform/providers/instrument.ts), [long computation](integrations/ai4science/platform/providers/compute.ts) |
| Change the organization | [Role configuration and validation](integrations/ai4science/platform/organization.ts), [example configurations](integrations/ai4science/platform/scenes/) |
| Compose the host plugin | [platform/plugin.ts](integrations/ai4science/platform/plugin.ts) |
| Manage persistent execution and results | [execution.ts](integrations/ai4science/platform/execution.ts), [artifacts.ts](integrations/ai4science/platform/artifacts.ts) |
| Understand architecture, permissions, and lifecycle | [architecture.md](architecture.md) |
| Run operations and the first-loop example | [first-loop.md](first-loop.md) |

A Provider module exports `createProvider(config)`, depends only on the public `sdk.ts`, and implements `describe / prepare / submit / query / cancel`. Register it by adding its module path and parameters to the deployment JSON; no core edit is required. Provider parameters and scientific research stages belong outside the execution core.

## Testing and Contributions

```sh
python3 integrations/ai4science/platform/check.py --output .ai4science/check-01
```

This command requires no model credentials. It runs infrastructure tests, existing communication and permission tests, minimum-plugin tests, Teams tests, first-loop boundary tests, and relevant upstream regressions. It also runs acceptance checks across separate processes through the actual CLI. Use a fresh output directory for each run. Results are written there; runtime data is not committed to Git.

The original v0.1 delivery passed 36 infrastructure tests and 237 retained regressions (273 total), plus 29 actual CLI commands and 25 assertions. Complete historical evidence remains in the delivery ZIP. The source repository includes a [public summary](validation/v0.1.json), without sessions containing local paths, device databases, or personal configuration. A GitHub workflow configuration alone is not evidence that remote checks have passed.

When submitting a change, describe the problem, implementation, and checks actually executed. Provider changes need independent device execution records and tests for duplicate requests, cancellation, and recovery. Permission changes must retain negative tests. Do not present scripted responses as real-model execution or use scientific conclusion quality as an infrastructure acceptance requirement. Community code contributions should wait until the license is selected; no CLA or contributor licensing terms have been established.

## Scope and Limitations

This version supports one trusted management domain on one machine, with one effective controller per device scope. It can retain multiple projects, but each active Harness organization is associated with one project. Reference Providers advance local work when queried and pause while no controller queries them.

An `unknown` operation retains its resources and budget and is never automatically replayed. The full conservative budget is charged at registration, with no automatic refund after cancellation. Closing an Agent, plugin, or CLI does not prove that a device has stopped. A permanently hung adapter requires external process termination followed by reconciliation after restart. Physical devices, multi-tenancy, distributed high availability, model-thought recovery, and malicious-plugin isolation are outside this version's verified scope.

## Upstream and Licensing

The Harness baseline is pinned to `d347e703908d0406b7a7ef80e3a0e594d86b2215`. The host is modified: the repository source already includes the [complete host patch](patches/harness-ai4science-v0.1.patch). Do not apply it again. [UPSTREAM.json](UPSTREAM.json) records the baseline, affected files, and patch hash.

The upstream MIT license and DeepSeek copyright notice remain in [LICENSE](LICENSE). Third-party licenses remain in their component directories. The license status of the new AI4Science code is recorded in [integrations/ai4science/LICENSE](integrations/ai4science/LICENSE) and must be decided by the project owner before a formal release.
