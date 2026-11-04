"""Launch an installed dsh profile with private environment credentials; never print credential values."""
import argparse
import os
import pathlib
import re


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=pathlib.Path, required=True)
    parser.add_argument('--profile', required=True)
    parser.add_argument('--credentials-file', type=pathlib.Path)
    parser.add_argument('--no-proxy', action='store_true', help='Clear proxy variables only in the launched process')
    args = parser.parse_args()
    profile = args.home.resolve() / 'profiles' / args.profile
    if not (profile / 'greenhouse-install.json').is_file():
        parser.error('Expected a profile created by the greenhouse installer')
    env = dict(os.environ)
    if args.credentials_file:
        for line in args.credentials_file.read_text().splitlines():
            if not line.strip() or line.lstrip().startswith('#'):
                continue
            name, separator, value = line.partition('=')
            if not separator or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', name):
                parser.error('Credential file must contain plain NAME=value lines')
            env[name] = value
    if args.no_proxy:
        for name in list(env):
            if name.upper() in ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NODE_USE_ENV_PROXY']:
                env.pop(name, None)
        env['NO_PROXY'] = '*'
        env['no_proxy'] = '*'
    env['DSH_HOME'] = str(args.home.resolve())
    os.chdir(pathlib.Path(__file__).resolve().parents[3])
    os.execvpe('pnpm', ['pnpm', 'dsh', '--profile', args.profile], env)


if __name__ == '__main__':
    main()
