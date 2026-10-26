"""Run the CLI film against an owned, disposable LF2 source Runtime.

The CLI owns the subscription/model/tool loop. This launcher only supplies a
normal isolated Gateway and the already-built native tools, then restores them.
It never opens a daily App account or changes installed/runtime configuration.
"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time


def main():
    p = argparse.ArgumentParser(description=__doc__)
    for flag in ('runtime-source', 'engine-dir', 'renderer-helper', 'output', 'state'):
        p.add_argument('--' + flag, type=Path, required=True)
    request = p.add_mutually_exclusive_group(required=True)
    request.add_argument('--prompt-file', type=Path)
    request.add_argument('--resume-run', type=Path)
    p.add_argument('--model')
    args = p.parse_args()
    source = args.runtime_source.resolve(strict=True)
    sys.path.insert(0, str(source))
    from scripts.build_lumenframe2_renderer import check_resources, verify_binary
    check_resources()
    engine = args.engine_dir.resolve(strict=True)
    renderer = args.renderer_helper.resolve(strict=True)
    verify_binary(renderer)
    if not (engine / 'lumeri-engine').is_file():
        raise RuntimeError('A verified frozen media engine is required')
    for directory in (args.output, args.state):
        if not directory.is_absolute() or directory.is_symlink():
            raise ValueError('Output and state must be absolute task directories')
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        if directory.resolve() != directory:
            raise ValueError('Task directories must not traverse links')
    state, output = args.state, args.output
    attached = source / 'native-tools'
    helper = source / 'lumenframe2/native/lumenframe2-renderer'
    if any(x.exists() or x.is_symlink() for x in (attached, helper)):
        raise RuntimeError('Existing Runtime native tool bindings must not be replaced')
    retained = state / 'lumenframe2-renderer'
    if not retained.exists():
        shutil.copyfile(renderer, retained)
        retained.chmod(0o755)
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True, stderr=subprocess.DEVNULL).strip()
    cli_root = Path(__file__).resolve().parent.parent
    cli_revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=cli_root, text=True, stderr=subprocess.DEVNULL).strip()
    for name in ('data', 'runtime', 'logs'):
        (state / name).mkdir(exist_ok=True, mode=0o700)
    ready = state / 'gateway.ready.json'
    command = [sys.executable, '-B', '-m', 'lumeri_runtime.gateway', '--source-root', str(source),
        '--data-root', str(state / 'data'), '--runtime-root', str(state / 'runtime'),
        '--log-root', str(state / 'logs'), '--ready-file', str(ready), '--source-revision', revision,
        '--python-executable', sys.executable, '--isolated-static-account-id', 'account_lf2_cli_trial', '--retire-workers-on-exit']
    gateway = None
    engine.rename(attached)
    try:
        retained.rename(helper)
        with (state / 'gateway.log').open('ab') as log:
            gateway = subprocess.Popen(command, cwd=source, stdout=log, stderr=subprocess.STDOUT,
                start_new_session=True, env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1', 'TMPDIR': str(state)})
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if gateway.poll() is not None:
                raise RuntimeError('Owned Gateway exited; see task gateway.log')
            if ready.exists():
                manifest = json.loads(ready.read_text())
                if manifest.get('pid') == gateway.pid:
                    break
            time.sleep(.1)
        else:
            raise TimeoutError('Owned Gateway did not become ready')
        check_resources()
        cli = ['node', str(cli_root / 'bin/luvi.js'), 'lf2', '--runtime-ready', str(ready),
            '--runtime-source', str(source), '--output', str(output)]
        cli += ['--resume-run', str(args.resume_run.resolve(strict=True))] if args.resume_run else ['--prompt-file', str(args.prompt_file.resolve(strict=True))]
        if args.model:
            cli += ['--model', args.model]
        result = subprocess.run(cli, cwd=cli_root, stdin=subprocess.DEVNULL)
        if result.returncode:
            raise RuntimeError(f'Lumeri CLI film command failed with exit {result.returncode}')
        with (output / 'runtime-run.json').open('x') as handle:
            json.dump({'cli_source_commit': cli_revision, 'runtime_source_commit': revision, 'gateway_pid': gateway.pid,
                'evidence_layer': 'Lumeri CLI explicit trial -> official Codex subscription -> isolated LF2 source Runtime'}, handle, indent=2)
            handle.write('\n')
    finally:
        if gateway is not None and gateway.poll() is None:
            gateway.send_signal(signal.SIGTERM)
            gateway.wait(timeout=30)
        attached.rename(engine)
        if helper.exists():
            helper.rename(retained)
        print('Owned LF2 Runtime stopped; native bindings restored.', flush=True)


if __name__ == '__main__':
    main()
