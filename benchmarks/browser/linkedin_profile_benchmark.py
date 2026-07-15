#!/usr/bin/env python3
"""Verify and restore a LinkedIn test profile with Playwright.

The harness is scenario-driven so LinkedIn locator changes and additional profile
sections can be handled without putting account data or credentials in source code.
Run ``python linkedin_profile_benchmark.py --help`` for the workflow.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional

try:
    from playwright.sync_api import Locator, Page, TimeoutError as PlaywrightTimeoutError, sync_playwright
except ImportError:  # pragma: no cover - exercised before browser startup
    Locator = Any  # type: ignore
    Page = Any  # type: ignore
    PlaywrightTimeoutError = RuntimeError  # type: ignore
    sync_playwright = None


DEFAULT_OUTPUT = Path("output/playwright/linkedin-benchmark")
DEFAULT_BASELINE = DEFAULT_OUTPUT / "baseline.json"
DEFAULT_REPORT = DEFAULT_OUTPUT / "result.json"
DEFAULT_PROFILE = DEFAULT_OUTPUT / "browser-profile"


class HarnessError(RuntimeError):
    """A benchmark configuration or browser interaction failed."""


@dataclass(frozen=True)
class FieldResult:
    section: str
    field: str
    expected: Any
    actual: Any
    passed: bool


def read_json(path: Path) -> Dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise HarnessError(f"File not found: {path}") from error
    except json.JSONDecodeError as error:
        raise HarnessError(f"Invalid JSON in {path}: {error}") from error
    if not isinstance(value, dict):
        raise HarnessError(f"Expected a JSON object in {path}")
    return value


def write_private_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass


def normalize(value: Any, mode: str = "whitespace") -> Any:
    if not isinstance(value, str):
        return value
    if mode == "exact":
        return value
    if mode == "casefold":
        return " ".join(value.split()).casefold()
    if mode == "whitespace":
        return " ".join(value.split())
    raise HarnessError(f"Unknown normalization mode: {mode}")


def locate(page: Page, spec: Mapping[str, Any]) -> Locator:
    if "css" in spec:
        return page.locator(str(spec["css"]))
    if "label" in spec:
        return page.get_by_label(str(spec["label"]), exact=bool(spec.get("exact", False)))
    if "placeholder" in spec:
        return page.get_by_placeholder(str(spec["placeholder"]), exact=bool(spec.get("exact", False)))
    if "test_id" in spec:
        return page.get_by_test_id(str(spec["test_id"]))
    if "role" in spec and "name" in spec:
        name: Any = str(spec["name"])
        if spec.get("name_regex"):
            name = re.compile(name, re.IGNORECASE if spec.get("ignore_case", True) else 0)
        return page.get_by_role(str(spec["role"]), name=name, exact=bool(spec.get("exact", False)))
    raise HarnessError(f"Locator must define css, label, placeholder, test_id, or role/name: {spec}")


def one(page: Page, spec: Mapping[str, Any], description: str, timeout_ms: int) -> Locator:
    locator = locate(page, spec)
    try:
        locator.first.wait_for(state="visible", timeout=timeout_ms)
    except PlaywrightTimeoutError as error:
        raise HarnessError(f"Could not find visible {description} using locator {dict(spec)}") from error
    return locator.first


def field_value(locator: Locator, kind: str) -> Any:
    if kind in ("input", "textarea", "select"):
        return locator.input_value()
    if kind == "checkbox":
        return locator.is_checked()
    if kind == "text":
        return locator.inner_text()
    raise HarnessError(f"Unsupported field kind: {kind}")


def set_field_value(locator: Locator, kind: str, value: Any) -> None:
    if kind in ("input", "textarea"):
        locator.fill("" if value is None else str(value))
        return
    if kind == "select":
        locator.select_option(value="" if value is None else str(value))
        return
    if kind == "checkbox":
        locator.set_checked(bool(value))
        return
    if kind == "text":
        raise HarnessError("Text-only fields can be verified but cannot be reset")
    raise HarnessError(f"Unsupported field kind: {kind}")


def sections(scenario: Mapping[str, Any]) -> Iterable[Mapping[str, Any]]:
    configured = scenario.get("sections")
    if not isinstance(configured, list) or not configured:
        raise HarnessError("Scenario must contain a non-empty sections array")
    for section in configured:
        if not isinstance(section, dict) or not isinstance(section.get("fields"), list):
            raise HarnessError("Every section must be an object with a fields array")
        yield section


def dismiss_dialog(page: Page, section: Mapping[str, Any], timeout_ms: int) -> None:
    close_spec = section.get("close")
    if isinstance(close_spec, dict):
        one(page, close_spec, f"{section.get('name')} close button", timeout_ms).click()
    else:
        page.keyboard.press("Escape")
    page.wait_for_timeout(250)


def read_profile(page: Page, scenario: Mapping[str, Any], timeout_ms: int) -> Dict[str, Dict[str, Any]]:
    captured: Dict[str, Dict[str, Any]] = {}
    for section in sections(scenario):
        section_name = str(section.get("name", "unnamed"))
        opener = section.get("opener")
        if not isinstance(opener, dict):
            raise HarnessError(f"Section {section_name} has no opener locator")
        one(page, opener, f"{section_name} edit button", timeout_ms).click()
        values: Dict[str, Any] = {}
        for field in section["fields"]:
            if not isinstance(field, dict) or "name" not in field or not isinstance(field.get("locator"), dict):
                raise HarnessError(f"Invalid field in section {section_name}: {field}")
            field_name = str(field["name"])
            control = one(page, field["locator"], f"{section_name}.{field_name}", timeout_ms)
            values[field_name] = field_value(control, str(field.get("kind", "input")))
        captured[section_name] = values
        dismiss_dialog(page, section, timeout_ms)
    return captured


def compare_profile(actual: Mapping[str, Mapping[str, Any]], scenario: Mapping[str, Any]) -> List[FieldResult]:
    results: List[FieldResult] = []
    for section in sections(scenario):
        section_name = str(section.get("name", "unnamed"))
        for field in section["fields"]:
            if "expected" not in field:
                continue
            field_name = str(field["name"])
            expected = field["expected"]
            observed = actual.get(section_name, {}).get(field_name)
            mode = str(field.get("normalize", "whitespace"))
            results.append(
                FieldResult(
                    section=section_name,
                    field=field_name,
                    expected=expected,
                    actual=observed,
                    passed=normalize(expected, mode) == normalize(observed, mode),
                )
            )
    if not results:
        raise HarnessError("Scenario has no fields with expected values")
    return results


def restore_profile(
    page: Page,
    scenario: Mapping[str, Any],
    baseline: Mapping[str, Mapping[str, Any]],
    timeout_ms: int,
) -> None:
    for section in sections(scenario):
        section_name = str(section.get("name", "unnamed"))
        original = baseline.get(section_name)
        if not isinstance(original, dict):
            raise HarnessError(f"Baseline has no values for section {section_name}")
        opener = section.get("opener")
        save = section.get("save")
        if not isinstance(opener, dict) or not isinstance(save, dict):
            raise HarnessError(f"Section {section_name} needs opener and save locators for reset")
        one(page, opener, f"{section_name} edit button", timeout_ms).click()
        for field in section["fields"]:
            field_name = str(field["name"])
            if field_name not in original:
                raise HarnessError(f"Baseline has no value for {section_name}.{field_name}")
            control = one(page, field["locator"], f"{section_name}.{field_name}", timeout_ms)
            set_field_value(control, str(field.get("kind", "input")), original[field_name])
        one(page, save, f"{section_name} save button", timeout_ms).click()
        page.wait_for_timeout(int(section.get("after_save_wait_ms", 1500)))


def ensure_authenticated(page: Page, profile_url: str, timeout_ms: int) -> None:
    page.goto(profile_url, wait_until="domcontentloaded", timeout=timeout_ms)
    if "linkedin.com/login" not in page.url and "linkedin.com/checkpoint" not in page.url:
        return
    print("LinkedIn sign-in or verification is required in the browser window.", file=sys.stderr)
    deadline = time.monotonic() + timeout_ms / 1000
    while time.monotonic() < deadline:
        if "linkedin.com/login" not in page.url and "linkedin.com/checkpoint" not in page.url:
            page.goto(profile_url, wait_until="domcontentloaded", timeout=timeout_ms)
            return
        page.wait_for_timeout(500)
    raise HarnessError("Timed out waiting for LinkedIn sign-in")


def canonical_profile_url(url: str) -> str:
    return url.split("?", 1)[0].split("#", 1)[0].rstrip("/") + "/"


def run_browser(args: argparse.Namespace, scenario: Mapping[str, Any]) -> int:
    if sync_playwright is None:
        raise HarnessError(
            "Python Playwright is not installed. Run: "
            "python3 -m pip install -r benchmarks/browser/requirements.txt && "
            "python3 -m playwright install chromium"
        )
    profile_url = str(scenario.get("profile_url", "https://www.linkedin.com/in/me/"))
    args.user_data_dir.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            str(args.user_data_dir),
            headless=args.headless,
            viewport={"width": 1440, "height": 1000},
        )
        try:
            page = context.pages[0] if context.pages else context.new_page()
            ensure_authenticated(page, profile_url, args.auth_timeout_ms)
            page.wait_for_timeout(args.settle_ms)
            if args.command == "capture-baseline":
                actual = read_profile(page, scenario, args.timeout_ms)
                write_private_json(
                    args.baseline,
                    {
                        "scenario": scenario.get("name"),
                        "profile_url": profile_url,
                        "resolved_profile_url": canonical_profile_url(page.url),
                        "values": actual,
                    },
                )
                print(f"Captured baseline in {args.baseline}")
                return 0
            if args.command == "verify":
                actual = read_profile(page, scenario, args.timeout_ms)
                results = compare_profile(actual, scenario)
                report = {
                    "scenario": scenario.get("name"),
                    "passed": all(result.passed for result in results),
                    "fields": [result.__dict__ for result in results],
                }
                write_private_json(args.report, report)
                for result in results:
                    marker = "PASS" if result.passed else "FAIL"
                    print(f"[{marker}] {result.section}.{result.field}: {result.actual!r}")
                print(f"Report: {args.report}")
                return 0 if report["passed"] else 1
            baseline_file = read_json(args.baseline)
            if baseline_file.get("scenario") != scenario.get("name"):
                raise HarnessError("Baseline scenario does not match the selected scenario")
            baseline_profile_url = baseline_file.get("resolved_profile_url")
            if baseline_profile_url and canonical_profile_url(page.url) != baseline_profile_url:
                raise HarnessError(
                    "The signed-in LinkedIn profile does not match the profile that produced the baseline"
                )
            baseline = baseline_file.get("values")
            if not isinstance(baseline, dict):
                raise HarnessError(f"Baseline file has no values object: {args.baseline}")
            restore_profile(page, scenario, baseline, args.timeout_ms)
            restored = read_profile(page, scenario, args.timeout_ms)
            if restored != baseline:
                raise HarnessError("Reset completed, but the profile does not match the captured baseline")
            print("Profile reset and verified against the captured baseline")
            return 0
        finally:
            context.close()


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("command", choices=("capture-baseline", "verify", "reset"))
    result.add_argument("--scenario", type=Path, required=True, help="Scenario JSON containing expected values and locators")
    result.add_argument("--baseline", type=Path, default=DEFAULT_BASELINE)
    result.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    result.add_argument("--user-data-dir", type=Path, default=DEFAULT_PROFILE, help="Persistent test-account browser session")
    result.add_argument("--headless", action="store_true", help="Requires an already-authenticated persistent session")
    result.add_argument("--timeout-ms", type=int, default=15_000, help="Per-element/navigation timeout")
    result.add_argument("--auth-timeout-ms", type=int, default=300_000, help="Time allowed for manual sign-in/checkpoint")
    result.add_argument("--settle-ms", type=int, default=2_000, help="Wait after opening the profile")
    result.add_argument("--yes", action="store_true", help="Required confirmation for reset")
    return result


def main(argv: Optional[List[str]] = None) -> int:
    args = parser().parse_args(argv)
    if args.command == "reset" and not args.yes:
        raise HarnessError("Reset changes the LinkedIn profile; rerun with --yes after checking the baseline")
    scenario = read_json(args.scenario)
    return run_browser(args, scenario)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except HarnessError as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(2)
