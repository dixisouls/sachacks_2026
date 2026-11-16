"""3D structure lookup for one (drug, gene) pair (see architecture.md section 9).

Lookup order:
  1. drug 3D      PubChem SDF by InChIKey (record_type=3d)
  2. ligand code  RCSB chem comp whose InChIKey matches exactly; if none, RCSB SMILES
                  graph search with stereo ignored (our InChIKeys are often stereo-free,
                  e.g. doxepin ...-UHFFFAOYSA-N vs PDB 5EH ...-GZTJUZNOSA-N)
  3. co-crystal   RCSB entry containing that ligand AND the target's UniProt accession,
                  best resolution wins
  4. fallback     AlphaFold DB prediction for the UniProt accession

Modes:
  BOUND      co-crystal found (drug shown inside the protein; experimental pose)
  SEPARATE   AlphaFold prediction, drug shown in its own viewer (never docked)
  DRUG_ONLY  drug 3D exists, no protein structure
  NONE       no drug 3D either; the frontend draws 2D from SMILES

External APIs were checked against live responses on 2026-11-15:
  * RCSB Search v2: text_chem + rcsb_chem_comp_descriptor.InChIKey + exact_match works;
    contains_* operators are rejected for that attribute. chemical service with
    descriptor_type=SMILES, match_type=graph-relaxed returns both doxepin isomers (5EH, D7V).
  * AlphaFold DB: there is no "meanPlddt" field. `globalMetricValue` is the mean pLDDT
    (P35367: 69.94 vs 69.96 averaged from the per-residue confidence file).
  * Unknown accessions return 400 from AlphaFold and 404 from PubChem.

Mount from api/main.py with:  app.include_router(structures.router)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from functools import lru_cache
from pathlib import Path
from typing import Literal

import httpx
import polars as pl
from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel

log = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ARTIFACTS = Path(os.environ.get("ARTIFACT_DIR", ROOT / "artifacts"))
CACHE_DIR = Path(os.environ.get("CACHE_DIR", ROOT / "cache")) / "structures"

RCSB_SEARCH = "https://search.rcsb.org/rcsbsearch/v2/query"
RCSB_ENTRY = "https://data.rcsb.org/rest/v1/core/entry/{pdb_id}"
RCSB_FILE = "https://files.rcsb.org/download/{pdb_id}.cif"
PUBCHEM_SDF = "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/inchikey/{key}/SDF"
ALPHAFOLD_API = "https://alphafold.ebi.ac.uk/api/prediction/{uniprot_id}"

TIMEOUT = httpx.Timeout(10.0, connect=5.0)
MAX_LIGANDS = 5  # cap on stereo-relaxed ligand candidates searched for co-crystals

# Strict id formats for the file proxy, so it can never fetch arbitrary URLs or paths.
ID_PATTERNS = {
    "pubchem": re.compile(r"^[A-Z]{14}-[A-Z]{10}-[A-Z]$"),            # InChIKey
    "rcsb": re.compile(r"^[0-9][A-Za-z0-9]{3}$"),                      # PDB id
    "alphafold": re.compile(r"^[A-Z0-9]{6,10}$"),                      # UniProt accession
}
FILE_EXT = {"pubchem": "sdf", "rcsb": "cif", "alphafold": "pdb"}
MEDIA_TYPE = {"sdf": "chemical/x-mdl-sdfile", "cif": "chemical/x-cif", "pdb": "chemical/x-pdb"}


# ── schemas (architecture.md §9.2) ───────────────────────────────────────────

class DrugStructure(BaseModel):
    format: Literal["sdf"] = "sdf"
    file_url: str | None        # None → no 3D record; draw 2D from smiles
    smiles: str | None          # None for biologics with no small-molecule structure
    name: str


class ProteinStructure(BaseModel):
    source: Literal["PDB", "AlphaFold"]
    id: str                     # PDB id or AlphaFold entry id (AF-P35367-F1)
    format: Literal["cif", "pdb"]
    file_url: str
    uniprot_id: str
    gene_symbol: str
    mean_plddt: float | None    # AlphaFold only


class StructurePlan(BaseModel):
    mode: Literal["BOUND", "SEPARATE", "DRUG_ONLY", "NONE"]
    drug: DrugStructure
    protein: ProteinStructure | None
    ligand_comp_id: str | None              # only in BOUND mode
    ligand_match: Literal["exact", "stereo_relaxed"] | None = None
    # "stereo_relaxed": the PDB ligand has the drug's connectivity, but stereo was not
    # compared (e.g. one isomer of a racemic / E-Z mixture drug). UI should note this.
    resolution_A: float | None
    caption: str


# ── data (loaded directly from artifacts, same convention as Scorer) ─────────

class StructureLookup:
    """Just the drug and gene columns needed for structure lookups."""

    def __init__(self, artifacts: Path = DEFAULT_ARTIFACTS):
        a = Path(artifacts)
        drugs = pl.read_parquet(a / "drugs.parquet", columns=["drug_id", "name", "smiles", "inchi_key"])
        genes = pl.read_parquet(a / "genes.parquet", columns=["gene_id", "symbol", "uniprot_id"])
        self.drugs = {r["drug_id"]: r for r in drugs.iter_rows(named=True)}
        self.genes = {r["gene_id"]: r for r in genes.iter_rows(named=True)}


@lru_cache(maxsize=1)
def get_lookup() -> StructureLookup:
    return StructureLookup()


# ── disk cache ───────────────────────────────────────────────────────────────

def _cache_path(*parts: str) -> Path:
    p = CACHE_DIR.joinpath(*parts)
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


class _Upstream:
    """Tracks whether any external call failed (vs. returned 'not found'), so a
    transient outage never gets cached as a permanent 'no structure'."""

    def __init__(self, client: httpx.AsyncClient):
        self.client = client
        self.failed = False

    async def get(self, url: str, **kw) -> httpx.Response | None:
        try:
            r = await self.client.get(url, **kw)
        except httpx.HTTPError as e:
            log.warning("structures: GET %s failed: %s", url, e)
            self.failed = True
            return None
        if r.status_code >= 500 or r.status_code == 429:
            log.warning("structures: GET %s -> %s", url, r.status_code)
            self.failed = True
        return r

    async def search(self, body: dict) -> list[str]:
        """RCSB search; returns identifiers. HTTP 204 means zero hits."""
        try:
            r = await self.client.post(RCSB_SEARCH, json=body)
        except httpx.HTTPError as e:
            log.warning("structures: RCSB search failed: %s", e)
            self.failed = True
            return []
        if r.status_code == 204:
            return []
        if r.status_code != 200:
            log.warning("structures: RCSB search -> %s %s", r.status_code, r.text[:200])
            self.failed = r.status_code >= 500 or r.status_code == 429
            return []
        return [x["identifier"] for x in r.json().get("result_set", [])]


# ── external lookups ─────────────────────────────────────────────────────────

async def pubchem_has_3d(up: _Upstream, inchi_key: str) -> bool:
    """Fetch the PubChem 3D SDF and store it, so the file proxy never re-downloads it."""
    path = _cache_path("pubchem", f"{inchi_key}.sdf")
    if path.exists():
        return True
    r = await up.get(PUBCHEM_SDF.format(key=inchi_key), params={"record_type": "3d"})
    if r is None or r.status_code != 200 or "$$$$" not in r.text:
        return False
    path.write_text(r.text)
    return True


async def rcsb_ligands(up: _Upstream, inchi_key: str | None, smiles: str | None
                       ) -> tuple[list[str], Literal["exact", "stereo_relaxed"] | None]:
    """Chem comp ids for the drug: exact InChIKey first, then stereo-free SMILES graph match."""
    if inchi_key:
        ids = await up.search({
            "query": {"type": "terminal", "service": "text_chem", "parameters": {
                "attribute": "rcsb_chem_comp_descriptor.InChIKey",
                "operator": "exact_match", "value": inchi_key}},
            "return_type": "mol_definition"})
        if ids:
            return ids, "exact"
    if smiles:
        ids = await up.search({
            "query": {"type": "terminal", "service": "chemical", "parameters": {
                "value": smiles, "type": "descriptor", "descriptor_type": "SMILES",
                "match_type": "graph-relaxed"}},
            "return_type": "mol_definition",
            "request_options": {"return_all_hits": True}})
        if ids:
            return ids[:MAX_LIGANDS], "stereo_relaxed"
    return [], None


async def rcsb_best_cocrystal(up: _Upstream, uniprot_id: str, comp_ids: list[str]
                              ) -> tuple[str, str, float | None] | None:
    """Best-resolution entry holding both the UniProt chain and one of the ligands.
    Returns (pdb_id, comp_id, resolution)."""

    async def top_for(comp_id: str) -> tuple[str, str] | None:
        ids = await up.search({
            "query": {"type": "group", "logical_operator": "and", "nodes": [
                {"type": "terminal", "service": "text", "parameters": {
                    "attribute": "rcsb_polymer_entity_container_identifiers."
                                 "reference_sequence_identifiers.database_accession",
                    "operator": "exact_match", "value": uniprot_id}},
                {"type": "terminal", "service": "text", "parameters": {
                    "attribute": "rcsb_nonpolymer_instance_annotation.comp_id",
                    "operator": "exact_match", "value": comp_id}}]},
            "return_type": "entry",
            "request_options": {
                "sort": [{"sort_by": "rcsb_entry_info.resolution_combined", "direction": "asc"}],
                "paginate": {"start": 0, "rows": 1}}})
        return (ids[0], comp_id) if ids else None

    hits = [h for h in await asyncio.gather(*(top_for(c) for c in comp_ids)) if h]
    if not hits:
        return None

    async def resolution(pdb_id: str) -> float | None:
        r = await up.get(RCSB_ENTRY.format(pdb_id=pdb_id))
        if r is None or r.status_code != 200:
            return None
        res = (r.json().get("rcsb_entry_info") or {}).get("resolution_combined") or []
        return float(min(res)) if res else None

    resolutions = await asyncio.gather(*(resolution(p) for p, _ in hits))
    ranked = sorted(zip(hits, resolutions), key=lambda x: (x[1] is None, x[1] or 0.0))
    (pdb_id, comp_id), res = ranked[0]
    return pdb_id, comp_id, res


async def rcsb_best_apo(up: _Upstream, uniprot_id: str) -> tuple[str, float | None] | None:
    """Best-resolution experimental structure of this protein, whatever is bound to it.

    Only runs when no structure holds our own drug. A measured protein with
    somebody else's ligand in it, or nothing at all, still beats a prediction:
    the fold is observed rather than inferred. It says nothing about where our
    drug would go, so the plan stays SEPARATE and the caption says which it is.
    """
    ids = await up.search({
        "query": {"type": "terminal", "service": "text", "parameters": {
            "attribute": "rcsb_polymer_entity_container_identifiers."
                         "reference_sequence_identifiers.database_accession",
            "operator": "exact_match", "value": uniprot_id}},
        "return_type": "entry",
        "request_options": {
            "sort": [{"sort_by": "rcsb_entry_info.resolution_combined", "direction": "asc"}],
            "paginate": {"start": 0, "rows": 1}}})
    if not ids:
        return None
    pdb_id = ids[0]
    r = await up.get(RCSB_ENTRY.format(pdb_id=pdb_id))
    res = None
    if r is not None and r.status_code == 200:
        values = (r.json().get("rcsb_entry_info") or {}).get("resolution_combined") or []
        res = float(min(values)) if values else None
    return pdb_id, res


async def alphafold_entry(up: _Upstream, uniprot_id: str) -> dict | None:
    """AlphaFold DB prediction metadata, disk cached (also used by the file proxy)."""
    path = _cache_path("alphafold", f"{uniprot_id}.json")
    if path.exists():
        return json.loads(path.read_text()) or None
    r = await up.get(ALPHAFOLD_API.format(uniprot_id=uniprot_id))
    if r is None or r.status_code >= 500 or r.status_code == 429:
        return None                                    # transient: don't cache
    entries = r.json() if r.status_code == 200 else []
    # Prefer the canonical isoform's model for this accession.
    entry = next((e for e in entries if e.get("uniprotAccession") == uniprot_id), None)
    path.write_text(json.dumps(entry or {}))
    return entry


# ── plan ─────────────────────────────────────────────────────────────────────

def _file_url(src: str, id_: str) -> str:
    return f"/api/structures/file?src={src}&id={id_}"


def _drug_label(name: str | None, drug_id: str) -> str:
    return name.capitalize() if name else drug_id


async def build_structure_plan(drug_id: str, gene_id: str,
                               lookup: StructureLookup | None = None) -> StructurePlan:
    lookup = lookup or get_lookup()
    drug = lookup.drugs.get(drug_id)
    gene = lookup.genes.get(gene_id)
    if drug is None:
        raise KeyError(f"unknown drug_id {drug_id}")
    if gene is None:
        raise KeyError(f"unknown gene_id {gene_id}")

    plan_path = _cache_path("plans", f"{drug_id}__{gene_id}.json")
    if plan_path.exists():
        return StructurePlan.model_validate_json(plan_path.read_text())

    inchi_key, smiles = drug["inchi_key"], drug["smiles"]
    uniprot_id, symbol = gene["uniprot_id"], gene["symbol"] or gene_id
    drug_name = _drug_label(drug["name"], drug_id)

    async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True) as client:
        up = _Upstream(client)

        async def no_3d() -> bool:
            return False

        has_3d, (comp_ids, match) = await asyncio.gather(
            pubchem_has_3d(up, inchi_key) if inchi_key else no_3d(),
            rcsb_ligands(up, inchi_key, smiles) if uniprot_id else asyncio.sleep(0, ([], None)),
        )
        drug_s = DrugStructure(file_url=_file_url("pubchem", inchi_key) if has_3d else None,
                               smiles=smiles, name=drug_name)

        cocrystal = await rcsb_best_cocrystal(up, uniprot_id, comp_ids) if comp_ids else None
        if cocrystal:
            pdb_id, comp_id, res = cocrystal
            res_txt = f"{res:.1f} Å" if res is not None else "resolution n/a"
            plan = StructurePlan(
                mode="BOUND", drug=drug_s, ligand_comp_id=comp_id, ligand_match=match,
                resolution_A=res,
                protein=ProteinStructure(source="PDB", id=pdb_id, format="cif",
                                         file_url=_file_url("rcsb", pdb_id),
                                         uniprot_id=uniprot_id, gene_symbol=symbol,
                                         mean_plddt=None),
                caption=f"Experimental structure · PDB {pdb_id} · {res_txt} · "
                        f"{drug_name} bound to {symbol}")
        else:
            apo = await rcsb_best_apo(up, uniprot_id) if uniprot_id else None
            af = await alphafold_entry(up, uniprot_id) if uniprot_id else None
            if apo:
                pdb_id, res = apo
                res_txt = f"{res:.1f} Å" if res is not None else "resolution n/a"
                plan = StructurePlan(
                    mode="SEPARATE", drug=drug_s, ligand_comp_id=None, resolution_A=res,
                    protein=ProteinStructure(source="PDB", id=pdb_id, format="cif",
                                             file_url=_file_url("rcsb", pdb_id),
                                             uniprot_id=uniprot_id, gene_symbol=symbol,
                                             mean_plddt=None),
                    caption=f"Experimental structure · PDB {pdb_id} · {res_txt} · {symbol} "
                            f"measured without {drug_name}, so where it would bind is unknown")
            elif af and af.get("pdbUrl"):
                plddt = af.get("globalMetricValue")
                plddt_txt = f"{plddt:.1f}" if plddt is not None else "n/a"
                plan = StructurePlan(
                    mode="SEPARATE", drug=drug_s, ligand_comp_id=None, resolution_A=None,
                    protein=ProteinStructure(source="AlphaFold", id=af["entryId"], format="pdb",
                                             file_url=_file_url("alphafold", uniprot_id),
                                             uniprot_id=uniprot_id, gene_symbol=symbol,
                                             mean_plddt=plddt),
                    caption=f"Predicted structure (AlphaFold) · {symbol} · mean pLDDT {plddt_txt}"
                            f" · no experimental binding structure found")
            elif has_3d:
                why = "no protein structure found" if uniprot_id else "no UniProt mapping"
                plan = StructurePlan(
                    mode="DRUG_ONLY", drug=drug_s, protein=None, ligand_comp_id=None,
                    resolution_A=None,
                    caption=f"Computed 3D conformer (PubChem) · {drug_name} · {why} for {symbol}")
            else:
                plan = StructurePlan(
                    mode="NONE", drug=drug_s, protein=None, ligand_comp_id=None,
                    resolution_A=None,
                    caption=f"2D structure from SMILES · {drug_name} · no 3D structure available"
                    if smiles else f"No small-molecule structure available for {drug_name}")

        if not up.failed:
            plan_path.write_text(plan.model_dump_json())
        return plan


async def fetch_structure_file(src: str, id_: str) -> tuple[bytes, str]:
    """Return (bytes, ext) for one structure file, downloading once into the disk cache."""
    ext = FILE_EXT[src]
    path = _cache_path(src, f"{id_}.{ext}")
    if path.exists():
        return path.read_bytes(), ext

    async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True) as client:
        up = _Upstream(client)
        if src == "pubchem":
            if not await pubchem_has_3d(up, id_):        # writes the cache file itself
                raise FileNotFoundError(id_)
            return path.read_bytes(), ext
        if src == "rcsb":
            url = RCSB_FILE.format(pdb_id=id_.upper())
        else:
            af = await alphafold_entry(up, id_)
            if not af or not af.get("pdbUrl"):
                raise FileNotFoundError(id_)
            url = af["pdbUrl"]
        r = await up.get(url)
        if r is None or r.status_code != 200:
            raise FileNotFoundError(id_)
        path.write_bytes(r.content)
        return r.content, ext


# ── routes ───────────────────────────────────────────────────────────────────

router = APIRouter(prefix="/api/structures", tags=["structures"])


@router.get("", response_model=StructurePlan)
async def get_structure_plan(drug_id: str = Query(...), gene_id: str = Query(...)) -> StructurePlan:
    try:
        return await build_structure_plan(drug_id, gene_id)
    except KeyError as e:
        raise HTTPException(404, str(e).strip("'"))


@router.get("/file")
async def get_structure_file(src: Literal["pubchem", "rcsb", "alphafold"] = Query(...),
                             id: str = Query(...)) -> Response:
    if not ID_PATTERNS[src].match(id):
        raise HTTPException(400, f"invalid id for {src}")
    try:
        data, ext = await fetch_structure_file(src, id)
    except FileNotFoundError:
        raise HTTPException(404, f"no {src} structure for {id}")
    return Response(content=data, media_type=MEDIA_TYPE[ext],
                    headers={"Cache-Control": "public, max-age=86400"})
