"""Run the installed AI4Science dsh profile from this verified source checkout."""
import argparse
import os
import pathlib
import signal
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__, add_help=False)
    parser.add_argument('--home', type=pathlib.Path, required=True)
    args, forwarded = parser.parse_known_args()
    here = pathlib.Path(__file__).resolve().parent
    repo = here.parents[2]
    home = args.home.resolve()
    if not (home / 'profiles' / 'ai4science' / 'ai4science-install.json').is_file():
        raise SystemExit('AI4Science profile is not installed; run install.py --home DIR --config FILE')
    env = os.environ.copy()
    env['DSH_HOME'] = str(home)
    env['DSH_TELEMETRY_DISABLED'] = '1'
    command = ['node', '--import', 'tsx/esm', str(repo / 'apps/cli/src/bin.ts'), '--profile', 'ai4science', *forwarded]
    process = subprocess.Popen(command, cwd=repo, env=env)
    def forward(signum, _frame):
        if process.poll() is None:
            process.send_signal(signum)
    signal.signal(signal.SIGINT, forward)
    signal.signal(signal.SIGTERM, forward)
    raise SystemExit(process.wait())


if __name__ == '__main__':
    main()
