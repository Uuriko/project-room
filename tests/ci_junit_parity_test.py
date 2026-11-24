import importlib.util
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from xml.etree import ElementTree as ET


source = Path(__file__).resolve().parents[1] / "scripts" / "ci-junit-parity.py"
spec = importlib.util.spec_from_file_location("ci_junit_parity", source)
parity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(parity)


class LooseJUnitCases(unittest.TestCase):
    def test_mixed_node_report_keeps_direct_nested_and_named_cases(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "source.xml"
            path.write_text("""<testsuites tests="3" failures="1">
              <testcase name="loose" file="one.test.js"><failure/></testcase>
              <testsuite name="group"><testcase name="named"/></testsuite>
              <testsuites name="combined"><testcase name="nested"><skipped/></testcase></testsuites>
            </testsuites>""", encoding="utf-8")
            target = root / "out.xml"
            parity.normalize_report(path, target)
            tree = ET.parse(target)
            self.assertEqual(tree.getroot().get("tests"), "3")
            self.assertEqual(tree.getroot().get("failures"), "1")
            self.assertEqual(
                {case.get("name") for suite in tree.iter("testsuite") for case in suite.findall("testcase")},
                {"loose", "named", "nested"},
            )
            self.assertIsNotNone(tree.find(".//testcase[@name='loose']/failure"))
            self.assertIsNotNone(tree.find(".//testcase[@name='nested']/skipped"))
            self.assertEqual(tree.find(".//testcase[@name='loose']").get("file"), "one.test.js")


if __name__ == "__main__":
    unittest.main()
