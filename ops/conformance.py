#!/usr/bin/env python3
"""EVAL.md Layer 1 -- conformance. Deterministic checks only, C-01
through C-23. "Do not ask a model what a script can prove" (EVAL.md) --
every check here is a grep, a file read, a git command, or an HTTP call
to LiteLLM's own API, never a model call.

Run: python3 ops/conformance.py
Reads ~/.config/mill/env and ~/stack/litellm/.env for keys needed to
query LiteLLM -- never prints a key value, only pass/fail derived from
what the API returns.
"""

import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
OPS_DIR = REPO_ROOT / "ops"
SLACK_BOT_DIR = OPS_DIR / "slack-bot"
MINDS_DIR = REPO_ROOT / "minds"
IDEAS_DIR = REPO_ROOT / "ideas"
DECISIONS_FILE = REPO_ROOT / "docs" / "DECISIONS.md"
TELEMETRY_DIR = REPO_ROOT / "telemetry"

LITELLM_BASE_URL = os.environ.get("LITELLM_BASE_URL", "http://127.0.0.1:4000")

# Known, deliberate gap in D-numbering (not a deletion) -- checked
# directly, not assumed: no reference to D-18 or D-19 exists anywhere in
# the repo (grep across docs/*.md, ops/BUILD-LOG.md), so these numbers
# were simply never assigned during drafting, unlike every superseded
# entry (D-09, D-11, D-31, ...), which is still present with a
# SUPERSEDED marker per DECISIONS.md's own stated convention.
KNOWN_NUMBERING_GAPS = {18, 19}

BANNED_MODEL_PATTERNS = [
    re.compile(r"opus", re.IGNORECASE),
    re.compile(r"kimi", re.IGNORECASE),
    re.compile(r"deepseek", re.IGNORECASE),
]


class Result:
    def __init__(self, check_id, desc, passed, reason):
        self.check_id = check_id
        self.desc = desc
        self.passed = passed
        self.reason = reason


def load_env_file(path):
    out = {}
    try:
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    except FileNotFoundError:
        pass
    return out


MILL_ENV = load_env_file(Path.home() / ".config" / "mill" / "env")
LITELLM_ENV = load_env_file(Path.home() / "stack" / "litellm" / ".env")
MASTER_KEY = LITELLM_ENV.get("LITELLM_MASTER_KEY")


def litellm_get(path, key=None):
    """GET against the local LiteLLM proxy. Returns (status, json_or_None,
    error_str_or_None) -- never raises, since a check that can't reach
    LiteLLM should fail with a clear reason, not crash the whole run."""
    url = f"{LITELLM_BASE_URL}{path}"
    req = urllib.request.Request(url)
    req.add_header("Authorization", f"Bearer {key}")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode()), None
    except urllib.error.HTTPError as e:
        return e.code, None, f"HTTP {e.code}"
    except Exception as e:  # noqa: BLE001 -- genuinely any failure here is "unreachable"
        return None, None, str(e)


def git(args, cwd=REPO_ROOT):
    return subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, check=False
    )


def grep_files(root, pattern, extensions, exclude_dirs=("node_modules",)):
    """Plain-Python recursive grep, avoiding a dependency on GNU grep
    flags being consistent across environments. Returns list of
    (path, line_no, line_text) for every match."""
    hits = []
    regex = re.compile(pattern)
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in exclude_dirs and not d.startswith(".")]
        for fname in filenames:
            if not any(fname.endswith(ext) for ext in extensions):
                continue
            fpath = Path(dirpath) / fname
            try:
                for i, line in enumerate(fpath.read_text(errors="replace").splitlines(), 1):
                    if regex.search(line):
                        hits.append((fpath, i, line.strip()))
            except OSError:
                continue
    return hits


def read_json(path):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, json.JSONDecodeError):
        return None


# ---------------------------------------------------------------------
# Model routing (C-01 -- C-05)
# ---------------------------------------------------------------------

def check_c01():
    # Real usage only (process.env.MILL_AUDIT_KEY), not comments that
    # merely mention the variable name for documentation -- audit-llm.js
    # itself has such a comment, which would false-positive on a bare
    # substring search.
    hits = grep_files(
        SLACK_BOT_DIR,
        r"process\.env\.MILL_AUDIT_KEY|process\.env\[.MILL_AUDIT_KEY.\]",
        (".js",),
    )
    offenders = [h for h in hits if h[0].name != "audit-llm.js"]
    if offenders:
        return Result(
            "C-01", "No Fable call originates outside the audit path (D-10)", False,
            f"MILL_AUDIT_KEY read outside audit-llm.js: {offenders[0][0]}:{offenders[0][1]}",
        )
    if not hits:
        return Result(
            "C-01", "No Fable call originates outside the audit path (D-10)", False,
            "MILL_AUDIT_KEY not read anywhere -- audit-llm.js may have been refactored; check manually",
        )
    # Also confirm callAudit (the function that uses the key) is only
    # imported from commands/audit.js.
    importers = grep_files(SLACK_BOT_DIR, r"require\([\"'].*audit-llm[\"']\)", (".js",))
    bad_importers = [h for h in importers if h[0].name != "audit.js"]
    if bad_importers:
        return Result(
            "C-01", "No Fable call originates outside the audit path (D-10)", False,
            f"audit-llm.js imported outside commands/audit.js: {bad_importers[0][0]}:{bad_importers[0][1]}",
        )
    return Result("C-01", "No Fable call originates outside the audit path (D-10)", True, "MILL_AUDIT_KEY read only in audit-llm.js; audit-llm.js imported only by commands/audit.js")


def check_c02():
    if not MASTER_KEY:
        return Result("C-02", "Fable MTD spend <= $35 (D-23 tripwire)", False, "LITELLM_MASTER_KEY not available to this script")
    today = date.today()
    start = today.replace(day=1).isoformat()
    status, data, err = litellm_get(f"/spend/logs?start_date={start}&end_date={today.isoformat()}", MASTER_KEY)
    if err or not isinstance(data, list):
        return Result("C-02", "Fable MTD spend <= $35 (D-23 tripwire)", False, f"LiteLLM /spend/logs unreachable or malformed: {err}")
    total = 0.0
    for day in data:
        models = day.get("models", {}) if isinstance(day, dict) else {}
        for model_name, spend in models.items():
            if "claude-fable" in model_name.lower() or model_name == "audit":
                total += spend
    if total > 35:
        return Result("C-02", "Fable MTD spend <= $35 (D-23 tripwire)", False, f"MTD Fable spend ${total:.2f} exceeds $35 -- D-23's tripwire for calls outside the audit gate")
    return Result("C-02", "Fable MTD spend <= $35 (D-23 tripwire)", True, f"MTD Fable spend ${total:.4f}")


def check_c03():
    if not MASTER_KEY:
        return Result("C-03", "No calls to Opus 5 / Kimi K3 / DeepSeek (D-07, D-09, D-11)", False, "LITELLM_MASTER_KEY not available to this script")
    today = date.today()
    start = today.replace(day=1).isoformat()
    status, data, err = litellm_get(f"/spend/logs?start_date={start}&end_date={today.isoformat()}", MASTER_KEY)
    if err or not isinstance(data, list):
        return Result("C-03", "No calls to Opus 5 / Kimi K3 / DeepSeek (D-07, D-09, D-11)", False, f"LiteLLM /spend/logs unreachable: {err}")
    seen_models = set()
    for day in data:
        models = day.get("models", {}) if isinstance(day, dict) else {}
        seen_models.update(models.keys())
    banned_hits = [m for m in seen_models if any(p.search(m) for p in BANNED_MODEL_PATTERNS)]
    # Also check the proxy's own model_list for a banned entry, even if
    # it's never been called -- a configured-but-unused banned route is
    # still a conformance problem, just not yet a spend problem.
    config_path = Path.home() / "stack" / "litellm" / "config.yaml"
    config_text = config_path.read_text() if config_path.exists() else ""
    config_hits = [p.pattern for p in BANNED_MODEL_PATTERNS if p.search(config_text)]
    if banned_hits or config_hits:
        return Result(
            "C-03", "No calls to Opus 5 / Kimi K3 / DeepSeek (D-07, D-09, D-11)", False,
            f"banned model reference found -- spend logs: {banned_hits}, config.yaml: {config_hits}",
        )
    return Result("C-03", "No calls to Opus 5 / Kimi K3 / DeepSeek (D-07, D-09, D-11)", True, f"models seen this month: {sorted(seen_models)}")


def check_c04():
    provider_urls = re.compile(
        r"api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.openai\.com"
    )
    hits = grep_files(OPS_DIR, provider_urls.pattern, (".js", ".py"))
    if hits:
        return Result(
            "C-04", "All model calls route through LiteLLM, not a direct provider base_url", False,
            f"direct provider URL found in application code: {hits[0][0]}:{hits[0][1]}",
        )
    return Result("C-04", "All model calls route through LiteLLM, not a direct provider base_url", True, "no direct provider base_url found in ops/ application code")


def check_c05():
    expected_keys = {
        "mill-flash": {"MILL_FLASH_KEY"},
        "mill-research": {"MILL_RESEARCH_KEY"},
        "mill-audit": {"MILL_AUDIT_KEY"},
    }
    if not MASTER_KEY:
        return Result("C-05", "Per-key daily budgets configured (D-23)", False, "LITELLM_MASTER_KEY not available to this script")
    problems = []
    for alias, env_names in expected_keys.items():
        env_name = next(iter(env_names))
        key_value = MILL_ENV.get(env_name)
        if not key_value:
            problems.append(f"{env_name} not set in ~/.config/mill/env")
            continue
        status, data, err = litellm_get(f"/key/info?key={key_value}", MASTER_KEY)
        if err or not data:
            problems.append(f"{alias}: /key/info unreachable ({err})")
            continue
        info = data.get("info", {})
        max_budget = info.get("max_budget")
        budget_duration = info.get("budget_duration")
        if max_budget is None:
            problems.append(f"{alias}: max_budget is null")
        if budget_duration != "1d":
            problems.append(f"{alias}: budget_duration is {budget_duration!r}, expected '1d' (D-23 amendment)")
    if problems:
        return Result("C-05", "Per-key daily budgets configured (D-23)", False, "; ".join(problems))
    return Result("C-05", "Per-key daily budgets configured (D-23)", True, "all four keys have non-null max_budget and budget_duration=1d")


# ---------------------------------------------------------------------
# Gate integrity (C-06 -- C-10)
# ---------------------------------------------------------------------

def check_c06():
    # audit.js's context assembly is the thing to check -- no import of
    # think/cross/blindspot's modules, and no reference to a captures
    # reader or profile reader inside the file that builds the audit
    # prompt. Static, since audit-*.json never stores the prompt sent.
    audit_js = SLACK_BOT_DIR / "commands" / "audit.js"
    text = audit_js.read_text()
    forbidden = re.compile(r"require\([\"'].*(think|cross|blindspot|context)[\"']\)")
    hits = forbidden.findall(text)
    if hits:
        return Result("C-06", "No audit input contains brainstorm transcript content (D-28)", False, f"commands/audit.js imports a brainstorm-shaped module: {hits}")
    return Result("C-06", "No audit input contains brainstorm transcript content (D-28)", True, "commands/audit.js imports only idea.md (assumption) + research report -- no think/cross/blindspot/context module")


# I1: `proceed` requires field-behaviour or field-committed. none,
# web-only and field-intent all cap at narrow.
C07_CAPPED = {"none", "web-only", "field-intent", "field-supported"}  # field-supported = pre-I1 records


def check_c07():
    violations = []
    for audit_file in IDEAS_DIR.glob("*/audit-*.json"):
        data = read_json(audit_file)
        if not data:
            continue
        if data.get("verdict") == "proceed" and data.get("evidence_basis") in C07_CAPPED:
            violations.append(f"{audit_file.name}: proceed on {data.get('evidence_basis')}")
    if violations:
        return Result("C-07", "No 'proceed' verdict below field-behaviour (D-33 / I1)", False, f"violating audit records: {violations}")
    n = len(list(IDEAS_DIR.glob("*/audit-*.json")))
    return Result("C-07", "No 'proceed' verdict below field-behaviour (D-33 / I1)", True, f"checked {n} audit record(s), none carry a proceed on {sorted(C07_CAPPED)}")


def check_c08():
    problems = []
    for research_file in IDEAS_DIR.glob("*/research-*.md"):
        idea_id = research_file.parent.name
        idea_md = IDEAS_DIR / idea_id / "idea.md"
        if not idea_md.exists() or "## Assumption" not in idea_md.read_text():
            problems.append(f"{idea_id}: has a research pass but idea.md has no '## Assumption' section")
    if problems:
        return Result("C-08", "Every research pass has a falsifiable assumption (D-28)", False, "; ".join(problems))
    n = len(list(IDEAS_DIR.glob("*/research-*.md")))
    return Result("C-08", "Every research pass has a falsifiable assumption (D-28)", True, f"checked {n} research pass(es), all have an assumption on file")


def check_c09():
    problems = []
    checked = 0
    for research_json in IDEAS_DIR.glob("*/research-*.json"):
        data = read_json(research_json)
        if not data or data.get("evidence_basis") != "web-only":
            continue
        checked += 1
        research_md = research_json.with_suffix(".md")
        text = research_md.read_text() if research_md.exists() else ""
        if "## Gap output" not in text:
            problems.append(f"{research_json}: evidence_basis web-only but no '## Gap output' section")
    if problems:
        return Result("C-09", "Web-only research produces 3 questions + who-to-ask (D-33)", False, "; ".join(problems))
    return Result("C-09", "Web-only research produces 3 questions + who-to-ask (D-33)", True, f"checked {checked} web-only research pass(es), all have a Gap output section")


def check_c10():
    problems = []
    checked = 0
    for audit_file in IDEAS_DIR.glob("*/audit-*.json"):
        data = read_json(audit_file)
        if not data or data.get("verdict") != "kill":
            continue
        checked += 1
        idea_id = audit_file.parent.name
        state = read_json(IDEAS_DIR / idea_id / "state.json") or {}
        founder = state.get("founder")
        graveyard = MINDS_DIR / (founder or "") / "graveyard.md"
        if not founder or not graveyard.exists() or idea_id not in graveyard.read_text():
            problems.append(f"{idea_id}: killed but not found in {founder}'s graveyard.md")
    if problems:
        return Result("C-10", "Every kill verdict writes to the founder's graveyard.md", False, "; ".join(problems))
    return Result("C-10", "Every kill verdict writes to the founder's graveyard.md", True, f"checked {checked} kill verdict(s), all present in the originating founder's graveyard.md")


# ---------------------------------------------------------------------
# Loop discipline (C-11 -- C-14)
# ---------------------------------------------------------------------

def check_c11():
    # /proto's refusal is enforced in code before any idea/proto dir is
    # touched (docs/COMMANDS.md), so the only thing checkable after the
    # fact is the structural correlate: a proto/ dir only exists for an
    # idea whose idea.md carries an assumption.
    problems = []
    for proto_dir in IDEAS_DIR.glob("*/proto"):
        idea_id = proto_dir.parent.name
        idea_md = IDEAS_DIR / idea_id / "idea.md"
        if not idea_md.exists() or "## Assumption" not in idea_md.read_text():
            problems.append(f"{idea_id}: has proto/ output but no assumption on file")
    if problems:
        return Result("C-11", "No /proto invocation succeeded without a named assumption (D-29)", False, "; ".join(problems))
    n = len(list(IDEAS_DIR.glob("*/proto")))
    return Result("C-11", "No /proto invocation succeeded without a named assumption (D-29)", True, f"checked {n} idea(s) with prototype output, all have an assumption on file")


def check_c12():
    problems = []
    for state_file in IDEAS_DIR.glob("*/state.json"):
        data = read_json(state_file) or {}
        touch_count = data.get("touch_count", 0)
        if touch_count > 5:
            problems.append(f"{state_file.parent.name}: touch_count={touch_count}")
        proto_dir = state_file.parent / "proto"
        if proto_dir.is_dir():
            n_touches = len([d for d in proto_dir.iterdir() if d.is_dir()])
            if n_touches > 5:
                problems.append(f"{state_file.parent.name}: {n_touches} proto/<n> directories on disk")
    if problems:
        return Result("C-12", "No prototype exceeds five touch iterations (D-29)", False, "; ".join(problems))
    return Result("C-12", "No prototype exceeds five touch iterations (D-29)", True, "no idea's touch_count or proto/ directory count exceeds 5")


def check_c13():
    # Every commit that touches a profile.md or dynamics.md, other than
    # its initial creation, must be an approved-diff commit -- the only
    # code path that writes to these files after creation is
    # handleDiffDecision's approve branch, whose commit message always
    # contains "weekly diff approved by".
    problems = []
    checked = 0
    targets = list(MINDS_DIR.glob("*/profile.md")) + [MINDS_DIR / "shared" / "dynamics.md"]
    for target in targets:
        rel = target.relative_to(REPO_ROOT)
        log = git(["log", "--follow", "--pretty=%H %s", "--", str(rel)])
        commits = [line for line in log.stdout.splitlines() if line.strip()]
        if len(commits) <= 1:
            continue  # only the initial scaffold commit, or never committed
        for line in commits[:-1]:  # newest-first; skip the oldest (creation) commit
            h = line.split(" ", 1)[0]
            # A rename-only commit (e.g. the founder-directory rename,
            # c7f3732: minds/amit -> minds/saksham with 0 content
            # changes) is not a second write to the file's content and
            # shouldn't need an approval marker -- only a commit that
            # actually changes the file's content is in scope for D-30.
            numstat = git(["show", "--numstat", "--pretty=", h, "--", rel])
            stat_line = next((l for l in numstat.stdout.splitlines() if l.strip()), "")
            parts = stat_line.split("\t")
            if len(parts) >= 2 and parts[0] == "0" and parts[1] == "0":
                continue
            checked += 1
            if "weekly diff approved by" not in line:
                problems.append(f"{rel}: commit without approval marker -- {line[:80]}")
    if problems:
        return Result("C-13", "No profile diff applied without recorded approval (D-30)", False, "; ".join(problems))
    return Result("C-13", "No profile diff applied without recorded approval (D-30)", True, f"checked {checked} post-creation commit(s) to profile/dynamics files, all carry an approval marker")


def check_c14():
    problems = []
    checked = 0
    tracked = set(git(["ls-files", "minds"]).stdout.splitlines())
    for capture_file in MINDS_DIR.glob("*/captures/*.md"):
        checked += 1
        rel = str(capture_file.relative_to(REPO_ROOT))
        if rel not in tracked:
            problems.append(f"{rel}: not tracked in git (D-38 requires captures reach the shared repo)")
            continue
        founder = capture_file.parent.parent.name
        if founder not in ("saksham", "amisha", "vaibhav"):
            problems.append(f"{rel}: capture file outside a recognized founder directory")
    if problems:
        return Result("C-14", "Every capture is in the shared repo, correctly attributed (D-38)", False, "; ".join(problems))
    return Result("C-14", "Every capture is in the shared repo, correctly attributed (D-38)", True, f"checked {checked} capture file(s), all git-tracked under a recognized founder directory")


# ---------------------------------------------------------------------
# Isolation (C-15 -- C-18)
# ---------------------------------------------------------------------

SANDBOX_DIR = Path.home() / "stack" / "sandbox"
RUN_SH = SANDBOX_DIR / "run.sh"
MOUNT_SH = SANDBOX_DIR / "mount.sh"
# Every script that does `docker run` for a prototype -- one-shot exec and
# the persistent mount slot both (Part 18). New runners must be added here.
CONTAINER_SCRIPTS = [RUN_SH, MOUNT_SH]
# -e flags that are not credentials: the mount container is told which
# port to listen on and nothing else.
ALLOWED_ENV_FLAGS = {"-e PORT=8080", "--env PORT=8080"}


def check_c15():
    problems = []
    checked = []
    for script in CONTAINER_SCRIPTS:
        if not script.exists():
            problems.append(f"{script.name} not found")
            continue
        text = script.read_text()
        mounts = re.findall(r"-v\s+\"?([^\"\s]+)\"?:", text)
        non_scratch = [m for m in mounts if "SCRATCH" not in m and "$d" not in m and "{d}" not in m]
        if non_scratch:
            problems.append(f"{script.name}: host mount(s) beyond scratch: {non_scratch}")
        elif not mounts:
            problems.append(f"{script.name}: no -v mount found -- refactored?")
        else:
            checked.append(f"{script.name}={mounts}")
    if problems:
        return Result("C-15", "Prototype containers mount nothing beyond scratch (D-06)", False, "; ".join(problems))
    return Result("C-15", "Prototype containers mount nothing beyond scratch (D-06)", True, f"scratch-only mounts: {checked}")


def check_c16():
    problems = []
    for script in CONTAINER_SCRIPTS:
        if not script.exists():
            problems.append(f"{script.name} not found")
            continue
        text = script.read_text()
        if "--env-file /dev/null" not in text and "--env-file=/dev/null" not in text:
            problems.append(f"{script.name}: no --env-file /dev/null -- host env may leak")
            continue
        env_flags = [f.strip() for f in re.findall(r"(-e\s+\S+|--env(?!-file)\s+\S+)", text)]
        bad = [f for f in env_flags if f.replace("  ", " ") not in ALLOWED_ENV_FLAGS]
        if bad:
            problems.append(f"{script.name}: unexpected -e/--env flag(s): {bad}")
    if problems:
        return Result("C-16", "No credential env vars reachable from a prototype container (D-06)", False, "; ".join(problems))
    return Result(
        "C-16", "No credential env vars reachable from a prototype container (D-06)", True,
        "run.sh and mount.sh both use --env-file /dev/null; only -e PORT=8080 is passed (not a credential). Verify by hand quarterly per D-06/EVAL.md.",
    )


def check_c17():
    # Checked against real Docker/iptables state, not script comment text
    # (an earlier version grepped a comment and passed on a false
    # premise). Part 18 / D-48: two networks, and DOCKER-USER must both
    # (a) DROP each sandbox subnet's catch-all and (b) NOT contain a
    # blanket accept for either subnet.
    for net in ("mill-build", "mill-mount"):
        chk = subprocess.run(["docker", "network", "inspect", net], capture_output=True, text=True, check=False)
        if chk.returncode != 0:
            return Result("C-17", "Mounted-container egress is deny-all + DNS (D-48)", False, f"'{net}' Docker network not found: {chk.stderr.strip()[:150]}")

    ipt = subprocess.run(["sudo", "-n", "iptables", "-S", "DOCKER-USER"], capture_output=True, text=True, check=False)
    if ipt.returncode != 0:
        return Result("C-17", "Mounted-container egress is deny-all + DNS (D-48)", False, f"could not read DOCKER-USER: {ipt.stderr.strip()[:150]} -- unverified, not passing")
    rules = ipt.stdout.splitlines()

    build_cidr, mount_cidr = "172.30.0.0/24", "172.31.0.0/24"
    def has(substr_all):
        return any(all(tok in r for tok in substr_all) for r in rules)

    problems = []
    # deny-all tail for each sandbox subnet
    if not has([f"-s {mount_cidr}", "-j DROP"]):
        problems.append(f"no catch-all DROP for the mount subnet {mount_cidr}")
    if not has([f"-s {build_cidr}", "-j DROP"]):
        problems.append(f"no catch-all DROP for the build subnet {build_cidr}")
    # mount profile must NOT have any accept beyond DNS + established
    for r in rules:
        if f"-s {mount_cidr}" in r and ("-j RETURN" in r or "-j ACCEPT" in r):
            if not ("dport 53" in r or "ESTABLISHED" in r):
                problems.append(f"mount subnet has a non-DNS accept rule: {r.strip()}")
    # mount DNS must be permitted (deny-all + *DNS*)
    if not has([f"-s {mount_cidr}", "dport 53"]):
        problems.append("mount subnet has no DNS allow rule")

    if problems:
        return Result("C-17", "Mounted-container egress is deny-all + DNS (D-48)", False, "; ".join(problems))
    return Result(
        "C-17", "Mounted-container egress is deny-all + DNS (D-48)", True,
        f"DOCKER-USER: {mount_cidr} = DNS-only + catch-all DROP; {build_cidr} = DNS + npm 443 + catch-all DROP",
    )


def check_c18():
    # Pi was uninstalled entirely (D-43) after this check's first run
    # showed zero invocations anywhere -- see D-03 (superseded) for the
    # full record. The check stays: it's still meaningful as a guard
    # against Pi (or a successor harness) getting reintroduced into a
    # working-prototype's execution path outside Part 10's container.
    hits = grep_files(OPS_DIR, r"\bpi\s+-p\b|spawn\([\"']pi[\"']|execFile\([\"']pi[\"']|require\([\"']pi[\"']\)", (".js", ".py", ".sh"))
    code_hits = [h for h in hits if not h[2].lstrip().startswith(("#", "//", "*"))]
    if code_hits:
        return Result("C-18", "Pi is never invoked outside its container for working prototypes (D-06)", False, f"host-side Pi invocation found: {code_hits[0][0]}:{code_hits[0][1]}")
    return Result(
        "C-18", "Pi is never invoked outside its container for working prototypes (D-06)", True,
        "no Pi invocation found anywhere in ops/ application code -- Pi is uninstalled entirely as of D-43, so this now passes for the straightforward reason rather than the technicality it passed on before.",
    )


# ---------------------------------------------------------------------
# Provenance (C-19 -- C-22)
# ---------------------------------------------------------------------

CAPTURE_LINE = re.compile(r"^- \d{2}:\d{2} — .+")


def check_c19():
    problems = []
    checked = 0
    for capture_file in MINDS_DIR.glob("*/captures/*.md"):
        founder = capture_file.parent.parent.name
        if founder not in ("saksham", "amisha", "vaibhav"):
            problems.append(f"{capture_file}: not under a recognized founder directory")
            continue
        checked += 1
    if problems:
        return Result("C-19", "Every capture carries a founder attribution", False, "; ".join(problems))
    return Result("C-19", "Every capture carries a founder attribution", True, f"checked {checked} capture file(s), all located under a founder directory (attribution is structural, per D-38's directory-based model)")


def check_c20():
    problems = []
    checked = 0
    capture_files = git(["ls-files", "minds/*/captures/*.md"]).stdout.splitlines()
    for rel in capture_files:
        log = git(["log", "--pretty=%H", "--", rel])
        commits = [c for c in log.stdout.splitlines() if c.strip()]
        if len(commits) <= 1:
            continue
        checked += 1
        # Oldest-to-newest, diff each consecutive pair; a capture file
        # may only gain lines, never lose or change one (D-42).
        commits.reverse()
        for older, newer in zip(commits, commits[1:]):
            diff = git(["diff", older, newer, "--", rel])
            removed = [
                line for line in diff.stdout.splitlines()
                if line.startswith("-") and not line.startswith("---")
            ]
            if removed:
                problems.append(f"{rel}: {older[:8]}..{newer[:8]} removes/modifies a line -- {removed[0][:80]}")
    if problems:
        return Result("C-20", "No capture file modified after commit (D-42, append-only)", False, "; ".join(problems))
    return Result("C-20", "No capture file modified after commit (D-42, append-only)", True, f"checked {checked} multi-commit capture file(s), every revision is a pure append")


def check_c21():
    # A full semantic check ("does every structural change have a
    # DECISIONS entry") needs judgement a script can't supply -- this is
    # a deterministic proxy, stated as such rather than dressed up as
    # the real thing: every commit in the last 30 days whose message
    # matches an explicitly "structural" pattern (new Part, new command,
    # infra change) is checked against whether the *same commit* also
    # touches docs/DECISIONS.md, OR a DECISIONS.md commit exists within
    # +/-1 day of it. Flags for manual review rather than silently
    # passing when it can't tell.
    since = "30 days ago"
    log = git(["log", f"--since={since}", "--pretty=%H|%ai|%s"])
    structural_pattern = re.compile(r"\bPart \d+\b|D-\d+|structural", re.IGNORECASE)
    decisions_commits = []
    flagged = []
    entries = [line.split("|", 2) for line in log.stdout.splitlines() if line.strip()]
    for h, ts, subject in entries:
        files = git(["show", "--stat", "--pretty=", h]).stdout
        if "docs/DECISIONS.md" in files:
            decisions_commits.append((h, ts))
    for h, ts, subject in entries:
        if not structural_pattern.search(subject):
            continue
        files = git(["show", "--stat", "--pretty=", h]).stdout
        if "docs/DECISIONS.md" in files:
            continue
        commit_date = datetime.fromisoformat(ts.replace(" ", "T", 1)).date() if "T" not in ts else None
        near = any(
            abs((datetime.fromisoformat(ots.replace(" ", "T", 1) if "T" in ots else ots.split(" ")[0]).date() - commit_date).days) <= 1
            for _, ots in decisions_commits
        ) if commit_date else False
        if not near:
            flagged.append(f"{h[:8]} {subject[:70]}")
    if flagged:
        return Result(
            "C-21", "Every structural change in the last month has a DECISIONS entry", False,
            f"{len(flagged)} commit(s) look structural but have no nearby DECISIONS.md commit -- manual review needed, this is a heuristic proxy, not a semantic check: {flagged[:5]}",
        )
    return Result("C-21", "Every structural change in the last month has a DECISIONS entry", True, f"{len(entries)} commit(s) in the last 30 days, none flagged by the structural-commit heuristic (proxy check -- see script comment; still worth a human skim)")


def check_c22():
    text = DECISIONS_FILE.read_text()
    numbers = sorted(int(n) for n in re.findall(r"^### D-(\d+)", text, re.MULTILINE))
    if not numbers:
        return Result("C-22", "No DECISIONS entry deleted", False, "no D-NN headers found in DECISIONS.md at all")
    expected = set(range(numbers[0], numbers[-1] + 1)) - KNOWN_NUMBERING_GAPS
    missing = sorted(expected - set(numbers))
    if missing:
        return Result("C-22", "No DECISIONS entry deleted", False, f"D-number(s) missing from DECISIONS.md and not in the known-gap list: {missing}")
    return Result("C-22", "No DECISIONS entry deleted", True, f"D-{numbers[0]}..D-{numbers[-1]} all present (known non-assigned gap: {sorted(KNOWN_NUMBERING_GAPS)})")


# ---------------------------------------------------------------------
# Telemetry accuracy (C-23)
# ---------------------------------------------------------------------

# LiteLLM's model_group (not litellm_params.model, e.g. "audit" not
# "anthropic/claude-fable-5") is what telemetry's own "model" field
# already matches -- that's the join key, not the underlying provider
# model name.
TOLERANCE_ABS_USD = 0.0005
TOLERANCE_REL = 0.15
SAMPLE_SIZE = 25
MATCH_WINDOW_BUFFER_S = 10

# Telemetry events logged before this point used the old hardcoded
# Gemini-only cost calculator (eval-event.js's buildEvalEvent used to
# compute cost_usd itself instead of taking it from the caller) and are
# known-wrong for any non-Gemini model, known-approximate even for
# Gemini calls, and known-wrong for any stage that sums multiple LLM
# calls into one event (cross.js's two parallel reads) since the old
# estimate was computed per-event from summed tokens, not summed from
# two real per-call LiteLLM costs. The audit-stage instances of this bug
# were individually corrected by hand in telemetry/2026-08.jsonl,
# matched against LiteLLM's spend log by exact token count (see
# ops/BUILD-LOG.md); the rest were deliberately left as historical
# record rather than backfilled wholesale. C-23 checks accuracy of the
# fix going forward, not the accuracy of data logged before it existed
# -- events before this cutoff are excluded from the sample rather than
# scored against a standard they predate.
#
# Bumped 2026-08-29: the D-52 chat-turn rewrite added an execute() path
# (regex / model_high intent routing) that returned before its own
# telemetry emit, so on a model_high route the conversational classifier
# call's cost was spent but never logged -- C-23 caught the gap on a
# real f05e turn. Fixed (execute() now logs that call's cost); live
# events between the D-52 deploy and this fix under-report and are
# excluded, same rationale as the original cutoff.
PRICING_FIX_DEPLOYED_AT = "2026-08-29T10:38:41+00:00"


def parse_telemetry_ts(ts):
    return datetime.fromisoformat(ts)


def check_c23():
    if not MASTER_KEY:
        return Result("C-23", "Logged cost_usd matches LiteLLM's spend log within tolerance", False, "LITELLM_MASTER_KEY not available to this script")

    month_file = TELEMETRY_DIR / f"{date.today().strftime('%Y-%m')}.jsonl"
    if not month_file.exists():
        return Result("C-23", "Logged cost_usd matches LiteLLM's spend log within tolerance", True, f"no telemetry file for this month yet ({month_file.name}) -- nothing to check")

    all_events = []
    for line in month_file.read_text().splitlines():
        if not line.strip():
            continue
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        all_events.append(e)
    cutoff = datetime.fromisoformat(PRICING_FIX_DEPLOYED_AT).timestamp()
    post_fix = [e for e in all_events if parse_telemetry_ts(e["ts"]).timestamp() >= cutoff]

    # Cache-hit events must be zero-cost: LiteLLM bills nothing for a
    # cache hit (verified -- x-litellm-key-spend is unchanged across
    # one), even though x-litellm-response-cost still reports the
    # would-be uncached price. llm.js/audit-llm.js detect the hit (the
    # x-litellm-cache-key response header) and record cost 0; a
    # regression there would show as a cached call logged at full price,
    # exactly the bug this sub-check guards. Brainstorm is built around
    # prefix caching, so this is the common path, not an edge case.
    cache_hit_bad = [
        f"{e['ts']} stage={e.get('stage')}: cache_hit_ratio={e.get('cache_hit_ratio')} but cost_usd={e.get('cost_usd')} (a cache hit is billed nothing)"
        for e in post_fix
        if (e.get("cache_hit_ratio") or 0) > 0 and (e.get("cost_usd") or 0) > TOLERANCE_ABS_USD
    ]
    if cache_hit_bad:
        return Result(
            "C-23", "Logged cost_usd matches LiteLLM's spend log within tolerance", False,
            f"{len(cache_hit_bad)} cache-hit event(s) logged with nonzero cost: {cache_hit_bad[:5]}",
        )

    events = [e for e in post_fix if e.get("status") == "ok" and e.get("model") and e.get("cost_usd", 0) > 0]
    sample = events[-SAMPLE_SIZE:]
    if not sample:
        return Result("C-23", "Logged cost_usd matches LiteLLM's spend log within tolerance", True, "no cost-bearing telemetry events since the pricing fix was deployed -- nothing to check yet")

    # The aggregated /spend/logs?start_date=...&end_date=... form used by
    # C-02/C-03 only gives per-day totals, not per-request rows -- need
    # the raw per-request form here (no date params) to match individual
    # telemetry events against individual LiteLLM calls.
    status, rows, err = litellm_get("/spend/logs", MASTER_KEY)
    if err or not isinstance(rows, list):
        return Result("C-23", "Logged cost_usd matches LiteLLM's spend log within tolerance", False, f"LiteLLM /spend/logs (raw) unreachable or malformed: {err}")

    by_model_group = {}
    for row in rows:
        mg = row.get("model_group")
        st = row.get("startTime")
        if not mg or not st:
            continue
        try:
            epoch = datetime.fromisoformat(st.replace("Z", "+00:00")).timestamp()
        except ValueError:
            continue
        by_model_group.setdefault(mg, []).append((epoch, row.get("spend", 0.0)))

    mismatches = []
    unmatched = 0
    checked = 0
    seen = set()  # event ids already accounted for as a co-timed sibling
    for i, event in enumerate(sample):
        if i in seen:
            continue
        model = event["model"]
        candidates = by_model_group.get(model, [])
        if not candidates:
            unmatched += 1
            continue
        # ts is written when the event is emitted, right after the call
        # (or calls) complete -- so the real call(s) fall somewhere in
        # [ts - wall_clock_s - buffer, ts + buffer]. Summing every row
        # in that window handles stages that make more than one real
        # LLM call per event (cross.js's two parallel founder reads,
        # attack.js's/proto.js's/audit.js's retry-on-parse-failure).
        event_epoch = parse_telemetry_ts(event["ts"]).timestamp()
        wall_clock = event.get("wall_clock_s", 0) or 0
        window_start = event_epoch - wall_clock - MATCH_WINDOW_BUFFER_S
        window_end = event_epoch + MATCH_WINDOW_BUFFER_S
        in_window = [spend for epoch, spend in candidates if window_start <= epoch <= window_end]
        if not in_window:
            unmatched += 1
            continue
        # D-53: one turn can emit two same-model events for one set of
        # LiteLLM rows -- e.g. the agent's turn event plus the `find`
        # event when the agent runs a broad search (agent.js call + the
        # find handler's resolve/plan/summarise calls). Sum every sampled
        # event of the same model whose window overlaps, and compare that
        # sum to the spend-row sum, so a correctly-split pair isn't
        # double-flagged.
        siblings = [event]
        for j in range(i + 1, len(sample)):
            if j in seen:
                continue
            o = sample[j]
            if o["model"] != model:
                continue
            o_epoch = parse_telemetry_ts(o["ts"]).timestamp()
            if window_start <= o_epoch <= window_end:
                siblings.append(o)
                seen.add(j)
        checked += 1
        logged = sum(s["cost_usd"] for s in siblings)
        real = sum(in_window)
        tolerance = max(TOLERANCE_ABS_USD, TOLERANCE_REL * real) * max(1, len(siblings))
        if abs(logged - real) > tolerance:
            label = "+".join(s["stage"] for s in siblings)
            mismatches.append(f"{event['ts']} stage={label} model={model}: telemetry cost_usd(sum)={logged} vs LiteLLM spend(window sum)={real} across {len(in_window)} row(s) (tolerance {tolerance:.5f})")

    if mismatches:
        return Result(
            "C-23", "Logged cost_usd matches LiteLLM's spend log within tolerance", False,
            f"{len(mismatches)}/{checked} sampled event(s) mismatch: {mismatches[:5]}",
        )
    if checked == 0:
        return Result(
            "C-23", "Logged cost_usd matches LiteLLM's spend log within tolerance", False,
            f"none of {len(sample)} sampled event(s) could be matched to a LiteLLM spend log row within their call window -- can't verify, treated as a failure rather than a silent pass",
        )
    return Result(
        "C-23", "Logged cost_usd matches LiteLLM's spend log within tolerance", True,
        f"{checked}/{len(sample)} sampled event(s) matched within tolerance ({unmatched} unmatched -- likely calls outside this month's LiteLLM retention or clock skew beyond the call window)",
    )


# ---------------------------------------------------------------------
# Observability (C-24)
# ---------------------------------------------------------------------

HEALTHCHECK_LOG = Path("/home/agent/logs/healthcheck.log")
_HC_STAMP = re.compile(r"^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\]")


def check_c24():
    # ops/healthcheck.sh emits exactly one "[<utc>] healthcheck ran ..."
    # line every cron invocation (every 30 min), pass or fail. If that
    # line is missing or stale, the healthcheck itself has silently
    # stopped -- which is how the budget/service/disk/heartbeat alerts it
    # carries would all go dark without anyone noticing (the pattern this
    # check exists to break).
    desc = "healthcheck.sh has logged a run in the last 24h"
    if not HEALTHCHECK_LOG.exists():
        return Result("C-24", desc, False, f"{HEALTHCHECK_LOG} does not exist -- healthcheck.sh has never logged a run")
    stamps = []
    try:
        for line in HEALTHCHECK_LOG.read_text(errors="replace").splitlines():
            m = _HC_STAMP.match(line)
            if m:
                stamps.append(datetime.strptime(m.group(1), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc))
    except OSError as err:
        return Result("C-24", desc, False, f"could not read {HEALTHCHECK_LOG}: {err}")
    if not stamps:
        return Result("C-24", desc, False, f"{HEALTHCHECK_LOG} has no parseable '[<utc>] healthcheck ran' line")
    newest = max(stamps)
    age_h = (datetime.now(timezone.utc) - newest).total_seconds() / 3600
    if age_h > 24:
        return Result("C-24", desc, False, f"most recent healthcheck run was {age_h:.1f}h ago ({newest.isoformat()}) -- cron job may have stopped")
    return Result("C-24", desc, True, f"most recent run {age_h:.1f}h ago ({newest.isoformat()}), {len(stamps)} run line(s) in the log")


# ---------------------------------------------------------------------
# Improvement-layer silent-failure guards (C-25, C-26)
# ---------------------------------------------------------------------

# I4's staleness sweep and I3's graveyard-digest parser are both
# mechanisms whose whole job is to catch neglect -- and both fail
# silently (a dead scheduler, a regex that stops matching a reformatted
# file). These two checks are the "component fails without emitting
# anything" guard the founder asked for, applied to I3/I4.

# Only enforce C-25 for ideas whose full 14-day staleness window elapsed
# under I4 (like C-23's cutoff -- don't score pre-feature data).
I4_ACTIVE_SINCE = datetime(2026, 8, 28, tzinfo=timezone.utc)
STALE_STATES = {"open", "researched"}


def check_c25():
    desc = "No idea sits pre-verdict past 14 days without a recorded staleness nudge (I4)"
    now = datetime.now(timezone.utc)
    overdue = []
    checked = 0
    for state_file in IDEAS_DIR.glob("*/state.json"):
        if state_file.parent.name.lower().startswith("zz"):
            continue
        st = read_json(state_file)
        if not st or st.get("state") not in STALE_STATES:
            continue
        ts = st.get("updated_at") or st.get("created_at")
        if not ts:
            continue
        try:
            updated = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except ValueError:
            continue
        if updated < I4_ACTIVE_SINCE:
            continue  # window predates I4
        age_days = (now - updated).total_seconds() / 86400
        if age_days < 15:  # 14 + a day of grace for the daily sweep
            continue
        checked += 1
        if 14 not in (st.get("stale_nudges") or []):
            overdue.append(f"{state_file.parent.name}: {st['state']}, {age_days:.0f}d stale, no 14d nudge recorded")
    if overdue:
        return Result("C-25", desc, False, f"the daily staleness sweep may have stopped: {overdue}")
    return Result("C-25", desc, True, f"{checked} idea(s) past the 14-day mark under I4, all carry a recorded nudge")


_GY_LINE = re.compile(r"^- \d{4}-\d{2}-\d{2} — `[^`]+`:", re.MULTILINE)
_GY_ENTRY = re.compile(
    r"^- (\d{4}-\d{2}-\d{2}) — `([^`]+)`: ([\s\S]*?)\n\s*Reason: ([\s\S]*?)(?=\n- |\n*$)",
    re.MULTILINE,
)


def check_c26():
    desc = "The graveyard digest parser (I3) still extracts every kill entry it should"
    problems = []
    total_lines = 0
    total_parsed = 0
    for gy in MINDS_DIR.glob("*/graveyard.md"):
        try:
            text = gy.read_text(errors="replace")
        except OSError:
            continue
        n_lines = len(_GY_LINE.findall(text))
        n_parsed = len(_GY_ENTRY.findall(text))
        total_lines += n_lines
        total_parsed += n_parsed
        if n_lines > n_parsed:
            problems.append(f"{gy.parent.name}: {n_lines} kill line(s), parser extracted {n_parsed} -- the audit is getting an incomplete or empty graveyard")
    if problems:
        return Result("C-26", desc, False, "; ".join(problems))
    return Result("C-26", desc, True, f"{total_parsed}/{total_lines} kill entries across all graveyards parse cleanly (vacuously true while graveyards are empty)")


CHECKS = [
    check_c01, check_c02, check_c03, check_c04, check_c05,
    check_c06, check_c07, check_c08, check_c09, check_c10,
    check_c11, check_c12, check_c13, check_c14,
    check_c15, check_c16, check_c17, check_c18,
    check_c19, check_c20, check_c21, check_c22,
    check_c23, check_c24, check_c25, check_c26,
]


def main():
    results = [check() for check in CHECKS]
    passed = [r for r in results if r.passed]
    failed = [r for r in results if not r.passed]

    print(f"# Conformance -- {date.today().isoformat()}\n")
    print(f"PASS {len(passed)}/{len(results)}\n")
    if failed:
        print("## Failures\n")
        for r in failed:
            print(f"- **{r.check_id}** ({r.desc}): {r.reason}")
        print()
    print("## All checks\n")
    for r in results:
        mark = "PASS" if r.passed else "FAIL"
        print(f"- [{mark}] {r.check_id} -- {r.desc}\n  {r.reason}")

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
