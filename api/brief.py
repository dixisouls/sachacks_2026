"""The hypothesis brief: the one place a language model writes prose.

The project's rule is that the model explains and assembles but never invents
the biology, and that rule is enforced here in code, not asked for in a prompt:

  * the model sees only the graph paths, the cohort facts and the retrieved
    evidence items. It is never given a search tool and never sees the internet.
  * every claim it returns must name at least one source id from that input.
    Claims that name none, or name an id we did not supply, are dropped before
    the response is built, and the count of dropped claims is reported.
  * readiness is copied from scoring. The model is told it, and cannot change it.

So the worst a bad generation can do is produce a thin brief, not a confident
wrong one.
"""

from __future__ import annotations

import json
import logging
import re
import time

from pydantic import BaseModel, Field

from api import cache, config
from api.evidence import gather_evidence
from api.profile import build_profile
from api.scoring import Scorer

log = logging.getLogger("repurposekg.brief")

SOURCE = "brief"
# Generous on purpose. These models think before answering, and the thinking is
# charged against this same budget: gemini-4-hydrogen spent 2045 tokens reasoning
# about one brief and had 3 left to write with, so the call returned nothing at all.
MAX_OUTPUT_TOKENS = 8192

SYSTEM = """You write one-page drug repurposing briefs for translational researchers.

You are given the graph paths that produced a ranking, structured facts about the
drug, and evidence retrieved from literature and trial registries. Write only from
what you are given.

Rules, in order of importance:
1. Every claim must cite at least one source_id from the EVIDENCE list you are
   given. A claim you cannot source does not belong in the brief.
2. Never state a fact that is not in the input. No dosing, no mechanism you
   happen to know, no papers you remember. If the input is thin, say it is thin.
3. Never give treatment advice or imply the drug should be used in patients.
   This is a research hypothesis for an expert to evaluate.
4. Mechanism claims must cite at least one KG: edge, because that is what the
   ranking actually rests on.
5. Distinguish observed from inferred. An edge marked inferred comes from
   chemical or sequence similarity, not from a recorded fact; word those claims
   as inference ("resembles X, which targets Y"), never as established.
6. evidence_against must mention contraindications, black box warnings and the
   most reported adverse events when the input contains them. A brief with no
   against side is a failed brief unless the input genuinely has nothing.

Write plainly. Short sentences. No marketing language, no hedging filler."""


class Claim(BaseModel):
    text: str
    source_ids: list[str]


class Brief(BaseModel):
    drug_id: str
    disease_id: str
    drug_name: str
    disease_name: str
    mechanism: list[Claim]
    evidence_for: list[Claim]
    evidence_against: list[Claim]
    readiness: str = Field(description="copied from scoring, never set by the model")
    evidence: list[dict]
    dropped_claims: int = Field(description="claims removed for citing nothing, or an unknown id")
    notes: list[str] = Field(description="sources that returned nothing or were unavailable")
    generated_at: str
    model: str


RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "mechanism": {"type": "array", "items": {
            "type": "object",
            "properties": {"text": {"type": "string"},
                           "source_ids": {"type": "array", "items": {"type": "string"}}},
            "required": ["text", "source_ids"]}},
        "evidence_for": {"type": "array", "items": {
            "type": "object",
            "properties": {"text": {"type": "string"},
                           "source_ids": {"type": "array", "items": {"type": "string"}}},
            "required": ["text", "source_ids"]}},
        "evidence_against": {"type": "array", "items": {
            "type": "object",
            "properties": {"text": {"type": "string"},
                           "source_ids": {"type": "array", "items": {"type": "string"}}},
            "required": ["text", "source_ids"]}},
    },
    "required": ["mechanism", "evidence_for", "evidence_against"],
}


def build_prompt(drug_name: str, disease_name: str, readiness: str, paths: dict,
                 profile, evidence_items: list[dict], notes: list[str]) -> str:
    lines = [f"DRUG: {drug_name}", f"DISEASE: {disease_name}",
             f"READINESS (already decided, do not change): {readiness}", ""]

    lines.append("GRAPH PATHS that produced this ranking:")
    for p in paths.get("paths", []):
        tag = "INFERRED" if p.get("inferred") else "observed"
        nodes = p.get("nodes", [])
        cite = f"KG:{nodes[0]}|{nodes[1]}" if len(nodes) > 1 else ""
        lines.append(f"  [{tag}] {p.get('explanation')}  (cite {cite})")
    if not paths.get("paths"):
        lines.append("  none")

    lines.append("")
    lines.append("DRUG FACTS from our own data:")
    for t in profile.targets[:6]:
        link = (f"linked to {disease_name}, association score {t.evidence_score}"
                if t.linked_to_disease else "not linked to this disease")
        lines.append(f"  acts on {t.symbol} as {', '.join(t.relations)} - {link}")
    if profile.functional_groups:
        lines.append(f"  chemical groups: {', '.join(profile.functional_groups)}")
    if profile.black_box:
        lines.append("  carries a black box warning")
    if profile.max_phase is not None:
        lines.append(f"  highest clinical phase reached overall: {profile.max_phase}")
    for a in profile.analogs[:3]:
        lines.append(f"  structurally similar to {a.name} (Tanimoto {a.tanimoto})"
                     f"{', which shares a target' if a.shares_target else ''}")

    lines.append("")
    lines.append("EVIDENCE you may cite. Use these ids exactly:")
    for item in evidence_items:
        snippet = f" - {item['snippet']}" if item.get("snippet") else ""
        lines.append(f"  [{item['id']}] ({item['source']}) {item['title']}{snippet}")
    if notes:
        lines.append("")
        lines.append("WHAT WE LOOKED FOR AND DID NOT FIND (state this if relevant, it is a finding):")
        for n in notes:
            lines.append(f"  {n}")

    lines.append("")
    lines.append("Write the brief as JSON: mechanism, evidence_for, evidence_against, "
                 "each a list of {text, source_ids}.")
    return "\n".join(lines)


def validate(claims: list[dict], allowed: set[str]) -> tuple[list[Claim], int]:
    """Drop any claim citing nothing, or citing an id we never supplied."""
    kept, dropped = [], 0
    for c in claims or []:
        ids = [i for i in (c.get("source_ids") or []) if i in allowed]
        text = (c.get("text") or "").strip()
        if not text or not ids:
            dropped += 1
            log.info("dropped unsupported claim: %r cites %r", text[:80], c.get("source_ids"))
            continue
        kept.append(Claim(text=text, source_ids=ids))
    return kept, dropped


async def generate(scorer: Scorer, drug_id: str, disease_id: str,
                   refresh: bool = False) -> Brief:
    if not config.have_llm():
        raise RuntimeError(
            "No GEMINI_API_KEY. Put it in .env at the repo root (see .env.example) "
            "or set it in the environment, then restart the server.")

    key = f"{drug_id}|{disease_id}|{config.GEMINI_MODEL}"
    if not refresh:
        cached = cache.get(SOURCE, key)
        if cached is not None:
            log.info("brief cache hit for %s", key)
            return Brief.model_validate(cached)

    j = scorer.disease_idx[disease_id]
    d = scorer.drug_idx[drug_id]
    drug_name, disease_name = scorer.drug_name[d], scorer.disease_name[j]

    result = scorer.candidates(disease_id, limit=200)
    row = next((c for c in result["approved"] + result["investigational"]
                if c["drug_id"] == drug_id), None)
    readiness = row["readiness"] if row else "NOT_RANKED"

    paths = scorer.paths(drug_id, disease_id)
    profile = build_profile(scorer, drug_id, j, row, set())
    synonyms = scorer.drugs["synonyms"][d].to_list() if scorer.drugs["synonyms"][d] is not None else []
    gathered = await gather_evidence(scorer.drug_name_raw[d] or drug_name, disease_name,
                                     drug_id, synonyms)

    # Graph edges are citable too, so the model can ground a mechanism claim.
    graph_items = [{"id": f"KG:{p['nodes'][0]}|{p['nodes'][1]}", "source": "graph",
                    "title": p["explanation"], "url": "", "snippet": None, "data": {}}
                   for p in paths["paths"] if len(p.get("nodes", [])) > 1]
    seen, items = set(), []
    for item in graph_items + gathered["items"]:
        if item["id"] not in seen:
            seen.add(item["id"])
            items.append(item)

    prompt = build_prompt(drug_name, disease_name, readiness, paths, profile,
                          items, gathered["notes"])

    from google import genai
    from google.genai import types

    client = genai.Client(api_key=config.GEMINI_API_KEY)
    started = time.perf_counter()
    response = await client.aio.models.generate_content(
        model=config.GEMINI_MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(
            system_instruction=SYSTEM,
            response_mime_type="application/json",
            response_schema=RESPONSE_SCHEMA,
            max_output_tokens=MAX_OUTPUT_TOKENS,
            temperature=0.2,
        ),
    )
    elapsed = (time.perf_counter() - started) * 1000

    raw = (response.text or "").strip()
    if not raw:
        reason = response.candidates[0].finish_reason if response.candidates else "unknown"
        usage = response.usage_metadata
        thoughts = getattr(usage, "thoughts_token_count", None) if usage else None
        if str(reason).endswith("MAX_TOKENS"):
            raise RuntimeError(
                f"{config.GEMINI_MODEL} used the whole {MAX_OUTPUT_TOKENS}-token budget "
                f"thinking ({thoughts} tokens) and wrote nothing. Raise MAX_OUTPUT_TOKENS "
                f"in api/brief.py, or set GEMINI_MODEL to a model that reasons less.")
        raise RuntimeError(f"{config.GEMINI_MODEL} returned no text (finish_reason {reason})")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", raw, re.S)
        if not match:
            raise RuntimeError(f"{config.GEMINI_MODEL} did not return JSON: {raw[:200]!r}")
        parsed = json.loads(match.group())

    allowed = {i["id"] for i in items}
    mechanism, d1 = validate(parsed.get("mechanism"), allowed)
    for_, d2 = validate(parsed.get("evidence_for"), allowed)
    against, d3 = validate(parsed.get("evidence_against"), allowed)

    brief = Brief(
        drug_id=drug_id, disease_id=disease_id,
        drug_name=drug_name, disease_name=disease_name,
        mechanism=mechanism, evidence_for=for_, evidence_against=against,
        readiness=readiness, evidence=items, dropped_claims=d1 + d2 + d3,
        notes=gathered["notes"], generated_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
        model=config.GEMINI_MODEL,
    )
    log.info("brief for %s / %s: %d claims kept, %d dropped, %d evidence items, %.0fms",
             drug_name, disease_name,
             len(mechanism) + len(for_) + len(against), brief.dropped_claims,
             len(items), elapsed)
    cache.put(SOURCE, key, brief.model_dump())
    return brief
