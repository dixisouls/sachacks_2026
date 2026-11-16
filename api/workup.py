"""The workup: what you would want to know about a molecule before spending money.

This runs once per track, on that track's winner, and it is the part of the
product most able to lie, because the four questions it answers (can it be
made, what would the body do with it, what else might it hit, is it worth
taking forward) are exactly the questions a language model will answer
fluently and wrongly if you let it.

So it does not get to answer them. The division is absolute:

  * Every number comes from code. The synthesis difficulty is the SA score
    RDKit already computed. The ADMET numbers are RDKit descriptors. The
    off-target identities are read out of the sequence-similarity artifact. The
    model never produces a figure and is told so.
  * Every status comes from the number, applied by a threshold in this file.
    The model's opinion of a number cannot change the number's verdict.
  * The case against is assembled in code before the model is asked anything,
    and the model can only add to it. The three facts that matter most -- that
    nothing here tests binding, that passing these checks is a low bar, and
    that the pocket result is a placement rather than a docking -- are
    therefore always present, whatever the model writes.

What is left for the model is the part it is good at: saying what a number
means in a sentence a researcher can read.
"""

from __future__ import annotations

import json
import logging
import os
import re
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable

import polars as pl
from rdkit.Chem import Crippen, Descriptors, MolFromSmarts, MolFromSmiles, rdMolDescriptors

from api import chemcheck, config
from api.design import _emit

log = logging.getLogger("repurposekg.workup")

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = Path(os.environ.get("ARTIFACT_DIR", ROOT / "artifacts"))

# The same budget the design loop uses, and for the same reason: this model
# thinks before it writes and the thinking is charged here (see api/brief.py).
# 16384 was not enough. On a live run against multiple sclerosis the synthesis
# sketch for one track spent the whole budget reasoning and returned nothing,
# losing that section while the other three succeeded. Sketching a route is the
# longest piece of thinking in the workup, so the budget matches the loop's.
MAX_OUTPUT_TOKENS = 32768

LABELS = {
    "synthesis": "Could a chemist make it",
    "admet": "What the body would do with it",
    "offtarget": "What else it might hit",
    "case": "The case for taking it forward",
}

SYSTEM = """You are explaining a designed molecule to a translational researcher.

Every number you are given was computed by a chemistry engine before you were
asked. You are explaining those numbers, not producing them.

Rules, in order of importance:
1. Never state a number that is not in the input, and never contradict one that
   is. If a number is missing, say it was not computed.
2. Never imply the molecule has been made, tested, assayed or dosed. It has
   not. It exists only as a structure on a screen.
3. Plain language, short sentences, no marketing. Write for a researcher in a
   different field, not for a medicinal chemist.
4. Say what you do not know. A hedge that names the missing experiment is worth
   more than a confident sentence.
5. Never give treatment advice and never compare this to a real therapy as if
   it were one."""


# ── the model call ───────────────────────────────────────────────────────────

async def _ask(prompt: str, schema: dict[str, Any]) -> dict[str, Any]:
    """One structured call. Raises if nothing usable comes back."""
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=config.GEMINI_API_KEY)
    response = await client.aio.models.generate_content(
        model=config.GEMINI_MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(
            system_instruction=SYSTEM,
            response_mime_type="application/json",
            response_schema=schema,
            max_output_tokens=MAX_OUTPUT_TOKENS,
            temperature=0.3,  # explaining, not searching
        ),
    )
    raw = (response.text or "").strip()
    if not raw:
        reason = response.candidates[0].finish_reason if response.candidates else "unknown"
        # Worth distinguishing, because the two have different fixes and this
        # message is shown to the reader on the failed step.
        if str(reason).endswith("MAX_TOKENS"):
            usage = response.usage_metadata
            thoughts = getattr(usage, "thoughts_token_count", None) if usage else None
            raise RuntimeError(
                f"{config.GEMINI_MODEL} spent its whole {MAX_OUTPUT_TOKENS}-token budget "
                f"thinking ({thoughts} tokens) and wrote nothing. Raise MAX_OUTPUT_TOKENS "
                "in api/workup.py.")
        raise RuntimeError(f"{config.GEMINI_MODEL} returned no text (finish_reason {reason})")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", raw, re.S)
        if not match:
            raise RuntimeError(f"{config.GEMINI_MODEL} did not return JSON: {raw[:200]!r}")
        return json.loads(match.group(0))


def _winner(track: dict[str, Any]) -> tuple[dict[str, Any], str, str]:
    best = track["best"]
    if not best:
        raise RuntimeError("no winner to work up")
    return best["check"], best["check"]["smiles"], best["name"]


# ── 1. synthesis ─────────────────────────────────────────────────────────────

SYNTHESIS_SCHEMA = {
    "type": "object",
    "properties": {
        "steps": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "what": {"type": "string",
                             "description": "The transformation, in one plain sentence. "
                                            "Name the reaction type if it has a common name."},
                    "why": {"type": "string",
                            "description": "Why this step is where it is, or what could go "
                                           "wrong with it. One sentence."},
                },
                "required": ["what", "why"],
            },
        },
        "note": {"type": "string",
                 "description": "One sentence on the main risk in this route."},
    },
    "required": ["steps", "note"],
}


def _difficulty(sa: float | None) -> tuple[str, str]:
    """The SA score, in words. The number is RDKit's; only the phrase is ours."""
    if sa is None:
        return "not computed", "unknown"
    if sa <= 4:
        return f"{sa:.1f} of 10, routine medicinal chemistry", "routine"
    if sa <= 6:
        return f"{sa:.1f} of 10, a few steps that need thought", "awkward"
    return f"{sa:.1f} of 10, a synthesis project in itself", "hard"


async def _synthesis(track: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    check, smiles, name = _winner(track)
    sa = check.get("properties", {}).get("sa_score")
    difficulty, band = _difficulty(sa)

    prompt = (
        f"MOLECULE {name}: {smiles}\n"
        f"It was designed from {context['parent_name']} ({context['parent_smiles']}).\n\n"
        f"SYNTHETIC ACCESSIBILITY, already computed by RDKit: {difficulty}. "
        "This is Ertl's SA score, where 1 is trivial and 10 is a research project. "
        f"The engine judges this molecule {band}.\n\n"
        "Sketch a plausible route: between 3 and 6 steps, working from commercially "
        "available material to this molecule. Say what each step does and why. Do not "
        "restate the difficulty number and do not contradict it. This is a sketch for a "
        "chemist to cost, not a validated route, and nothing has been made."
    )
    parsed = await _ask(prompt, SYNTHESIS_SCHEMA)
    steps = [{"n": i, "what": str(s.get("what", "")).strip(), "why": str(s.get("why", "")).strip()}
             for i, s in enumerate(parsed.get("steps", [])[:8], 1)
             if str(s.get("what", "")).strip()]
    if not steps:
        raise RuntimeError("the model returned no synthesis steps")

    note = str(parsed.get("note", "")).strip()
    # Appended in code, so the sketch can never be read as a route anyone has run.
    honest = ("No step here has been attempted. The difficulty figure is computed from the "
              "structure; the route is a suggestion for a chemist to price.")
    return {"difficulty": difficulty, "steps": steps,
            "note": f"{note} {honest}".strip() if note else honest}


# ── 2. ADMET ─────────────────────────────────────────────────────────────────

# A nitrogen that will carry a charge at blood pH: three-coordinate, not bonded to
# a heteroatom (which excludes sulfonamides, hydrazines, hydroxylamines), not an
# amide, not on an aromatic ring (aniline-type nitrogens are weak bases), not an
# imine. An approximation of "has a basic centre", and used only as that.
_BASIC_N = MolFromSmarts("[NX3;H0,H1,H2;!$(N[!#6;!#1]);!$(N[#6]=[O,N,S]);!$(N-a);!$(N=*);!$(N#*)]")
# Guanidines and amidines are basic enough to be charged everywhere in the body.
_VERY_BASIC_N = MolFromSmarts("[NX3][CX3]=[NX2,NX3]")


def _ramp(x: float, good: float, bad: float) -> float:
    """1.0 up to `good`, 0.0 from `bad`, straight line between. Wager's shape."""
    if bad == good:
        return 1.0 if x <= good else 0.0
    if bad > good:
        return 1.0 if x <= good else 0.0 if x >= bad else (bad - x) / (bad - good)
    return 1.0 if x >= good else 0.0 if x <= bad else (x - bad) / (good - bad)


def _basic_centre(mol) -> tuple[float, str]:
    """A stand-in for the most basic pKa, which nothing in this project computes.

    The real CNS MPO scores the most basic pKa, measured or predicted. There is
    no pKa predictor here, so the term is scored from a structural fact instead:
    whether the molecule carries a basic centre at all. That is a weaker signal
    and it is reported as one, in the note and in the detail line.
    """
    if _VERY_BASIC_N is not None and mol.HasSubstructMatch(_VERY_BASIC_N):
        return 0.0, "carries a guanidine or amidine, charged throughout the body"
    if _BASIC_N is not None and mol.HasSubstructMatch(_BASIC_N):
        return 0.25, "carries a basic amine, so it is largely charged in blood"
    return 1.0, "carries no basic centre, so it is mostly uncharged in blood"


def cns_mpo(mol) -> dict[str, Any]:
    """A CNS MPO-style score out of 6: how much this looks like a brain-penetrant drug.

    Wager's six desirability terms, four of them computed exactly (cLogP, MW,
    TPSA, HBD) and two substituted, which is why this is called MPO-*style*:
    logD at pH 7.4 is approximated by cLogP, and the most basic pKa by whether
    a basic centre is present at all. Both substitutions are named in the
    returned `caveat` so the number is never shown without them.
    """
    logp = Crippen.MolLogP(mol)
    tpsa = rdMolDescriptors.CalcTPSA(mol)
    mw = Descriptors.MolWt(mol)
    hbd = rdMolDescriptors.CalcNumHBD(mol)
    base, base_why = _basic_centre(mol)

    terms = {
        "clogp": _ramp(logp, 3.0, 5.0),
        "clogd (approximated by clogp)": _ramp(logp, 2.0, 4.0),
        "mw": _ramp(mw, 360.0, 500.0),
        # TPSA is the one term that is bad at both ends: too low and it will not
        # dissolve, too high and it will not cross.
        "tpsa": min(_ramp(tpsa, 40.0, 20.0), _ramp(tpsa, 90.0, 120.0)),
        "hbd": _ramp(float(hbd), 0.5, 3.5),
        "basic centre (in place of pKa)": base,
    }
    total = sum(terms.values())
    return {
        "score": round(total, 1),
        "terms": {k: round(v, 2) for k, v in terms.items()},
        "basis": base_why,
        "caveat": "Four of the six terms are computed descriptors. Two are substituted: "
                  "logD at pH 7.4 is approximated by cLogP, and the pKa term is scored from "
                  "whether a basic centre is present rather than from a predicted pKa. "
                  "Treat it as an indication, not a measurement.",
    }


def admet_items(smiles: str) -> list[dict[str, Any]]:
    """The computed half of the ADMET section: value and status, no prose.

    Separated out so the thresholds are testable without a model call. Status is
    decided here and nowhere else.
    """
    mol = MolFromSmiles(smiles)
    if mol is None:
        raise RuntimeError("the winner's structure will not parse, so nothing can be computed")

    mw = Descriptors.MolWt(mol)
    logp = Crippen.MolLogP(mol)
    tpsa = rdMolDescriptors.CalcTPSA(mol)
    hbd = rdMolDescriptors.CalcNumHBD(mol)
    rotatable = rdMolDescriptors.CalcNumRotatableBonds(mol)
    mpo = cns_mpo(mol)
    brain = ("likely" if mpo["score"] >= 4 else
             "uncertain" if mpo["score"] >= 2.5 else "unlikely")

    def band(value: float, ok: float, poor: float) -> str:
        return "pass" if value <= ok else "warn" if value <= poor else "fail"

    return [
        {"label": "Size", "value": f"{mw:.0f} g/mol", "status": band(mw, 500, 600),
         "fact": f"molecular weight {mw:.0f}; above 500 is heavy for a pill"},
        # The thresholds are deliberately wide at the polar end. Caffeine and
        # metformin both compute to cLogP -1.0, and a band that fails approved
        # drugs for being too polar is measuring the wrong thing: the end that
        # actually causes trouble is the greasy one.
        {"label": "Greasiness", "value": f"logP {logp:.1f}",
         "status": "pass" if -1.5 <= logp <= 5 else "warn" if -3 <= logp <= 6 else "fail",
         "fact": f"cLogP {logp:.1f}; 1 to 3 is the comfortable range. Above 5 a molecule "
                 "tends to bind everything and dissolve in nothing; far below zero it will "
                 "not cross a membrane without help"},
        {"label": "Polar surface", "value": f"TPSA {tpsa:.0f} A^2", "status": band(tpsa, 140, 160),
         "fact": f"topological polar surface area {tpsa:.0f} square angstrom; above 140 "
                 "rarely crosses a gut wall"},
        {"label": "Hydrogen-bond donors", "value": f"{hbd}", "status": band(float(hbd), 5, 6),
         "fact": f"{hbd} donors; each one costs energy to strip off on the way through a membrane"},
        {"label": "Flexibility", "value": f"{rotatable} rotatable bonds",
         "status": band(float(rotatable), 10, 12),
         "fact": f"{rotatable} rotatable bonds; a floppy molecule pays an entropy penalty "
                 "to bind and is absorbed less reliably"},
        {"label": "Reaches the brain",
         "value": f"{brain}, CNS MPO-style {mpo['score']} of 6",
         "status": "pass" if mpo["score"] >= 4 else "warn" if mpo["score"] >= 2.5 else "fail",
         "fact": f"CNS MPO-style score {mpo['score']} of 6 ({mpo['basis']}). "
                 f"{mpo['caveat']} This matters only if the target is inside the brain.",
         "mpo": mpo},
    ]


ADMET_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "label": {"type": "string", "description": "Copy one label exactly."},
                    "detail": {"type": "string",
                               "description": "What this number means for this molecule, in "
                                              "one or two plain sentences."},
                },
                "required": ["label", "detail"],
            },
        },
        "note": {"type": "string",
                 "description": "One or two sentences on what these numbers together do and "
                                "do not tell you."},
    },
    "required": ["items", "note"],
}


async def _admet(track: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    _, smiles, name = _winner(track)
    computed = admet_items(smiles)

    lines = [f"- {i['label']}: {i['value']} (judged {i['status']}). {i['fact']}"
             for i in computed]
    prompt = (
        f"MOLECULE {name}: {smiles}\n"
        f"Designed from {context['parent_name']}, for {context['disease_name']}.\n\n"
        "PROPERTIES, every one already computed by RDKit. The verdict beside each was "
        "decided by a threshold in code:\n" + "\n".join(lines) + "\n\n"
        "Write one plain-language line for each label above, explaining what that number "
        "means for this molecule. Use the exact labels. Do not restate a number without "
        "explaining it, do not dispute a verdict, and do not invent a property that is not "
        "listed. None of this has been measured in an animal or a person: these are "
        "properties of the structure, not observations."
    )
    parsed = await _ask(prompt, ADMET_SCHEMA)
    written = {str(i.get("label", "")).strip().lower(): str(i.get("detail", "")).strip()
               for i in parsed.get("items", []) if isinstance(i, dict)}

    items = []
    for item in computed:
        # The computed value and status always win; only the prose is the model's,
        # and a label it skipped falls back to the computed fact.
        items.append({"label": item["label"], "value": item["value"], "status": item["status"],
                      "detail": written.get(item["label"].lower()) or item["fact"].capitalize()})
    note = str(parsed.get("note", "")).strip()
    honest = ("Every number here is computed from the structure. Nothing has been dosed, "
              "measured or observed in any animal or person.")
    return {"items": items, "note": f"{note} {honest}".strip() if note else honest}


# ── 3. off-target ────────────────────────────────────────────────────────────

@lru_cache(maxsize=1)
def limits() -> str:
    """What the sequence layer can and cannot see, in one sentence.

    Said once and quoted wherever the section is thin, and the cutoffs are read
    out of the artifact's own metadata rather than written here. They have
    already moved once, from 40% identity to 30%, and a sentence in the product
    that says 40% about a file built at 30% is exactly the quietly wrong number
    this module exists to prevent: nothing would fail, and the page would
    misdescribe its own evidence.

    The asymmetry at the end is the shape of the search that was run, not a
    cutoff, so it is stated whatever the metadata says.
    """
    side = ("it searched drug-target proteins against proteins already associated with a "
            "disease, so a protein outside both sets cannot appear")
    try:
        meta = json.loads((ARTIFACTS / "meta.json").read_text())["homology"]
    except (OSError, ValueError, KeyError, TypeError):
        meta = {}

    # Each cutoff stands or falls on its own. Requiring both meant the sentence
    # dropped the identity cutoff it did know whenever coverage was absent --
    # which is every artifact built so far, because build_similarity.py passed
    # mmseqs -c 0.6 without recording it. Dropping a number we cannot stand
    # behind is right; dropping one we can is just less true.
    kept = []
    identity, coverage = meta.get("min_identity"), meta.get("min_coverage")
    if isinstance(identity, (int, float)):
        kept.append(f"above {identity:.0%} identity")
    if isinstance(coverage, (int, float)):
        kept.append(f"over {coverage:.0%} of the sequence")
    if not kept:
        return f"The comparison behind it keeps only strong, long alignments, and {side}."
    return f"The comparison behind it keeps pairs {' '.join(kept)}, and {side}."


@lru_cache(maxsize=1)
def _homolog_pairs() -> pl.DataFrame:
    path = ARTIFACTS / "homolog_pairs.parquet"
    if not path.exists():
        raise RuntimeError("artifacts/homolog_pairs.parquet is missing, so there is no "
                           "sequence data to look up off-targets in")
    return pl.read_parquet(path)


@lru_cache(maxsize=1)
def _uniprot_of() -> dict[str, str | None]:
    frame = pl.read_parquet(ARTIFACTS / "genes.parquet", columns=["gene_id", "uniprot_id"])
    return dict(zip(frame["gene_id"].to_list(), frame["uniprot_id"].to_list()))


@lru_cache(maxsize=1)
def _name_of() -> dict[str, str | None]:
    frame = pl.read_parquet(ARTIFACTS / "genes.parquet", columns=["gene_id", "name"])
    return dict(zip(frame["gene_id"].to_list(), frame["name"].to_list()))


def homologs(gene_ids: list[str], limit: int = 6) -> list[dict[str, Any]]:
    """Proteins whose sequence resembles one of these genes' proteins.

    Read straight out of the sequence comparison in homolog_pairs.parquet, the
    same data the ranking's homolog layer rests on. The identity is measured;
    what it implies is not.

    Both columns are searched, not just the first. That file was built one way
    round -- drug-target proteins searched against disease-associated proteins
    -- so a protein can appear only as somebody else's homolog. Sequence
    identity is symmetric, so a pair found from either side says the same thing,
    and looking only at the query column throws away half the data.

    Two limits worth knowing, both reported by the caller rather than papered
    over: the file holds only pairs above the identity and coverage cutoffs it
    was built with (see limits(), which reads them from the artifact), and its
    far side is only proteins associated with some disease. So an empty result
    means nothing close enough was recorded, not that the protein is selective.
    SIGMAR1 is the standing example: it has no human paralog at any cutoff worth
    using, so no rebuild will ever give it a relative.
    """
    wanted = {g for g in gene_ids if g}
    if not wanted:
        return []
    pairs = _homolog_pairs()
    forward = (pairs.filter(pl.col("gene_id").is_in(wanted))
                    .select(other="homolog_gene_id", other_symbol="homolog_symbol",
                            of_gene="gene_id", of_target="symbol",
                            identity="identity", query_coverage="query_coverage"))
    reverse = (pairs.filter(pl.col("homolog_gene_id").is_in(wanted))
                    .select(other="gene_id", other_symbol="symbol",
                            of_gene="homolog_gene_id", of_target="homolog_symbol",
                            identity="identity", query_coverage="query_coverage"))
    hits = (pl.concat([forward, reverse])
              # one of the seed's own targets is not an off-target of itself
              .filter(~pl.col("other").is_in(wanted))
              .sort("identity", descending=True))

    uniprot, names = _uniprot_of(), _name_of()
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in hits.iter_rows(named=True):
        gid = row["other"]
        if gid in seen:
            continue
        seen.add(gid)
        out.append({
            "gene_id": gid,
            "symbol": row["other_symbol"] or gid,
            "uniprot_id": uniprot.get(gid),
            "identity": round(float(row["identity"]), 3),
            "of_target": row["of_target"],
            "full_name": names.get(gid),
            "coverage": (round(float(row["query_coverage"]), 3)
                         if row["query_coverage"] else None),
        })
        if len(out) >= limit:
            break
    return out


OFFTARGET_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "symbol": {"type": "string", "description": "Copy one symbol exactly."},
                    "concern": {"type": "string",
                                "description": "What hitting this protein as well would mean "
                                               "for a patient, in one or two sentences. If you "
                                               "do not know what it does, say so."},
                },
                "required": ["symbol", "concern"],
            },
        },
        "note": {"type": "string", "description": "One sentence on how much this tells you."},
    },
    "required": ["items", "note"],
}


async def _offtarget(track: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    _, smiles, name = _winner(track)
    targets = context.get("targets") or []
    found = homologs([t.get("gene_id") for t in targets])
    if not found:
        # An empty list is a result, not a failure, and it is worth showing: it
        # says where the data stops. Returned without asking the model anything,
        # because there is nothing for it to explain and it would fill the gap.
        symbols = ", ".join(t["symbol"] for t in targets)
        return {"items": [], "note": (
            f"No protein in the sequence data resembles "
            f"{symbols or 'the targets recorded for this drug'} closely enough to be listed. "
            f"{limits()} So this is a gap in the data, not evidence that the molecule is "
            "selective: no one has tested it against anything.")}

    lines = [f"- {h['symbol']}"
             + (f" ({h['full_name']})" if h["full_name"] else "")
             + f": {h['identity']:.0%} sequence identity to {h['of_target']}, "
               f"which {context['parent_name']} targets"
             for h in found]
    prompt = (
        f"MOLECULE {name}: {smiles}\n"
        f"Designed from {context['parent_name']}, which targets "
        f"{', '.join(t['symbol'] for t in targets) or 'no recorded protein'}.\n\n"
        "PROTEINS WITH SIMILAR SEQUENCES, measured by all-against-all sequence comparison. "
        "A protein whose sequence resembles the target may have a similar binding site, so a "
        "molecule aimed at one can hit the other:\n" + "\n".join(lines) + "\n\n"
        "For each symbol above, say in one or two sentences what also hitting that protein "
        "would mean for a patient. Use the exact symbols. Do not change any identity figure "
        "and do not add proteins that are not listed. Nothing has been tested against any of "
        "these: the only evidence here is sequence similarity."
    )
    parsed = await _ask(prompt, OFFTARGET_SCHEMA)
    written = {str(i.get("symbol", "")).strip().upper(): str(i.get("concern", "")).strip()
               for i in parsed.get("items", []) if isinstance(i, dict)}

    items = [{"symbol": h["symbol"], "uniprot_id": h["uniprot_id"], "identity": h["identity"],
              "concern": written.get(h["symbol"].upper())
              or (f"{h['identity']:.0%} identical in sequence to {h['of_target']}. What hitting "
                  "it would do was not established here.")}
             for h in found]
    note = str(parsed.get("note", "")).strip()
    honest = ("Identities are measured sequence identity from artifacts/homolog_pairs.parquet. "
              "A similar sequence is a reason to check a protein, not evidence that this "
              f"molecule binds it: nothing here was tested against any of them. {limits()}")
    return {"items": items, "note": f"{note} {honest}".strip() if note else honest}


# ── 4. the case ──────────────────────────────────────────────────────────────

CASE_SCHEMA = {
    "type": "object",
    "properties": {
        "verdict": {"type": "string",
                    "description": "One honest sentence on whether this is worth anyone's "
                                   "time, and why."},
        "for": {"type": "array", "items": {"type": "string"},
                "description": "What genuinely argues for it. Two to four points."},
        "against": {"type": "array", "items": {"type": "string"},
                    "description": "What argues against it, beyond the limits already listed "
                                   "in the input. Two to four points."},
        "next_step": {"type": "string",
                      "description": "The single cheapest experiment that would settle whether "
                                     "this is worth pursuing. One concrete assay."},
    },
    "required": ["verdict", "for", "against", "next_step"],
}


def case_floor(track: dict[str, Any]) -> list[str]:
    """The three things that must be said against every molecule in this product.

    Built in code, before the model is asked anything, and prepended to whatever
    it returns. The model is able to add to this list and unable to shorten it,
    which is the only arrangement that makes the section trustworthy.
    """
    rate = chemcheck.RANDOM_PASS_RATE
    passed = round(rate * 200)
    floor = [
        "Nothing here tests whether this molecule binds anything. No assay has been run, "
        "and the molecule has never been made.",
        # One decimal, because the job reports random_pass_rate as 0.815 and a
        # reader should not see 82% here and 81.5% beside it.
        f"Passing these checks is a low bar: {passed} of 200 molecules drawn at random from "
        f"the drug library pass them too ({rate:.1%}), and so does the drug this was designed "
        "from.",
    ]
    placed = (track.get("best") or {}).get("check", {}).get("properties", {}).get("pocket")
    seed = (track.get("seed") or {}).get("name", "the starting drug")
    if placed:
        floor.append(
            f"The pocket result is a placement, not a docking: the shared core was pinned to "
            f"where {seed} actually sits in {placed.get('pdb_id')} and the rest followed. "
            "Nothing searched for a better pose and the protein was held rigid.")
    else:
        floor.append(
            f"No measured structure of {seed} inside a target protein was found, so nothing "
            "in this track tested the target at all. Every check it passed was about the "
            "molecule alone.")
    return floor


async def _case(track: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    check, smiles, name = _winner(track)
    floor = case_floor(track)
    tried = len(track["attempts"])
    accepted = sum(1 for a in track["attempts"] if a["check"]["status"] == "pass")
    checks = "\n".join(f"- {c['label']}: {c['status'].upper()}, {c['value']}. {c['detail']}"
                       for c in check.get("checks", []))
    seed = track.get("seed") or {}

    prompt = (
        f"MOLECULE {name}: {smiles}\n"
        f"Designed from {seed.get('name', 'a ranked drug')} ({seed.get('smiles', '')}) for "
        f"{context['disease_name']}.\n"
        f"The run proposed {tried} molecules and {accepted} passed every check. This one was "
        f"ranked first.\n\n"
        f"WHAT THE CHEMISTRY ENGINE SAID ABOUT IT:\n{checks}\n\n"
        f"WHAT THE STARTING DRUG SCORED ON THE SAME CHECKS: "
        f"{seed.get('check', {}).get('summary', 'not scored')}\n\n"
        "LIMITS THAT ARE ALREADY RECORDED AGAINST IT, and will be shown whatever you write. "
        "Do not repeat these; add to them:\n" + "\n".join(f"- {f}" for f in floor) + "\n\n"
        "Give the honest case. The verdict is one sentence and may well be that this is not "
        "worth pursuing. For the next step, name one concrete, cheap experiment that would "
        "settle it: a binding assay against a named protein, not a programme of work."
    )
    parsed = await _ask(prompt, CASE_SCHEMA)

    def strings(key: str) -> list[str]:
        return [str(x).strip() for x in (parsed.get(key) or []) if str(x).strip()]

    seen = {f.lower() for f in floor}
    against = list(floor)
    for point in strings("against"):
        if point.lower() not in seen:
            seen.add(point.lower())
            against.append(point)

    verdict = str(parsed.get("verdict", "")).strip()
    next_step = str(parsed.get("next_step", "")).strip()
    if not verdict or not next_step:
        raise RuntimeError("the model returned no verdict or no next step")
    return {"verdict": verdict, "for": strings("for"), "against": against,
            "next_step": next_step}


# ── the four, in order ───────────────────────────────────────────────────────

SECTIONS: tuple[tuple[str, Callable], ...] = (
    ("synthesis", _synthesis),
    ("admet", _admet),
    ("offtarget", _offtarget),
    ("case", _case),
)


async def run_workup(job: dict[str, Any], pool: str, track: dict[str, Any],
                     context: dict[str, Any]) -> dict[str, Any]:
    """All four sections on this track's winner.

    Each one stands alone: a section that fails reports its failure, stays null,
    and does not stop the next. A workup missing its off-target list is worth
    more than a run that died producing one.
    """
    workup: dict[str, Any] = {kind: None for kind, _ in SECTIONS}
    for kind, produce in SECTIONS:
        _emit(job, "workup_step", track=pool, step=kind, label=LABELS[kind], status="running")
        try:
            data = await produce(track, context)
        except Exception as exc:  # noqa: BLE001 - one section's failure is its own
            log.warning("workup %s/%s failed: %s", pool, kind, exc)
            _emit(job, "workup_step", track=pool, step=kind, label=LABELS[kind],
                  status="error", text=str(exc))
            continue
        workup[kind] = data
        _emit(job, "workup", track=pool, kind=kind, data=data)
        _emit(job, "workup_step", track=pool, step=kind, label=LABELS[kind], status="done")
    return workup
