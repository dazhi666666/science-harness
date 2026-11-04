"""Install an environment or saved-report dsh profile without model credentials."""
import argparse
import json
import pathlib


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=pathlib.Path, required=True)
    parser.add_argument('--directory', type=pathlib.Path)
    parser.add_argument('--scenario', type=pathlib.Path)
    parser.add_argument('--report', type=pathlib.Path, help='Show an immutable comparison report instead of starting an environment')
    parser.add_argument('--port', type=int, default=2301)
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error('--port must be 0..65535')
    here = pathlib.Path(__file__).resolve().parent
    if args.report:
        if args.directory or args.scenario:
            parser.error('--report cannot be combined with --directory or --scenario')
        report = args.report.resolve(strict=True)
        json.loads(report.read_text())
        name, mode = 'greenhouse-report', 'saved-report'
        config = {'reportFile': str(report), 'port': args.port}
        record = {'report': str(report), 'mode': mode}
        module = 'results.ts'
    else:
        if args.directory is None:
            parser.error('--directory is required for an environment')
        scenario = (args.scenario or here / 'scenario.json').resolve(strict=True)
        json.loads(scenario.read_text())
        name, mode = 'greenhouse-environment', 'environment-only'
        config = {'directory': str(args.directory.resolve()), 'scenarioFile': str(scenario),
                  'project': 'mars-greenhouse', 'port': args.port, 'refreshMs': 500, 'providerCallTimeoutMs': 10000}
        record = {'directory': str(args.directory.resolve()), 'scenario': str(scenario), 'mode': mode}
        module = 'plugin.ts'
    profile = args.home.resolve() / 'profiles' / name
    marker = profile / 'greenhouse-install.json'
    if profile.exists() and not marker.is_file():
        raise SystemExit('Refusing to overwrite an unowned profile')
    profile.mkdir(parents=True, exist_ok=True, mode=0o700)
    (profile / 'package.json').write_text(json.dumps({
        'name': 'dsh-profile-' + name, 'private': True, 'type': 'module',
        'dependencies': {}, 'dsh': {'profile': {'bundles': [], 'patchReload': 'startup'}},
    }, indent=2) + '\n')
    (profile / 'cordis.patch.yml').write_text(json.dumps([{'insert': [{
        'id': name, 'name': str(here / module), 'config': config,
    }]}], indent=2) + '\n')
    marker.write_text(json.dumps({'source': str(here), **record}, indent=2) + '\n')
    print(json.dumps({'profile': str(profile), 'mode': mode, 'callsModels': False}))


if __name__ == '__main__':
    main()
