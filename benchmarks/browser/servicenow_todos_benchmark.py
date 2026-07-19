#!/usr/bin/env python3
"""ServiceNow TODO benchmark verifier.

Follows the same contract as linkedin_profile_benchmark.py so the bench runner can treat both as
command verifiers:

  capture-baseline  Snapshot current matching records (required before reset can restore them).
  verify            Compare live records against the scenario's expected end-state.
  reset --yes       Restore baselined fields and delete records created since the baseline.

Exit codes: 0 = all expectations met, 1 = mismatch, 2 = configuration/connection problem.
Report JSON: {"scenario", "passed", "fields": [{"section", "field", "expected", "actual", "passed"}]}

Ground truth comes from the ServiceNow REST Table API (stdlib urllib, basic auth) — no Playwright,
no DOM scraping. The agent under test drives the UI; this tool only reads/writes records.

Local config (git-ignored *.scenario.local.json):
  {
    "instance_url": "https://devNNNNN.service-now.com",
    "username": "admin",
    "password": "…",
    "table": "task",            // optional, default "task"
    "prefix": "BENCH-"          // optional, default "BENCH-": short_description prefix owned by the benchmark
  }

Expected end-state (committed expected.json): a list of
  {"short_description": "BENCH-…", "fields": {"state": "3", "priority": "2", …}, "must_exist": true}
Records are matched by exact short_description; "absent": true asserts the record must NOT exist.
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUTPUT = REPO_ROOT / "output" / "servicenow-benchmark"
DEFAULT_BASELINE = DEFAULT_OUTPUT / "baseline.json"
DEFAULT_REPORT = DEFAULT_OUTPUT / "result.json"


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


class Instance:
    def __init__(self, config: Dict[str, Any]) -> None:
        for key in ("instance_url", "username", "password"):
            if not config.get(key):
                raise SystemExit2(f"local config is missing '{key}'")
        self.base = str(config["instance_url"]).rstrip("/")
        self.table = str(config.get("table", "task"))
        self.prefix = str(config.get("prefix", "BENCH-"))
        token = base64.b64encode(f"{config['username']}:{config['password']}".encode("utf-8")).decode("ascii")
        self.auth_header = f"Basic {token}"

    def request(self, method: str, path: str, body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        url = f"{self.base}{path}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(url, data=data, method=method)
        request.add_header("Authorization", self.auth_header)
        request.add_header("Accept", "application/json")
        if data is not None:
            request.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = response.read().decode("utf-8")
                return json.loads(payload) if payload else {}
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")[:300]
            raise SystemExit2(f"{method} {path} failed ({error.code}): {detail}") from error
        except urllib.error.URLError as error:
            raise SystemExit2(f"{method} {path} failed: {error.reason}") from error

    def matching_records(self, fields: List[str]) -> List[Dict[str, Any]]:
        query = urllib.parse.quote(f"short_descriptionSTARTSWITH{self.prefix}")
        wanted = ",".join(sorted(set(fields + ["sys_id", "short_description"])))
        path = f"/api/now/table/{self.table}?sysparm_query={query}&sysparm_fields={wanted}&sysparm_display_value=false&sysparm_limit=200"
        return self.request("GET", path).get("result", [])


class SystemExit2(RuntimeError):
    """Configuration/connection problem — maps to exit code 2 (broken setup, not a failed benchmark)."""


def expected_fields(expected: List[Dict[str, Any]]) -> List[str]:
    names: List[str] = []
    for record in expected:
        names.extend(record.get("fields", {}).keys())
    return names


def command_capture_baseline(instance: Instance, expected: List[Dict[str, Any]], baseline_path: Path) -> int:
    records = instance.matching_records(expected_fields(expected))
    baseline_path.parent.mkdir(parents=True, exist_ok=True)
    baseline = {
        "instance_url": instance.base,
        "table": instance.table,
        "prefix": instance.prefix,
        "records": records,
    }
    baseline_path.write_text(json.dumps(baseline, indent=2) + "\n", encoding="utf-8")
    print(f"baseline: captured {len(records)} record(s) to {baseline_path}")
    return 0


def command_verify(instance: Instance, expected: List[Dict[str, Any]], scenario_name: str, report_path: Path) -> int:
    live = {record.get("short_description"): record for record in instance.matching_records(expected_fields(expected))}
    results: List[Dict[str, Any]] = []
    for expectation in expected:
        name = expectation["short_description"]
        record = live.get(name)
        if expectation.get("absent"):
            results.append(
                {"section": name, "field": "(absent)", "expected": "absent", "actual": "absent" if record is None else "present", "passed": record is None}
            )
            continue
        if record is None:
            results.append({"section": name, "field": "(exists)", "expected": "present", "actual": "absent", "passed": False})
            continue
        results.append({"section": name, "field": "(exists)", "expected": "present", "actual": "present", "passed": True})
        for field, expected_value in expectation.get("fields", {}).items():
            actual_value = record.get(field)
            # The Table API returns reference fields as {value, link}; compare on the raw value.
            if isinstance(actual_value, dict):
                actual_value = actual_value.get("value")
            passed = str(actual_value) == str(expected_value)
            results.append({"section": name, "field": field, "expected": expected_value, "actual": actual_value, "passed": passed})

    passed = all(entry["passed"] for entry in results)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps({"scenario": scenario_name, "passed": passed, "fields": results}, indent=2) + "\n", encoding="utf-8")
    for entry in results:
        marker = "ok " if entry["passed"] else "FAIL"
        print(f"{marker} {entry['section']} :: {entry['field']} expected={entry['expected']!r} actual={entry['actual']!r}")
    print(f"report: {report_path}")
    return 0 if passed else 1


def command_reset(instance: Instance, expected: List[Dict[str, Any]], baseline_path: Path, confirmed: bool) -> int:
    if not confirmed:
        raise SystemExit2("reset requires --yes")
    if not baseline_path.exists():
        raise SystemExit2(f"no baseline at {baseline_path}; run capture-baseline first")
    baseline = load_json(baseline_path)
    if baseline.get("instance_url") != instance.base or baseline.get("table") != instance.table:
        raise SystemExit2("baseline instance/table does not match the local config; refusing to reset")

    baselined = {record["sys_id"]: record for record in baseline.get("records", [])}
    live = instance.matching_records(expected_fields(expected))
    restored = deleted = 0
    for record in live:
        sys_id = record["sys_id"]
        if sys_id in baselined:
            fields = {
                key: value
                for key, value in baselined[sys_id].items()
                if key not in ("sys_id",) and not isinstance(value, dict) and value != record.get(key)
            }
            if fields:
                instance.request("PATCH", f"/api/now/table/{instance.table}/{sys_id}", fields)
                restored += 1
        else:
            instance.request("DELETE", f"/api/now/table/{instance.table}/{sys_id}")
            deleted += 1
    print(f"reset: restored {restored} record(s), deleted {deleted} benchmark-created record(s)")
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=("capture-baseline", "verify", "reset"))
    parser.add_argument("--config", type=Path, required=True, help="Git-ignored *.scenario.local.json with instance credentials")
    parser.add_argument("--expected", type=Path, required=True, help="Committed expected.json describing the end-state")
    parser.add_argument("--baseline", type=Path, default=DEFAULT_BASELINE)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--scenario-name", default="servicenow-todos")
    parser.add_argument("--yes", action="store_true", help="Required confirmation for reset")
    args = parser.parse_args(argv)

    try:
        instance = Instance(load_json(args.config))
        expected = load_json(args.expected)
        if not isinstance(expected, list):
            raise SystemExit2("expected.json must be a list of record expectations")
        if args.command == "capture-baseline":
            return command_capture_baseline(instance, expected, args.baseline)
        if args.command == "verify":
            return command_verify(instance, expected, args.scenario_name, args.report)
        return command_reset(instance, expected, args.baseline, args.yes)
    except SystemExit2 as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    except (OSError, json.JSONDecodeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
