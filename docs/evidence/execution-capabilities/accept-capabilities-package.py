import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

root, target = Path(sys.argv[1]), sys.argv[2]
source = root / 'dist/capabilities-trial'
package = root / 'dist/browser-extension-capabilities-trial.zip'
if not package.exists():
    with zipfile.ZipFile(package, 'w', zipfile.ZIP_DEFLATED) as archive:
        for file in sorted(source.rglob('*')):
            if file.is_file():
                archive.write(file, file.relative_to(source).as_posix())
checks = {}
with zipfile.ZipFile(root / 'dist/browser-extension-group-fallback-trial.zip') as old:
    old_manifest = json.loads(old.read('manifest.json'))
with zipfile.ZipFile(package) as archive:
    names = archive.namelist()
    manifest = json.loads(archive.read('manifest.json'))
    bg = archive.read('background.js').decode()
    origins = re.findall(r'\bPLATFORM_ORIGIN\s*=\s*("(?:[^"\\]|\\.)*")\s*[,;]', bg)
    checks['integrity'] = archive.testzip() is None
    checks['target_origin_matches'] = len(origins) == 1 and json.loads(origins[0]) == target
    p = urlsplit(target)
    checks['host_permission_matches'] = manifest['host_permissions'] == [f'{p.scheme}://{p.hostname}/*']
    checks['stable_extension_key'] = manifest['key'] == old_manifest['key']
    checks['exact_permissions'] = manifest['permissions'] == ['debugger', 'tabs', 'tabGroups', 'storage', 'downloads', 'cookies', 'scripting']
    checks['optional_permissions'] = manifest['optional_host_permissions'] == ['http://*/*', 'https://*/*']
    checks['production_only'] = all(marker not in bg for marker in ['__bxTest', 'FakeTransport', 'FakeServer']) and 'backend-probe.js' not in names
    checks['real_transport'] = '/browser-extension/' in bg
    checks['cookie_listener_only'] = 'cookies.onChanged' in bg and not re.search(r'cookies\s*\.\s*(get|getAll|set|remove|getAllCookieStores|getPartitionKey)\b', bg)
    checks['no_service_header'] = 'x-service' not in bg.lower()
    checks['injection_and_license_resources'] = all(name in names for name in ['controlbar.js', 'dom-agent.js', 'third_party/playwright/LICENSE', 'third_party/playwright/NOTICE'])
    checks['tested_directory_equals_zip'] = all(archive.read(name) == (source / name).read_bytes() for name in names)
    checks['version_matches_package'] = manifest['version'] == json.loads((root / 'package.json').read_text())['version']
for mode in ['worker', 'event']:
    directory = root / f'dist/capabilities-dom-{mode}'
    m = json.loads((directory / 'manifest.json').read_text())
    checks[f'dom_{mode}_minimal_permissions'] = m['permissions'] == ['tabs', 'storage', 'cookies', 'scripting']
    checks[f'dom_{mode}_production'] = not (directory / 'backend-probe.js').exists() and all(s not in (directory / 'background.js').read_text() for s in ['__bxTest', 'FakeTransport', 'FakeServer'])
    checks[f'dom_{mode}_background'] = m['background'] == ({'service_worker': 'background.js', 'type': 'module'} if mode == 'worker' else {'scripts': ['background.js'], 'type': 'module', 'persistent': False})
output = {'accepted': all(checks.values()), 'checks': checks, 'version': manifest['version'], 'files': len(names), 'bytes': package.stat().st_size, 'sha256': hashlib.sha256(package.read_bytes()).hexdigest()}
print(json.dumps(output, indent=2))
if not output['accepted']:
    raise SystemExit(1)
