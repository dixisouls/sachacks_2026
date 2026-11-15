"""Response schemas. These mirror what api/scoring.py already returns, so the
frontend can be built straight off this file (see architecture.md section 6.3)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Readiness = Literal["APPROVED_UNTESTED", "IN_TRIALS", "OFF_LABEL", "SAFETY_CONCERN",
                    "INVESTIGATIONAL", "WITHDRAWN"]
PathType = Literal["shared_biology", "sibling_disease", "chemical_analog", "protein_homolog"]
MatchType = Literal["exact", "synonym", "prefix", "substring", "synonym_substring"]


class Health(BaseModel):
    status: Literal["ok"]
    drugs: int
    approved_drugs: int
    diseases: int
    genes: int
    layers: dict[str, bool] = Field(description="which similarity layers are loaded")
    weights: dict[str, float]
    artifacts_built_at: str | None
    uptime_seconds: float


class DiseaseHit(BaseModel):
    disease_id: str
    name: str
    match_type: MatchType
    n_genes: int = Field(description="disease-gene edges; under 5 means weak coverage")
    therapeutic_areas: list[str]


class DiseaseSummary(BaseModel):
    disease_id: str
    name: str
    n_genes: int
    description: str | None
    therapeutic_areas: list[str]


class Candidate(BaseModel):
    rank: int = Field(description="rank within its own list, 1-based")
    drug_id: str
    drug_name: str | None
    score: int = Field(description="0-100, relative to the best drug across both lists")
    score_components: dict[str, float]
    lead_path: PathType | None
    inferred_only: bool = Field(
        description="supported only by similarity, with no direct graph path")
    readiness: Readiness
    approved: bool
    max_phase: float | None
    trial_phase: float | None
    trial_ids: list[str]
    top_gene_symbols: list[str]
    year_approved: int | None
    black_box: bool


class CandidatesResponse(BaseModel):
    disease: DiseaseSummary
    approved: list[Candidate] = Field(description="list 1: approved, not withdrawn")
    investigational: list[Candidate] = Field(description="list 2: everything else")
    excluded_count: int = Field(description="scored drugs dropped as already approved")
    already_approved_total: int
    family_size: int = Field(description="the disease plus its parents and descendants")
    weights: dict[str, float]
    layers: dict[str, bool]
    warning: str | None


class PathNode(BaseModel):
    id: str
    type: Literal["drug", "gene", "disease"]
    label: str | None
    uniprot_id: str | None = None


class PathEdge(BaseModel):
    source: str
    target: str
    relation: str
    weight: float | None
    citation: str | None
    inferred: bool


class PathStep(BaseModel):
    type: PathType
    nodes: list[str]
    contribution: float | None
    inferred: bool
    similarity: float | None = None
    explanation: str = Field(description="one plain sentence, safe to render as-is")


class PathsResponse(BaseModel):
    nodes: list[PathNode]
    edges: list[PathEdge]
    paths: list[PathStep]


class ErrorResponse(BaseModel):
    error: str
    detail: str
    request_id: str
