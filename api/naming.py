"""Readable drug names.

OptimusKG stores names in capitals (CETIRIZINE, 2-CHLOROPHENOL) and leaves 3,548
of 13,911 drugs with no name at all beyond their ChEMBL id. Neither reads well in
a list a researcher is scanning.

Three fixes, cheapest first:

  1. case      CETIRIZINE -> Cetirizine, without wrecking codes like SGS-742,
               NADH, 1400W or ME-344
  2. synonyms  a drug named only CHEMBL100109 may still carry a usable synonym
  3. PubChem   last resort for a bare id, looked up by InChIKey

The original string is always kept as `name_raw`, and `name_source` says where
the displayed name came from, so nothing is silently rewritten underneath anyone.

PubChem is not always an improvement: it turns R-406 into Tamatinib, which is
better, but 1400W into N-(3-(aminomethyl)benzyl)acetamidine, which is worse. So
it is only consulted when there is no real name at all.
"""

from __future__ import annotations

import logging
import re

import httpx

from api import cache

log = logging.getLogger("repurposekg.naming")

SOURCE = "pubchem_name"
PUBCHEM_TITLE = ("https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/inchikey/"
                 "{key}/property/Title/JSON")

BARE_ID = re.compile(r"^CHEMBL\d+$", re.I)

# A research code rather than a word: SGS-742, ME-344, R-406, 1400W, NV-128.
CODE = re.compile(r"^[A-Z]{1,5}[-–]?\d+[A-Z]?$|^\d+[A-Z]$")
HAS_DIGIT = re.compile(r"\d")
# Acronyms that are shouted on purpose.
KEEP_UPPER = {"NAD", "NADH", "NADP", "ATP", "ADP", "GTP", "DNA", "RNA", "PEG", "EDTA",
              "DMSO", "HIV", "TNF", "COX", "ACTH", "GABA", "LSD", "THC", "CBD", "MDMA"}
# Single letters that are locants in a chemical name and stay capital: N-acetyl, D-glucose.
LOCANT_UPPER = {"N", "O", "S", "P", "C", "D", "L", "R", "E", "Z"}
# Greek letters and descriptors that stay lowercase: alpha-tocopherol, tert-butyl.
LOWER_PREFIX = {"ALPHA", "BETA", "GAMMA", "DELTA", "OMEGA", "CIS", "TRANS", "ORTHO",
                "META", "PARA", "SEC", "TERT", "ENDO", "EXO", "SYN", "ANTI"}


def _case_part(part: str) -> str:
    if not part or HAS_DIGIT.search(part):
        return part                      # a locant number or an embedded code
    bare = re.sub(r"[^A-Za-z]", "", part)
    if bare in KEEP_UPPER:
        return part
    if bare in LOCANT_UPPER:
        return part.upper()
    if bare in LOWER_PREFIX:
        return part.lower()
    return re.sub(r"[A-Za-z]+", lambda m: m.group().capitalize(), part.lower())


def _case_token(token: str) -> str:
    if CODE.match(token) or re.sub(r"[^A-Za-z]", "", token) in KEEP_UPPER:
        return token
    # Split on hyphens but keep them, so 2-CHLOROPHENOL -> 2-Chlorophenol.
    return "".join(p if p in "-–" else _case_part(p) for p in re.split(r"([-–])", token))


def prettify(name: str) -> str:
    """Title-case a shouted name while leaving codes, acronyms and locants alone."""
    if not name or not name.isupper():
        return name  # already mixed case: assume it was written deliberately
    return " ".join(_case_token(t) for t in name.split(" "))


def _best_synonym(synonyms: list[str] | None) -> str | None:
    """The shortest synonym that reads like a name rather than a formula or code."""
    usable = [
        s for s in (synonyms or [])
        if s and not BARE_ID.match(s) and 3 <= len(s) <= 28
        and sum(c.isdigit() for c in s) <= 2
        and not s.startswith(("InChI", "CAS-"))
    ]
    return min(usable, key=len) if usable else None


async def pubchem_title(client: httpx.AsyncClient, inchi_key: str) -> str | None:
    cached = cache.load(SOURCE, inchi_key)
    if cached is not None:
        return cached or None
    try:
        response = await client.get(PUBCHEM_TITLE.format(key=inchi_key), timeout=6.0)
        if response.status_code != 200:
            cache.put(SOURCE, inchi_key, "")
            return None
        props = response.json().get("PropertyTable", {}).get("Properties", [])
        title = props[0].get("Title") if props else None
    except (httpx.HTTPError, ValueError, KeyError, IndexError) as exc:
        log.warning("pubchem title lookup failed for %s: %s", inchi_key, exc)
        return None  # transient, don't cache
    cache.put(SOURCE, inchi_key, title or "")
    return title or None


def display_name(name: str | None, drug_id: str,
                 synonyms: list[str] | None = None) -> tuple[str, str]:
    """Return (displayed name, where it came from). No network."""
    if name and not BARE_ID.match(name):
        return prettify(name), "graph"
    synonym = _best_synonym(synonyms)
    if synonym:
        return prettify(synonym), "synonym"
    return drug_id, "chembl_id"


async def resolve(client: httpx.AsyncClient, name: str | None, drug_id: str,
                  inchi_key: str | None, synonyms: list[str] | None = None
                  ) -> tuple[str, str]:
    """display_name(), but allowed one PubChem lookup when nothing else worked."""
    shown, source = display_name(name, drug_id, synonyms)
    if source != "chembl_id" or not inchi_key:
        return shown, source
    title = await pubchem_title(client, inchi_key)
    return (prettify(title), "pubchem") if title else (shown, source)
