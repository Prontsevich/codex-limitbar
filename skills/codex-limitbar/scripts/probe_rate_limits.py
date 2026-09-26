#!/usr/bin/env python3
"""Probe the Codex app-server rate-limits protocol (stdio JSON-RPC).

Answers "is the local Codex CLI serving rate limits at all?" in seconds,
independent of any app that consumes it (e.g. a menu-bar limits widget).

Usage:
    python3 probe_rate_limits.py [codex-executable]

Exits 0 and prints the raw JSON-LRPC responses on success (look for
"id":2 response with rateLimits.primary.usedPercent).
Exits non-zero with a diagnostic on failure.
"""
import json
import select
import subprocess
import sys
import time

CODEX_BIN = sys.argv[1] if len(sys.argv) > 1 else "codex"


def main() -> int:
    proc = subprocess.Popen(
        [CODEX_BIN, "app-server", "--listen", "stdio://"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )

    def send(payload: dict) -> None:
        proc.stdin.write(json.dumps(payload) + "\n")
        proc.stdin.flush()

    def read_line(timeout: float = 10) -> str | None:
        r, _, _ = select.select([proc.stdout], [], [], timeout)
        if not r:
            return None
        line = proc.stdout.readline().strip()
        return line if line else None

    try:
        # 1. initialize handshake (LSP-style, id 1)
        send(
            {
                "method": "initialize",
                "id": 1,
                "params": {
                    "clientInfo": {"name": "probe", "title": "Rate Limit Probe", "version": "0.1"}
                },
            }
        )
        line = read_line(5)
        if line is None:
            print("FAILED: no initialize response (server hung or binary missing)")
            return 1
        print(f">>> {line}")
        if '"id":1' not in line and '"id": 1' not in line:
            print("FAIL: initialize response did not carry id 1")
            return 1

        # 2. initialized notification (no id)
        send({"method": "initialized", "params": {}})

        # 3. rate-limits read (id 2)
        time.sleep(0.5)  # let the server settle; drains nothing, just avoids races
        send({"method": "account/rateLimits/read", "id": 2})

        # 4. consume output until the id-2 response (notifications may interleave)
        deadline = time.time() + 15
        found = False
        while time.time() < deadline:
            line = read_line(2)
            if line is None:
                continue
            print(f">>> {line}")
            if '"id":2' in line or '"id": 2' in line:
                if '"error"' in line:
                    print("FAIL: rateLimits request returned an error")
                    return 1
                found = True
                break

        if not found:
            print("FAIL: no account/rateLimits/read response within 15s "
                  "(protocol changed, method renamed, or auth unavailable)")
            return 1
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
