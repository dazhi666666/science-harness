"""Install the joint laboratory environment as a normal dsh profile."""
import argparse
import json
import pathlib


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=pathlib.Path, required=True)
    parser.add_argument('--directory', type=pathlib.Path)
    parser.add_argument('--report', type=pathlib.Path)
    parser.add_argument('--scenario', type=pathlib.Path)
    parser.add_argument('--seed', type=int, default=1)
    parser.add_argument('--port', type=int, default=0)
    args = parser.parse_args()
    if args.seed < 1 or args.seed > 9007199254740991 or not 0 <= args.port <= 65535:
        parser.error('seed must be a positive safe integer and port must be 0..65535')
    here = pathlib.Path(__file__).resolve().parent
    if bool(args.directory) == bool(args.report):
        parser.error('Specify exactly one of --directory or --report')
    name = 'laboratory-report' if args.report else 'laboratory-environment'
    profile = args.home.resolve() / 'profiles' / name
    marker = profile / 'laboratory-install.json'
    if profile.exists() and not marker.is_file():
        raise SystemExit('Refusing to overwrite an unowned profile')
    if args.report:
        report = args.report.resolve(strict=True)
        json.loads(report.read_text())
        config = {'reportFile': str(report), 'port': args.port}
        if args.scenario:
            parser.error('--scenario cannot be combined with --report')
    else:
        config = {'directory': str(args.directory.resolve()), 'seed': args.seed, 'port': args.port,
                  'refreshMs': 100, 'providerCallTimeoutMs': 10000}
    if args.scenario:
        scenario = args.scenario.resolve(strict=True)
        json.loads(scenario.read_text())
        config['scenarioFile'] = str(scenario)
    profile.mkdir(parents=True, exist_ok=True, mode=0o700)
    (profile / 'package.json').write_text(json.dumps({'name': 'dsh-profile-' + name, 'private': True,
        'type': 'module', 'dependencies': {}, 'dsh': {'profile': {'bundles': [], 'patchReload': 'startup'}}}, indent=2) + '\n')
    (profile / 'cordis.patch.yml').write_text(json.dumps([{'insert': [{'id': name,
        'name': str(here / ('report.ts' if args.report else 'plugin.ts')), 'config': config}]}], indent=2) + '\n')
    marker.write_text(json.dumps({'source': str(here), 'mode': 'saved-report' if args.report else 'environment-only', **config}, indent=2) + '\n')
    print(json.dumps({'profile': name, 'callsModels': False}))


if __name__ == '__main__':
    main()
