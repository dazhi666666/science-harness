"""Stage CI evidence as regular files, without traversing dependency trees or symbolic links."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat


def collect(sources, output):
    """Copy completed test records into a fresh upload directory and record file hashes."""
    sources = [Path(source).absolute() for source in sources]
    output = Path(output).absolute()
    if len({source.name for source in sources}) != len(sources):
        raise ValueError('Evidence roots must have distinct names')
    if any(output.resolve().is_relative_to(source.resolve()) for source in sources):
        raise ValueError('Upload directory must be outside the evidence roots')
    output.mkdir(parents=True, exist_ok=False)
    manifest = {'files': [], 'skipped': [], 'missingRoots': []}

    def walk_error(error):
        raise error

    for source in sources:
        if source.is_symlink():
            manifest['skipped'].append(source.name)
            continue
        if not source.exists():
            manifest['missingRoots'].append(source.name)
            continue
        if not source.is_dir():
            raise ValueError(f'Evidence root must be a directory: {source}')
        for directory, dirs, files in os.walk(source, followlinks=False, onerror=walk_error):
            parent = Path(directory)
            for name in list(dirs):
                path = parent / name
                if name == 'node_modules' or path.is_symlink():
                    dirs.remove(name)
                    manifest['skipped'].append((Path(source.name) / path.relative_to(source)).as_posix())
            for name in sorted(files):
                path = parent / name
                relative = Path(source.name) / path.relative_to(source)
                if not stat.S_ISREG(path.lstat().st_mode):
                    manifest['skipped'].append(relative.as_posix())
                    continue
                target = output / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, target, follow_symlinks=False)
                manifest['files'].append({
                    'path': relative.as_posix(), 'bytes': target.stat().st_size,
                    'sha256': hashlib.sha256(target.read_bytes()).hexdigest(),
                })
    manifest['files'].sort(key=lambda item: item['path'])
    manifest['skipped'].sort()
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, nargs='+', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    manifest = collect(args.source, args.output)
    print(json.dumps({'files': len(manifest['files']), 'skipped': len(manifest['skipped']),
                      'missingRoots': manifest['missingRoots']}))
