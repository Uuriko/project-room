#!/usr/bin/env python3
"""Compare JUnit evidence with Joggernaut, including direct Node testcases."""
import argparse
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
from xml.etree import ElementTree as ET


def local_name(tag):
    return tag.rsplit("}", 1)[-1]


def normalize_report(source, destination):
    tree = ET.parse(source)
    root = tree.getroot()
    if local_name(root.tag) not in {"testsuites", "testsuite"}:
        raise ValueError(f"Expected a JUnit report: {source}")
    for container in list(root.iter()):
        if local_name(container.tag) != "testsuites":
            continue
        direct = [element for element in container if local_name(element.tag) == "testcase"]
        if not direct:
            continue
        # Joggernaut walks testsuites by selecting testsuite descendants. Node
        # also writes loose testcases directly under a testsuites container.
        # Preserve container totals and report path. Give loose rows a stable
        # separate suite identity, so they cannot merge into a real suite.
        prefix = container.tag[:container.tag.rfind("}") + 1]
        name = "[Room normalized direct JUnit cases]"
        if any(local_name(child.tag) == "testsuite" and child.get("name") == name
               for child in container):
            raise ValueError(f"Reserved JUnit normalization suite name in {source}")
        suite = ET.SubElement(container, prefix + "testsuite", {"name": name})
        for element in direct:
            container.remove(element)
            suite.append(element)
    destination.parent.mkdir(parents=True, exist_ok=True)
    tree.write(destination, encoding="utf-8", xml_declaration=True)


def normalize(source, directory):
    if source.is_file():
        target = directory / source.name
        normalize_report(source, target)
        return target
    if not source.is_dir():
        raise ValueError(f"Expected a JUnit file or directory: {source}")
    for file in sorted(source.rglob("*.xml")):
        normalize_report(file, directory / file.relative_to(source))
    return directory


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--measure", type=Path, required=True, help="Pinned Joggernaut measure.py checkout")
    parser.add_argument("--before", type=Path, required=True)
    parser.add_argument("--after", type=Path, required=True)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    with TemporaryDirectory(prefix="room-ci-junit-") as temp:
        root = Path(temp)
        command = [sys.executable, str(args.measure.resolve()), "tests",
                   "--before", str(normalize(args.before, root / "before")),
                   "--after", str(normalize(args.after, root / "after"))]
        if args.json:
            command.append("--json")
        return subprocess.run(command, check=False).returncode


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ET.ParseError, ValueError) as error:
        print(error, file=sys.stderr)
        raise SystemExit(2) from error
