"""Install a native multi-Agent dsh profile with Router mailboxes and the existing science-harness frontend."""
import argparse
import hashlib
import json
import pathlib
import re
from urllib.parse import urlparse


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=pathlib.Path, required=True)
    parser.add_argument('--directory', type=pathlib.Path, required=True)
    parser.add_argument('--scenario', type=pathlib.Path)
    parser.add_argument('--environment', choices=['greenhouse', 'laboratory'], default='greenhouse')
    parser.add_argument('--seed', type=int, default=1)
    parser.add_argument('--mode', choices=['single-agent', 'multi-agent'], default='multi-agent')
    parser.add_argument('--clock-mode', choices=['event-driven', 'timer'], default='event-driven')
    parser.add_argument('--idle-review-ticks', type=int, default=30, help='Virtual review interval, not a runtime limit')
    parser.add_argument('--source', choices=['scripted', 'real-model'], required=True)
    parser.add_argument('--base-url', default='https://chat.intern-ai.org.cn/api/v1/')
    parser.add_argument('--api-key-env', default='INTERN_API_KEY')
    parser.add_argument('--extra-key-env', action='append', default=[], help='Additional credential environment name; repeat for a shared request pool')
    parser.add_argument('--comparison-file', type=pathlib.Path, help='Optional saved evaluator report displayed by Mission Control')
    parser.add_argument('--compaction-policy', type=pathlib.Path, help='Optional native compaction configuration overrides; use the same file for both modes')
    parser.add_argument('--direct-interface', help='Physical network interface for the model origin only; bypasses a local TUN proxy')
    parser.add_argument('--direct-address', help='Public IPv4 for that model hostname; TLS still verifies the hostname')
    parser.add_argument('--port', type=int, default=0)
    args = parser.parse_args()
    endpoint = urlparse(args.base_url)
    if endpoint.scheme != 'https' or not endpoint.hostname or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment:
        parser.error('--base-url must be an HTTPS endpoint without credentials, query or fragment')
    if any(not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', name) for name in [args.api_key_env, *args.extra_key_env]):
        parser.error('--api-key-env must name an environment variable, never contain a key value')
    if bool(args.direct_interface) != bool(args.direct_address):
        parser.error('--direct-interface and --direct-address must be supplied together')
    if not 0 <= args.port <= 65535:
        parser.error('--port must be 0..65535')
    if not 1 <= args.seed <= 9007199254740991:
        parser.error('--seed must be a positive safe integer')
    if args.environment == 'laboratory' and args.comparison_file:
        parser.error('Laboratory paired reporting must use its domain evaluator; greenhouse comparison files are incompatible')
    if args.environment == 'laboratory' and args.clock_mode != 'event-driven':
        parser.error('Laboratory installation requires event-driven profiles')
    if args.idle_review_ticks < 1:
        parser.error('--idle-review-ticks must be positive')
    here = pathlib.Path(__file__).resolve().parent
    repo = here.parents[2]
    directory = args.directory.resolve()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    scenario = args.scenario or (here / ('fixtures/baseline.scenario.json' if args.source == 'scripted' else 'scenario.json') if args.environment == 'greenhouse' else None)
    if scenario:
        scenario = scenario.resolve(strict=True)
        json.loads(scenario.read_text())
    project = 'mars-greenhouse' if args.environment == 'greenhouse' else 'joint-laboratory'
    profile_name = ('greenhouse-single' if args.mode == 'single-agent' else 'greenhouse-multi') + ('-scripted' if args.source == 'scripted' else '')
    if args.environment == 'laboratory':
        profile_name = ('laboratory-single' if args.mode == 'single-agent' else 'laboratory-multi') + ('-scripted' if args.source == 'scripted' else '')
    profile = args.home.resolve() / 'profiles' / profile_name
    marker = profile / ('laboratory-install.json' if args.environment == 'laboratory' else 'greenhouse-install.json')
    if profile.exists() and not marker.is_file():
        raise SystemExit('Refusing to overwrite an unowned profile')
    if (directory / 'router' / 'board.json').exists() or any((directory / 'device' / name).exists() for name in ['greenhouse.sqlite', 'laboratory.sqlite']):
        raise SystemExit('Agent run already has task history; choose a new directory, do not delete evidence')
    profile.mkdir(parents=True, exist_ok=True, mode=0o700)
    modules = {
        'llm': 'llm/llm', 'sessions': 'core/session', 'system-prompt': 'core/system-prompt',
        'tools': 'core/tools', 'agents': 'core/agent', 'projections': 'session/session-projection',
        'jsonl': 'session/session-persistence-jsonl', 'query': 'session-query/session-query-sqlite',
        'loop': 'core/agent-loop', 'subagents': 'subagent/subagent', 'fs-local': 'fs/fs-local',
        'working-directory': 'session/working-directory', 'spawn': 'subagent/subagent-spawn-in-process',
        'storage': 'storage/storage', 'storage-json': 'storage/storage-json', 'storage-domain': 'storage/storage-domain',
    }
    configs = {
        'jsonl': {'root': str(directory / 'sessions'), 'compression': 'none'},
        'query': {'path': ':memory:', 'openAt': 'never'}, 'loop': {'agents': []},
        'subagents': {'scienceResultProject': project, 'scienceResultMaxPending': 16, 'scienceResultMaxPairs': 3},
        'fs-local': {'cwd': str(directory)}, 'working-directory': {'defaultDirectory': str(directory)},
        'spawn': {'providerName': 'spawn'}, 'storage-json': {'root': str(directory / 'records')},
        'storage-domain': {'backend': 'json'},
    }
    rows = [{'id': name, 'name': str(repo / 'packages' / module / 'src/index.ts'),
             **({'config': configs[name]} if name in configs else {})} for name, module in modules.items()]
    if args.source == 'scripted':
        rows.append({'id': 'greenhouse-scripted', 'name': str(here / 'fixtures/model.ts')})
        model = {'provider': 'greenhouse-scripted', 'model': 'single-baseline' if args.mode == 'single-agent' else 'baseline'}
        if args.environment == 'laboratory':
            rows[-1] = {'id': 'laboratory-scripted', 'name': str(here / 'laboratory' / 'scripted-model.ts')}
            model = {'provider': 'laboratory-scripted', 'model': 'single-workflow' if args.mode == 'single-agent' else 'team-workflow'}
    else:
        rows.append({'id': 'llm-retry', 'name': str(repo / 'packages/llm/llm-retry/src/index.ts')})
        rows.append({'id': 'llm-pi-ai', 'name': str(repo / 'packages/llm/llm-pi-ai/src/index.ts'), 'config': {'providers': {
            'intern-greenhouse': {'api': 'openai-completions', 'baseURL': args.base_url,
                'apiKeyEnv': args.api_key_env, 'timeoutMs': 180000, 'streamIdleTimeoutMs': 180000,
                'retryPolicy': {'mode': 'always', 'backoff': {'initialDelayMs': 1000, 'maxDelayMs': 10000, 'jitterRatio': 0.2}},
                'compat': {'supportsStore': False, 'supportsDeveloperRole': False, 'supportsReasoningEffort': False, 'maxTokensField': 'max_tokens'},
                'models': [{'id': 'intern-s2', 'name': 'intern-s2', 'contextWindow': 256000, 'maxTokens': 8192}]},
        }}})
        profiles = rows[-1]['config']['providers']
        key_envs = list(dict.fromkeys([args.api_key_env, *args.extra_key_env]))
        for index, key_env in enumerate(key_envs[1:], 2):
            profiles[f'intern-greenhouse-{index}'] = {**profiles['intern-greenhouse'], 'apiKeyEnv': key_env}
        compaction = {'auto': True, 'thresholdRatio': 0.8, 'headroomTokens': 32768, 'retainRatio': 0.16,
                      'maxTokens': 8192}
        if args.compaction_policy:
            overrides = json.loads(args.compaction_policy.read_text())
            if not isinstance(overrides, dict):
                parser.error('--compaction-policy must contain a native configuration object')
            if 'retainTokens' in overrides:
                compaction.pop('retainRatio')
            compaction.update(overrides)
        rows += [{'id': 'token-meter', 'name': str(repo / 'packages/llm/token-meter/src/index.ts')},
                 {'id': 'compaction-basic', 'name': str(repo / 'packages/compaction/compaction-basic/src/index.ts'),
                  'config': compaction}]
        model = {'provider': 'intern-greenhouse', 'model': 'intern-s2', 'maxTokens': 4096}
    rows.append({'id': 'greenhouse-agents', 'name': str(here / 'agents.ts'), 'config': {
        'directory': str(directory), 'scenarioFile': str(scenario), 'project': 'mars-greenhouse',
        'mode': args.mode, 'port': args.port, 'refreshMs': 100, 'providerCallTimeoutMs': 10000, 'source': args.source, 'model': model,
        'clockMode': args.clock_mode, 'idleReviewTicks': args.idle_review_ticks,
        **({'providerPool': list(profiles)} if args.source == 'real-model' else {}),
        **({'comparisonFile': str(args.comparison_file.resolve())} if args.comparison_file else {}),
        **({'directTransport': {'origin': f'{endpoint.scheme}://{endpoint.netloc}',
                               'interface': args.direct_interface, 'address': args.direct_address}} if args.direct_interface else {}),
    }})
    if args.environment == 'laboratory':
        agent_config = rows[-1]['config']
        for field in ['clockMode', 'idleReviewTicks', 'comparisonFile', 'scenarioFile']:
            agent_config.pop(field, None)
        agent_config.update({'seed': args.seed, 'project': project})
        if args.source == 'scripted':
            agent_config['providerPool'] = ['laboratory-scripted']
        if scenario:
            agent_config['scenarioFile'] = str(scenario)
        rows[-1]['id'] = 'laboratory-agents'
        rows[-1]['name'] = str(here / 'laboratory' / 'agents.ts')
    (profile / 'package.json').write_text(json.dumps({'name': 'dsh-profile-' + profile_name, 'private': True,
        'type': 'module', 'dependencies': {}, 'dsh': {'profile': {'bundles': [], 'patchReload': 'startup'}}}, indent=2) + '\n')
    (profile / 'cordis.patch.yml').write_text(json.dumps([{'insert': rows}], indent=2) + '\n')
    sources = {path.name: path.read_bytes() for path in here.glob('*.ts')
               if not path.name.endswith('.spec.ts') and path.name != 'vitest.config.ts'}
    if args.environment == 'laboratory':
        sources.update({'laboratory/' + path.name: path.read_bytes() for path in (here / 'laboratory').glob('*.ts')
                        if not path.name.endswith('.spec.ts')})
    snapshot = directory / 'source-snapshot'
    snapshot.mkdir(exist_ok=True, mode=0o700)
    for filename, content in sources.items():
        destination = snapshot / filename
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        destination.write_bytes(content)
    record = {'source': str(here), 'directory': str(directory), 'modelSource': args.source,
              'clockPolicy': {'mode': args.clock_mode, 'idleReviewTicks': args.idle_review_ticks},
              'scenario': str(scenario) if scenario else None, 'seed': args.seed, 'environment': args.environment, 'profile': profile_name,
              'transportPolicy': rows[-1]['config'].get('directTransport'),
              'sourceHashes': {filename: hashlib.sha256(content).hexdigest() for filename, content in sources.items()},
              'modelPolicy': [row['config'] for row in rows if row['id'] in ['llm-pi-ai', 'compaction-basic']]}
    marker.write_text(json.dumps(record, indent=2) + '\n')
    (directory / 'installation.json').write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps({'profile': profile_name, 'modelSource': args.source, 'callsExternalModel': args.source == 'real-model',
        'directory': str(directory)}))


if __name__ == '__main__':
    main()
