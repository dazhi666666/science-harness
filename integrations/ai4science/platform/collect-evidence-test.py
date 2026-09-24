"""Regression for artifact upload recursing through pnpm's linked dependency graph."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('collect_evidence', Path(__file__).with_name('collect-evidence.py'))
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class EvidenceTest(unittest.TestCase):
    def test_cyclic_dependencies_and_external_links_are_not_uploaded(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'check'
            dependencies = source / 'home/profiles/node_modules/package'
            dependencies.mkdir(parents=True)
            (dependencies / 'node_modules').symlink_to(dependencies.parent, target_is_directory=True)
            (source / 'results.json').write_text('{"success":true}\n')
            (source / 'device.sqlite').write_bytes(b'device journal')
            (source / '.hidden.log').write_text('diagnostic\n')
            external = root / 'private'
            external.mkdir()
            (external / 'private.txt').write_text('must not be traversed')
            (source / 'outside').symlink_to(external, target_is_directory=True)
            (source / 'linked.log').symlink_to(external / 'private.txt')
            output = root / 'upload'
            manifest = collector.collect([source], output)
            self.assertEqual({item['path'] for item in manifest['files']},
                             {'check/results.json', 'check/device.sqlite', 'check/.hidden.log'})
            self.assertEqual((output / 'check/device.sqlite').read_bytes(), b'device journal')
            self.assertEqual(json.loads((output / 'check/results.json').read_text()), {'success': True})
            self.assertIn('check/home/profiles/node_modules', manifest['skipped'])
            self.assertFalse(any(path.is_symlink() for path in output.rglob('*')))
            self.assertFalse(any(path.name == 'node_modules' for path in output.rglob('*')))

    def test_missing_early_failure_roots_keep_partial_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'check'
            source.mkdir()
            (source / '01.log').write_text('failed setup\n')
            manifest = collector.collect([source, root / 'experiment-check'], root / 'upload')
            self.assertEqual(manifest['missingRoots'], ['experiment-check'])
            self.assertEqual(len(manifest['files']), 1)

    def test_refuses_recursive_output_and_overwriting_previous_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'check'
            source.mkdir()
            with self.assertRaises(ValueError):
                collector.collect([source], source / 'upload')
            collector.collect([source], root / 'upload')
            with self.assertRaises(FileExistsError):
                collector.collect([source], root / 'upload')


if __name__ == '__main__':
    unittest.main()
