"""Compare the supplied source archive against a specified local upstream Git revision."""
import argparse
import hashlib
import json
import pathlib
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--git-repo", required=True)
parser.add_argument("--revision", default=json.loads((pathlib.Path(__file__).resolve().parents[2] / "UPSTREAM.json").read_text())["upstreamCommit"])
args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parents[2]
commit = subprocess.check_output(
    ["git", "-C", args.git_repo, "rev-parse", args.revision], text=True
).strip()
tree = subprocess.check_output(["git", "-C", args.git_repo, "ls-tree", "-rz", commit])
checked = 0
mismatches = []
for entry in tree.split(b"\0"):
    if not entry:
        continue
    metadata, path_bytes = entry.split(b"\t", 1)
    mode, kind, expected = metadata.split()
    if kind != b"blob":
        continue
    path = root / path_bytes.decode()
    checked += 1
    try:
        data = str(path.readlink()).encode() if mode == b"120000" else path.read_bytes()
    except FileNotFoundError:
        mismatches.append({"path": path_bytes.decode(), "reason": "missing"})
        continue
    actual = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
    if actual != expected.decode():
        mismatches.append({"path": path_bytes.decode(), "expected": expected.decode(), "actual": actual})
report = {"commit": commit, "tracked_blobs_checked": checked, "mismatches": mismatches}
output = pathlib.Path(__file__).parent / "evidence/source-verification.json"
output.write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
raise SystemExit(bool(mismatches))
