# SPDX-License-Identifier: Apache-2.0
"""Plan by default. Explicit --activate installs one new user LaunchAgent."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import re
import tempfile
import shutil
import subprocess

from server import validate_bind

LABEL = "com.projectroom.backup-mcp.v1"


def verify_loaded_job(plist, expected):
    target = "gui/%s/%s" % (os.getuid(), LABEL)
    result = subprocess.run(["/bin/launchctl", "print", target], check=True,
                            capture_output=True, text=True, timeout=5)
    def field(name):
        found = re.findall(r"(?m)^\t" + name + r" = ([^\n]*)$", result.stdout)
        if len(found) != 1:
            raise ValueError("Loaded service identity unavailable")
        return found[0]
    block = re.search(r"(?ms)^\targuments = \{\n(.*?)^\t\}", result.stdout)
    arguments = [line.strip() for line in block[1].splitlines()] if block else []
    if field("path") != str(plist) or field("program") != expected[0] or arguments != expected:
        raise ValueError("Loaded service does not match this dedicated installation")
    return target


def atomic_config(path, content):
    fd, temporary = tempfile.mkstemp(prefix="config-", suffix=".next", dir=str(path.parent))
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as file:
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, str(path))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def retarget_config(base, plist, expected, plan):
    target = verify_loaded_job(plist, expected)
    config = base / "config.json"
    previous = config.read_bytes()
    atomic_config(config, (json.dumps(plan, indent=2) + "\n").encode())
    try:
        subprocess.run(["/bin/launchctl", "kickstart", "-k", target], check=True,
                       capture_output=True, timeout=10)
    except Exception:
        atomic_config(config, previous)
        # Re-check ownership before requesting recovery; never kick an unrelated job.
        try:
            verify_loaded_job(plist, expected)
            subprocess.run(["/bin/launchctl", "kickstart", "-k", target], check=True,
                           capture_output=True, timeout=10)
        except Exception:
            raise RuntimeError("Retarget failed; previous config restored; service recovery unverified") from None
        raise RuntimeError("Retarget failed; previous config restored; recovery requested, readiness unverified") from None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bind", required=True)
    parser.add_argument("--hostname", required=True)
    parser.add_argument("--port", type=int, default=48763)
    parser.add_argument("--checkout", required=True)
    parser.add_argument("--activate", action="store_true")
    parser.add_argument("--retarget", action="store_true", help="Change only this installer's existing bind configuration")
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        raise ValueError("Choose an unprivileged TCP port")
    validate_bind(args.bind, "/usr/local/bin/tailscale")
    checkout = Path(args.checkout).resolve(strict=True)
    subprocess.run(["/usr/bin/git", "-C", str(checkout), "rev-parse", "--git-dir"],
                   check=True, capture_output=True)
    home = Path.home()
    base = home / "Library/Application Support/ProjectRoomBackchannel-v1"
    plist = home / "Library/LaunchAgents" / (LABEL + ".plist")
    if (base.exists() or plist.exists()) and not args.retarget:
        raise ValueError("Refusing to overwrite an existing installation or service")
    plan = {"bind": args.bind, "hostname": args.hostname.rstrip("."), "port": args.port,
            "checkout": str(checkout), "database": str(base / "state/backchannel.sqlite"),
            "tailscale": "/usr/local/bin/tailscale"}
    if args.retarget:
        with plist.open("rb") as file:
            installed = plistlib.load(file)
        expected = ["/usr/bin/python3", str(base / "server.py"), "--config", str(base / "config.json")]
        current = json.loads((base / "config.json").read_text())
        if installed.get("Label") != LABEL or installed.get("ProgramArguments") != expected or current.get("database") != plan["database"] or current.get("checkout") != plan["checkout"]:
            raise ValueError("Existing service does not match this dedicated installation")
        verify_loaded_job(plist, expected)
    if not args.activate:
        print(json.dumps({"activated": False, "endpoint": "http://%s:%s/mcp" % (args.hostname.rstrip("."), args.port),
                          "bind": args.bind, "label": LABEL, "availability": "after user login and Keychain unlock",
                          "credentials": "dedicated login-Keychain item; no value in configuration",
                          "limits": {"concurrentConnections": 8, "idleSeconds": 5,
                                     "headerReceiveSeconds": 3, "requestBudgetSeconds": 15, "bodyBytes": 65536, "readPageMaximum": 100}}, indent=2))
        return
    if args.retarget:
        retarget_config(base, plist, expected, plan)
        print("Dedicated bind configuration updated; verify authenticated smoke before announcing readiness.")
        return
    # This explicit activation boundary is intentionally separate from planning.
    from keychain import ensure
    ensure()
    os.umask(0o077)
    base.mkdir(mode=0o700)
    (base / "state").mkdir(mode=0o700)
    source = Path(__file__).resolve().parent
    for name in ["server.py", "keychain.py"]:
        shutil.copyfile(str(source / name), str(base / name))
        (base / name).chmod(0o600)
    config = base / "config.json"
    config.write_text(json.dumps(plan, indent=2) + "\n")
    agent = {"Label": LABEL, "ProgramArguments": ["/usr/bin/python3", str(base / "server.py"), "--config", str(config)],
             "RunAtLoad": True, "KeepAlive": True, "ThrottleInterval": 30,
             "ProcessType": "Background", "WorkingDirectory": str(base),
             "StandardOutPath": str(base / "state/service.stdout.log"),
             "StandardErrorPath": str(base / "state/service.stderr.log"), "Umask": 63}
    plist.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with plist.open("xb") as file:
        plistlib.dump(agent, file)
    plist.chmod(0o600)
    subprocess.run(["/bin/launchctl", "bootstrap", "gui/%s" % os.getuid(), str(plist)], check=True)
    print("Private backup MCP LaunchAgent installed. Verify authenticated smoke before announcing readiness.")


if __name__ == "__main__":
    main()
