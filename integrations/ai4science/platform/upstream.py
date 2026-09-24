"""Bind the read-only Harness upstream, inspect updates, or prepare an isolated integration worktree."""
import argparse
import json
import os
import pathlib
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['check', 'prepare'])
    parser.add_argument('--directory', type=pathlib.Path, help='New worktree directory for prepare')
    args = parser.parse_args()
    repo = pathlib.Path(__file__).resolve().parents[3]
    metadata = json.loads((repo / 'UPSTREAM.json').read_text())
    env = dict(os.environ, GIT_TERMINAL_PROMPT='0')
    def git(*arguments, cwd=repo, check=True):
        return subprocess.run(['git', *arguments], cwd=cwd, env=env, capture_output=True, text=True, check=check)
    expected = metadata['upstreamRepository'].removesuffix('.git')
    current = git('remote', 'get-url', 'upstream', check=False)
    if current.returncode:
        git('remote', 'add', 'upstream', expected + '.git')
    elif current.stdout.strip().removesuffix('.git') != expected:
        raise SystemExit('Existing upstream does not match UPSTREAM.json; refusing to replace an unrelated remote')
    git('remote', 'set-url', '--push', 'upstream', 'DISABLED')
    branch = metadata['upstreamBranch']
    git('fetch', 'upstream', f'{branch}:refs/remotes/upstream/{branch}')
    latest = git('rev-parse', f'upstream/{branch}').stdout.strip()
    base = metadata['upstreamCommit']
    if git('merge-base', '--is-ancestor', base, latest, check=False).returncode:
        raise SystemExit('Upstream history no longer descends from the pinned baseline; manual review required')
    record = {'pinned': base, 'latest': latest, 'newCommits': int(git('rev-list', '--count', f'{base}..{latest}').stdout), 'upstreamPushDisabled': True}
    if args.action == 'prepare' and latest != base:
        if args.directory is None:
            parser.error('--directory is required to prepare an integration')
        if git('status', '--porcelain').stdout:
            raise SystemExit('Commit or stash local changes before preparing an upstream merge')
        directory = args.directory.resolve()
        integration = f'integrate/upstream-{latest[:12]}'
        git('worktree', 'add', '-b', integration, str(directory), 'HEAD')
        merged = git('merge', '--no-commit', '--no-ff', f'upstream/{branch}', cwd=directory, check=False)
        record.update({'branch': integration, 'directory': str(directory), 'mergeExitCode': merged.returncode,
                       'mergeOutput': merged.stdout + merged.stderr, 'conflicts': git('diff', '--name-only', '--diff-filter=U', cwd=directory).stdout.splitlines(),
                       'next': 'Port the local host patch, update UPSTREAM.json and example pins, run setup/checks, then commit and push. Main is unchanged.'})
    print(json.dumps(record, indent=2))


if __name__ == '__main__':
    main()
