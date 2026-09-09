"""Install the AI4Science management plugin into a private dsh profile; retain execution data on uninstall."""
import argparse
import json
import pathlib
import shutil


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=pathlib.Path, required=True, help='Dedicated DSH_HOME directory')
    parser.add_argument('--config', type=pathlib.Path, help='Platform JSON configuration')
    parser.add_argument('--uninstall', action='store_true', help='Remove only this owned profile, without deleting execution or Provider records')
    args = parser.parse_args()
    here = pathlib.Path(__file__).resolve().parent
    home = args.home.resolve()
    profile = home / 'profiles' / 'ai4science'
    marker = profile / 'ai4science-install.json'
    if args.uninstall:
        if not marker.is_file():
            raise SystemExit('Refusing to remove an unowned or absent profile')
        shutil.rmtree(profile)
        print(json.dumps({'uninstalledProfile': str(profile), 'executionRecordsDeleted': False}))
        return
    if args.config is None:
        parser.error('--config is required for installation')
    config = args.config.resolve(strict=True)
    json.loads(config.read_text())
    if profile.exists() and not marker.is_file():
        raise SystemExit('Refusing to overwrite an existing profile not owned by this installer')
    profile.mkdir(parents=True, exist_ok=True, mode=0o700)
    manifest = {'name': 'dsh-profile-ai4science', 'private': True, 'type': 'module', 'dependencies': {},
                'dsh': {'profile': {'bundles': [], 'patchReload': 'startup'}}}
    (profile / 'package.json').write_text(json.dumps(manifest, indent=2) + '\n')
    # JSON is a YAML subset. Absolute source paths keep plugin resolution independent of cwd.
    patch = [{'insert': [{'id': 'ai4science-management', 'name': str(here / 'cli.ts'), 'config': {'configPath': str(config)}}]}]
    (profile / 'cordis.patch.yml').write_text(json.dumps(patch, indent=2) + '\n')
    marker.write_text(json.dumps({'version': json.loads((here / 'package.json').read_text())['version'], 'source': str(here), 'config': str(config)}, indent=2) + '\n')
    print(json.dumps({'installedProfile': str(profile), 'entry': 'dsh --profile ai4science', 'config': str(config)}))


if __name__ == '__main__':
    main()
