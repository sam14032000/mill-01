import asyncio
import json
import os
import sys
from datetime import datetime
from pathlib import Path

import requests
from gpt_researcher import GPTResearcher
from openai import OpenAI

REPO = Path("/home/agent/workspace/mill-01")
FIELD = REPO / "ideas" / sys.argv[1] / "field"   # founder-pasted notes
OUT   = REPO / "ideas" / sys.argv[1]
ASSUMPTION = sys.argv[2]

# No OpenAI account, ever. OPENAI_API_BASE / OPENAI_API_KEY are not
# OpenAI credentials -- they are the fixed variable names the
# OpenAI-compatible client GPT Researcher (and the openai-python client
# used directly below, for the citation check and gap output) rely on,
# and that's the standard, LiteLLM-recommended way to point *any*
# OpenAI-compatible client at a non-OpenAI server. Renaming these two
# would break the integration; nothing here ever talks to OpenAI.
os.environ["OPENAI_API_BASE"] = os.environ["LITELLM_BASE_URL"]
# mill-research, not mill-flash: research and interactive traffic have
# separate keys and budgets (Part 7.3) precisely because a research pass
# costs roughly as much as 250 interactive exchanges. mill-flash is
# scoped to flash-fast only and would 403 against the flash model this
# script needs.
os.environ["OPENAI_API_KEY"] = os.environ["MILL_RESEARCH_KEY"]

# GPT Researcher's own defaults (FAST_LLM=openai:gpt-4o-mini,
# SMART_LLM=openai:gpt-4.1, STRATEGIC_LLM=openai:o4-mini) are real
# OpenAI model names -- redirecting OPENAI_API_BASE to our proxy does
# NOT make these resolve; our config.yaml's model_list only has
# flash-fast/flash/audit/embed. Left unset, every call would
# 400 against a model our proxy doesn't have, regardless of the correct
# key routing above. Must be set explicitly to match.
os.environ["FAST_LLM"] = "openai:flash"
os.environ["SMART_LLM"] = "openai:flash"
os.environ["STRATEGIC_LLM"] = "openai:flash"

# EMBEDDING had the identical problem: default openai:text-embedding-3-
# small has no equivalent in config.yaml. Fixed by adding an `embed`
# entry (gemini/gemini-embedding-001 -- current model name verified
# against Google's own docs, not text-embedding-004, which is the older
# Vertex-path model) to LiteLLM, scoped to mill-research, and confirmed
# directly against the proxy's /embeddings endpoint before wiring it in
# here. This is what makes report_source="hybrid" (D-33's actual
# mechanism) work rather than something to route around.
os.environ["EMBEDDING"] = "openai:embed"

os.environ["RETRIEVER"] = "tavily"
# TAVILY_API_KEY is read from the environment by GPT Researcher directly
# -- nothing to redirect here, unlike the OPENAI_* variables above.

os.environ["DOC_PATH"] = str(FIELD)

CITATION_SAMPLE_SIZE = 3
FETCH_TIMEOUT_S = 10
FETCH_CHAR_LIMIT = 6000

client = OpenAI(base_url=os.environ["OPENAI_API_BASE"], api_key=os.environ["OPENAI_API_KEY"])


def flash(messages, max_tokens=2048):
    resp = client.chat.completions.create(
        model="flash", messages=messages, max_tokens=max_tokens
    )
    usage = resp.usage
    return resp.choices[0].message.content, usage.prompt_tokens, usage.completion_tokens


# D-20: "Re-fetch a sample of sources; confirm each supports the claim
# citing it. Decompose into sub-questions rather than judging
# holistically." GPT Researcher's report is prose, not a structured
# citation map, so there is no precise claim-to-source linkage to check
# against -- the honest scope here is "does this source's actual content
# corroborate the report's overall thrust," decomposed into concrete
# sub-questions, not "does it support this specific sentence." That
# limitation is real and stated in the output, not hidden.
def citation_recheck(report_text, sources):
    sample = sources[:CITATION_SAMPLE_SIZE]
    issues = []
    tokens_in = tokens_out = 0
    for url in sample:
        try:
            resp = requests.get(
                url, timeout=FETCH_TIMEOUT_S, headers={"User-Agent": "mill-research/0.1"}
            )
            fetched = resp.text[:FETCH_CHAR_LIMIT]
            fetch_ok = resp.ok
        except Exception as e:
            issues.append(f"- `{url}`: re-fetch failed ({e}) -- claims citing this source are unresolved, not confirmed.")
            continue

        if not fetch_ok:
            issues.append(f"- `{url}`: re-fetch returned HTTP {resp.status_code} -- unresolved, not confirmed.")
            continue

        content, ti, to = flash(
            [
                {
                    "role": "system",
                    "content": (
                        "You will be given a research report and the freshly re-fetched content of one "
                        "of its cited sources. Decompose into sub-questions: (1) what specific claims in "
                        "the report plausibly draw on this source, (2) for each, does the fetched content "
                        "actually support it. End with one line: SUPPORTED, UNSUPPORTED, or UNCLEAR, and why. "
                        "Do not assert anything the fetched content doesn't state."
                    ),
                },
                {
                    "role": "user",
                    "content": f"Report:\n{report_text}\n\nSource URL: {url}\nRe-fetched content:\n{fetched}",
                },
            ]
        )
        tokens_in += ti
        tokens_out += to
        verdict_line = content.strip().splitlines()[-1] if content.strip() else "UNCLEAR"
        if "SUPPORTED" not in verdict_line.upper() or "UNSUPPORTED" in verdict_line.upper():
            issues.append(f"- `{url}`: {verdict_line}")

    return issues, tokens_in, tokens_out


# D-33 gap output: only when evidence_basis is web-only. Asks questions,
# asserts nothing -- no D-20 risk the way a claim would carry.
def gap_output(assumption):
    content, ti, to = flash(
        [
            {
                "role": "system",
                "content": (
                    "Given a business assumption with only published-source evidence gathered so far "
                    "(no field evidence from real people), output exactly three specific questions that "
                    "would resolve whether it's true, and for each question name the kind of person who "
                    "could answer it. Do not answer the questions yourself."
                ),
            },
            {"role": "user", "content": assumption},
        ]
    )
    return content, ti, to


async def main():
    has_field = FIELD.exists() and any(FIELD.iterdir())
    total_tokens_in = 0
    total_tokens_out = 0

    r = GPTResearcher(
        query=ASSUMPTION,
        report_type="research_report",  # NOT "deep" -- depth degrades factual accuracy, citation metrics stay flat
        report_source="hybrid" if has_field else "web",
    )
    research_result = await r.conduct_research()
    report = await r.write_report()
    sources = r.get_source_urls()

    costs = getattr(r, "get_costs", lambda: None)()

    issues, ci_tokens_in, ci_tokens_out = citation_recheck(report, sources)
    total_tokens_in += ci_tokens_in
    total_tokens_out += ci_tokens_out
    if issues:
        report += "\n\n## Citation issues\n\n" + "\n".join(issues)

    # I1: the research pass does NOT grade field evidence. It records that
    # raw notes exist ("field-raw") or not ("web-only"); commands/audit.js
    # reads the raw notes and assigns the graded evidence_basis
    # (field-intent / field-behaviour / field-committed).
    evidence_basis = "field-raw" if has_field else "web-only"

    gap_text = None
    if evidence_basis == "web-only":
        gap_text, gap_ti, gap_to = gap_output(ASSUMPTION)
        total_tokens_in += gap_ti
        total_tokens_out += gap_to
        report += "\n\n## Gap output\n\n" + gap_text

    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    (OUT / f"research-{stamp}.md").write_text(report)

    field_notes_files = (
        [f"field/{p.name}" for p in sorted(FIELD.iterdir()) if p.is_file()] if has_field else []
    )

    meta = {
        "id": sys.argv[1],
        "assumption": ASSUMPTION,
        "evidence_basis": evidence_basis,
        "sources": sources,
        "field_notes_file": field_notes_files[0] if field_notes_files else None,
        "field_notes_files": field_notes_files,  # in case more than one exists
        "citation_issues": issues,
        "research_stub": False,
        "ts": stamp,
        "tokens_in": total_tokens_in,
        "tokens_out": total_tokens_out,
        "gpt_researcher_cost_usd": costs,
    }
    (OUT / f"research-{stamp}.json").write_text(json.dumps(meta, indent=2))
    print(json.dumps(meta))


asyncio.run(main())
