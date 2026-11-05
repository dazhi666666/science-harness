"""Measure native summary crossings using assigned work, actual closures and authenticated owner inputs."""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from observations import incoming, arguments


def observe_continuity(native, board, state, verified_measurements, mail):
    active = {delivery['taskId']: delivery for delivery in state['deliveries'] if delivery['valid']}
    episodes = []
    for role, rows in native.items():
        calls = {event['data']['callId']: event for event in rows if event.get('type') == 'tool/call'}
        results = {}
        for event in rows:
            if event.get('type') != 'tool/result' or event['data']['message'].get('isError'):
                continue
            message = event['data']['message']
            text = ''.join(block['text'] for block in message['content'] if block['type'] == 'text')
            try:
                results[message['toolCallId']] = (event, json.loads(text))
            except ValueError:
                continue
        for start in (event for event in rows if event.get('type') == 'compaction/start'):
            cid = start['data']['compactionId']
            related = [event for event in rows if event.get('type', '').startswith('compaction/') and event['data'].get('compactionId') == cid]
            summary = next((event for event in related if event['type'] == 'compaction/summary'), None)
            end = next((event for event in related if event['type'] == 'compaction/end'), None)
            episode = {'role': role, 'compactionId': cid, 'startSeq': start['seq'], 'summarySeq': summary['seq'] if summary else None,
                       'endSeq': end['seq'] if end else None, 'summarySucceeded': bool(summary and end and 'error' not in end['data']), 'pendingTasks': []}
            for task in (task for task in board['tasks'] if task['assignee'] == role):
                activations = []
                for message in mail:
                    if message['to'] != role:
                        continue
                    event = incoming(rows, message, 'laboratory-mail')
                    if not event:
                        continue
                    if message.get('task_id') == task['id'] and message['from'] == task['created_by'] and message['content'].startswith('Assignment '):
                        activations.append(event['seq'])
                    if message['from'] == 'environment':
                        try:
                            notice = json.loads(message['content'])
                        except ValueError:
                            continue
                        if isinstance(notice, dict) and any(item.get('kind') == 'deliveries-withdrawn' and task['title'] in item.get('payload', {}).get('taskIds', []) for item in notice.get('events', [])):
                            activations.append(event['seq'])
                if task['created_by'] == role:
                    for call_id, (event, value) in results.items():
                        if calls.get(call_id, {}).get('data', {}).get('name') == 'lab_assign' and isinstance(value, dict) and value.get('task', {}).get('id') == task['id']:
                            activations.append(event['seq'])
                activated = max((seq for seq in activations if seq < start['seq']), default=None)
                if activated is None:
                    continue
                closures = [(call, results[id]) for id, call in calls.items() if call['data']['name'] == 'lab_complete'
                            and (arguments(call) or {}).get('task_id') == task['id'] and id in results]
                if any(activated < event['seq'] < start['seq'] for _, (event, _) in closures):
                    continue
                delivery = active.get(task['title'])
                post = [(call, event, value) for call, (event, value) in closures if end and call['seq'] > end['seq'] and
                        isinstance(value, dict) and value.get('delivery') == delivery and delivery is not None]
                owner_receipts = []
                for message in mail:
                    if message.get('task_id') != task['id'] or message['from'] != role or message['to'] != task['created_by']:
                        continue
                    try:
                        content = json.loads(message['content'])
                    except ValueError:
                        continue
                    if not isinstance(content, dict) or content.get('kind') != 'laboratory-delivery' or content.get('delivery') != delivery:
                        continue
                    owner = native.get(task['created_by'], [])
                    received = incoming(owner, message, 'laboratory-mail')
                    response = next((event for event in owner if received and event.get('seq', -1) > received['seq'] and
                                     event.get('type') == 'assistant/message' and not event['data'].get('interrupted')), None)
                    if received and response:
                        owner_receipts.append({'messageId': message['id'], 'inputSeq': received['seq'], 'responseSeq': response['seq']})
                references = (delivery.get('resultIds', []) + delivery.get('referenceResultIds', [])) if delivery else []
                checks = {'successfulSummary': episode['summarySucceeded'], 'nativeClosureAfterSummary': bool(post),
                          'currentDeliveryReferencesVerified': bool(references) and all(id in verified_measurements for id in references),
                          'ownerResponseOrSelfDelivery': task['created_by'] == role or bool(owner_receipts)}
                episode['pendingTasks'].append({'routerTaskId': task['id'], 'experimentTaskId': task['title'], 'activationSeq': activated,
                    'closureCallSeqs': [call['seq'] for call, _, _ in post], 'ownerReceipts': owner_receipts,
                    'checks': checks, 'verifiedContinuity': all(checks.values())})
            episodes.append(episode)
    return {'pendingTaskOpportunities': sum(len(episode['pendingTasks']) for episode in episodes),
            'verifiedPendingTaskClosures': sum(task['verifiedContinuity'] for episode in episodes for task in episode['pendingTasks']),
            'informationLoss': 'not-assessed', 'events': episodes}
