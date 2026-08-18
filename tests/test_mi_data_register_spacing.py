#!/usr/bin/env python3
"""Regression test for register command spacing in src/mi/data.ts."""

import subprocess
import sys
import tempfile
from pathlib import Path


def test_register_commands_include_space_before_regno_list():
    """Register-number lists must be separated from the preceding token.

    `sendDataListRegisterNames` and `sendDataListRegisterValues` previously
    appended `params.regno.join(' ')` directly, gluing the first register
    number onto `--thread <id>` or the format specifier. This test compiles
    `src/mi/data.ts` standalone and asserts the produced GDB/MI command
    strings.
    """
    repo_root = Path(__file__).resolve().parents[1]
    data_ts = repo_root / "src" / "mi" / "data.ts"

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        src_dir = tmp_path / "src"
        (src_dir / "mi").mkdir(parents=True)
        dist_dir = tmp_path / "dist"

        # Install TypeScript into the temporary directory.
        subprocess.run(
            ["npm", "install", "typescript"],
            cwd=tmp_path,
            check=True,
            capture_output=True,
            text=True,
        )

        # Minimal stubs for the modules imported by data.ts.
        (src_dir / "GDBBackend.ts").write_text(
            "export class GDBBackend {\n"
            "    sendCommand(command: string): Promise<any> {\n"
            "        return Promise.resolve();\n"
            "    }\n"
            "    gdbVersionAtLeast(version: string): boolean {\n"
            "        return true;\n"
            "    }\n"
            "}\n"
        )
        (src_dir / "mi" / "base.ts").write_text(
            "export interface MIResponse { [key: string]: any; }\n"
            "export interface MIRegisterValueInfo { value: string; }\n"
        )

        # Use the data.ts under test.
        (src_dir / "mi" / "data.ts").write_text(data_ts.read_text())

        (tmp_path / "tsconfig.json").write_text(
            "{\n"
            '  "compilerOptions": {\n'
            '    "module": "Node16",\n'
            '    "moduleResolution": "Node16",\n'
            '    "target": "es2015",\n'
            '    "rootDir": "src",\n'
            '    "outDir": "dist",\n'
            '    "strict": true,\n'
            '    "skipLibCheck": true,\n'
            '    "esModuleInterop": true\n'
            "  }\n"
            "}\n"
        )
        tsc = tmp_path / "node_modules" / ".bin" / "tsc"
        subprocess.run(
            [str(tsc), "--project", str(tmp_path / "tsconfig.json")],
            cwd=tmp_path,
            check=True,
            capture_output=True,
            text=True,
        )

        # Run a tiny Node script that records the commands sent by the functions.
        node_script = """
const data = require('./dist/mi/data.js');
const commands = [];
const gdb = {
    sendCommand(command) {
        commands.push(command);
        return Promise.resolve({});
    }
};
data.sendDataListRegisterNames(gdb, { frameId: 0, threadId: 1, regno: [0, 1, 2] });
data.sendDataListRegisterValues(gdb, { frameId: 0, threadId: 1, fmt: 'x', regno: [3, 4] });
console.log(JSON.stringify(commands));
"""
        result = subprocess.run(
            ["node", "-e", node_script],
            cwd=tmp_path,
            check=True,
            capture_output=True,
            text=True,
        )
        commands = __import__("json").loads(result.stdout.strip())

    assert commands == [
        "-data-list-register-names --frame 0 --thread 1 0 1 2",
        "-data-list-register-values --frame 0 --thread 1 x 3 4",
    ], f"Unexpected commands: {commands}"
