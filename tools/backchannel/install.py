# SPDX-License-Identifier: Apache-2.0
"""Plan by default. Explicit --activate installs one new user LaunchAgent."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess

from server import validate_bind

LABEL = "com.projectroom.backup-mcp.v1"


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
    if not args.activate:
        print(json.dumps({"activated": False, "endpoint": "http://%s:%s/mcp" % (args.hostname.rstrip("."), args.port),
                          "bind": args.bind, "label": LABEL, "availability": "after user login and Keychain unlock",
                          "credentials": "dedicated login-Keychain item; no value in configuration",
                          "limits": {"concurrentConnections": 8, "idleSeconds": 5,
                                     "requestLifetimeSeconds": 15, "bodyBytes": 65536, "readPageMaximum": 100}}, indent=2))
        return
    if args.retarget:
        temporary = base / "config.next.json"
        descriptor = os.open(str(temporary), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, "w") as file:
            file.write(json.dumps(plan, indent=2) + "\n")
            file.flush(); os.fsync(file.fileno())
        os.replace(str(temporary), str(base / "config.json"))
        subprocess.run(["/bin/launchctl", "kickstart", "-k", "gui/%s/%s" % (os.getuid(), LABEL)], check=True)
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
