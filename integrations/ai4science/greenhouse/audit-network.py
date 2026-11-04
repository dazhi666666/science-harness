"""Record the actual macOS interface of a running profile's model sockets, without inspecting request payloads."""
import argparse
import csv
import datetime
import io
import json
import pathlib
import subprocess
from urllib.parse import urlparse


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=pathlib.Path)
    parser.add_argument('--pid', type=int, help='Native dsh Node process PID; otherwise discover the live clock owner')
    args = parser.parse_args()
    installation = json.loads((args.directory / 'installation.json').read_text())
    policy = installation.get('transportPolicy')
    if not policy:
        parser.error('Profile has no recorded direct transport policy')
    pid = args.pid
    if pid is None:
        owners = subprocess.run(['lsof', '-t', str(args.directory / 'device/clock-owner.sqlite')], capture_output=True, text=True)
        pids = set(owners.stdout.split())
        if len(pids) != 1:
            parser.error('Expected one live clock owner; select the native process with --pid')
        pid = int(pids.pop())
    observed = subprocess.run(['nettop', '-L', '1', '-n', '-m', 'tcp', '-p', str(pid)], capture_output=True, text=True)
    rows = list(csv.reader(io.StringIO(observed.stdout)))
    endpoint = urlparse(policy['origin'])
    target = f"<->{policy['address']}:{endpoint.port or 443}"
    connections = []
    if rows and 'interface' in rows[0]:
        interface_index = rows[0].index('interface')
        state_index = rows[0].index('state')
        for row in rows[1:]:
            if len(row) > max(interface_index, state_index) and row[1].endswith(target):
                connections.append({'socket': row[1], 'interface': row[interface_index], 'state': row[state_index]})
    status = 'inspection-error' if observed.returncode else 'wrong-interface' if any(
        item['interface'] != policy['interface'] for item in connections) else 'verified' if connections else 'no-model-socket'
    captured = datetime.datetime.now(datetime.timezone.utc)
    result = {'scope': 'observed-model-sockets', 'capturedAt': captured.isoformat(), 'pid': pid,
              'transportPolicy': policy, 'status': status, 'connections': connections, 'rawObservation': observed.stdout}
    output = args.directory / f"network-audit-{captured.strftime('%Y%m%dT%H%M%S%f')}.json"
    with output.open('x') as handle:
        handle.write(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'status': status, 'interfaces': sorted({item['interface'] for item in connections}), 'record': str(output)}))
    raise SystemExit(0 if status == 'verified' else 1)


if __name__ == '__main__':
    main()
