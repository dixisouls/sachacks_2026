// A saved three-track run, for when there is no backend to stream from.
//
// This is the offline snapshot, not a mock of convenience: the header says
// "Offline snapshot" whenever it is in use, and the numbers below are the
// shapes DESIGN_API.md promises, so the run view is exercised by the same
// reducer and the same components as a live run. The events are replayed on
// their own `at` timings, compressed, which is what makes the three tracks
// visibly interleave.
//
// The run deliberately includes a track that fails: a failed track must show
// its error without taking the other two down with it.

import { DEMO_DISEASES } from "../config";
import { EMPTY_WORKUP } from "../run";
import type { Attempt, Job, Pool, Protein, RunEvent, Seed, Track } from "../run";
import type { CheckStatus, DesignCheck, DesignEvaluation } from "../types";

const LABELS: Record<Pool, { label: string; blurb: string }> = {
  approved: {
    label: "Built on approved drugs",
    blurb: "Learns only from medicines already safe in people, so it starts from a real safety record.",
  },
  investigational: {
    label: "Built on compounds others dropped",
    blurb: "Learns from compounds that were tried and never approved, where the chemistry exists but the drug never arrived.",
  },
  all: {
    label: "Built on everything known",
    blurb: "Learns from both lists at once, approved or not, and is free to combine them.",
  },
};

const CBD = "CCCCCc1cc(O)c(C2CC(C)=CCC2C(C)=C)c(O)c1";
const TROFINETIDE = "CC(N)C(=O)N1CCCC1C(=O)NC(CCC(=O)O)C(=O)O";

const CHECK: Record<string, string> = {
  valid: "It is a real molecule",
  novel: "It is not an existing drug",
  makeable: "A chemist could make it",
  druglike: "It behaves like a drug",
  placed: "It sits in the pocket without clashing",
};

/** One evaluation, with every check passing except the one named. */
function evaluate(
  smiles: string,
  summary: string,
  bad: { id: string; status: CheckStatus; value: string; problem: string } | null,
  properties: DesignEvaluation["properties"] = {},
): DesignEvaluation {
  const ids = properties.pocket ? ["valid", "novel", "makeable", "druglike", "placed"] : ["valid", "novel", "makeable", "druglike"];
  const checks: DesignCheck[] = ids.map((id) => {
    if (bad && bad.id === id) {
      return { id, label: CHECK[id], status: bad.status, value: bad.value, detail: bad.problem, problem: bad.problem };
    }
    return {
      id,
      label: CHECK[id],
      status: "pass" as CheckStatus,
      value: PASS_VALUE[id],
      detail: PASS_VALUE[id],
      problem: "",
    };
  });
  const status: CheckStatus = bad ? bad.status : "pass";
  return { smiles, valid: true, status, summary, checks, properties };
}

const PASS_VALUE: Record<string, string> = {
  valid: "parses, one fragment",
  novel: "0.61 to its nearest drug",
  makeable: "3.4 of 10",
  druglike: "weight 332, logP 4.1",
  placed: "no overlapping atoms",
};

const PROTEINS: Protein[] = [
  { gene_id: "ENSG00000196689", symbol: "TRPV1", uniprot_id: "Q8NER1", has_structure: true, pdb_id: "5IRZ" },
  { gene_id: "ENSG00000178394", symbol: "HTR1A", uniprot_id: "P08908", has_structure: false, pdb_id: null },
  { gene_id: "ENSG00000135898", symbol: "GPR55", uniprot_id: "Q9Y2T6", has_structure: false, pdb_id: null },
];

const POCKET = { pdb_id: "5IRZ", clashes: 0, atoms: 24, rmsd: 0.41, core_atoms: 16, closest_A: 3.2 };

const SEED_CBD: Seed = {
  drug_id: "CHEMBL190461",
  name: "Cannabidiol",
  smiles: CBD,
  score: 71,
  check: evaluate(CBD, "Clears every check, as an approved medicine generally does.", null),
};

const SEED_TROFINETIDE: Seed = {
  drug_id: "CHEMBL2109448",
  name: "Trofinetide",
  smiles: TROFINETIDE,
  score: 64,
  check: evaluate(TROFINETIDE, "Clears every check except ease of synthesis.", {
    id: "makeable",
    status: "warn",
    value: "6.1 of 10",
    problem: "A peptide, so it is harder to make than a small molecule",
  }),
};

interface Spec {
  pool: Pool;
  id: string;
  round: number;
  name: string;
  smiles: string;
  rationale: string;
  builds_on: string;
  summary: string;
  bad: { id: string; status: CheckStatus; value: string; problem: string } | null;
  placed: boolean;
  proposed: number;
  judged: number;
}

const SPECS: Spec[] = [
  {
    pool: "approved",
    id: "a1",
    round: 1,
    name: "CBD-F1",
    smiles: "CCCCCc1cc(O)c(C2CC(C)=CCC2C(C)=C)c(O)c1F",
    rationale:
      "A fluorine on the ring should slow the oxidation that gives cannabidiol its short half-life, without touching the part that sits in the pocket.",
    builds_on: "Cannabidiol",
    summary: "Too close to cannabidiol itself to count as a new molecule.",
    bad: { id: "novel", status: "fail", value: "0.94 to cannabidiol", problem: "Almost the starting drug again" },
    placed: true,
    proposed: 7.4,
    judged: 9.1,
  },
  {
    pool: "approved",
    id: "a2",
    round: 2,
    name: "CBD-M2",
    smiles: "CCCCCc1cc(OC)c(C2CC(C)=CCC2C(C)=C)c(O)c1",
    rationale:
      "Capping one phenol as a methyl ether keeps the shape but removes a hydrogen bond donor, which is where the last attempt lost its novelty.",
    builds_on: "CBD-F1",
    summary: "Passes, but the lost hydroxyl is the one that reaches the pocket wall.",
    bad: {
      id: "placed",
      status: "warn",
      value: "one atom within 2.1 Å",
      problem: "One atom sits closer to the protein than a contact should",
    },
    placed: true,
    proposed: 21.8,
    judged: 24.2,
  },
  {
    pool: "approved",
    id: "a3",
    round: 3,
    name: "CBD-A7",
    smiles: "CCCCc1cc(O)c(C2CC(C)=CCC2C(C)=C)c(O)c1C(=O)N",
    rationale:
      "A primary amide on the ring and one carbon off the tail: the amide gives back the hydrogen bond the ether took away, and the shorter tail pulls the weight back under 350.",
    builds_on: "CBD-M2",
    summary: "Clears every check, and nothing overlaps the protein.",
    bad: null,
    placed: true,
    proposed: 38.6,
    judged: 41.3,
  },
  {
    pool: "all",
    id: "c1",
    round: 1,
    name: "CBD-N4",
    smiles: "CCCCCc1cc(O)c(C2CC(C)=CCC2C(C)=C)c(O)c1C#N",
    rationale:
      "A nitrile borrowed from the investigational list, which used it to hold the same ring in place without adding weight.",
    builds_on: "Cannabidiol",
    summary: "A chemist would struggle to put a nitrile there.",
    bad: { id: "makeable", status: "fail", value: "8.2 of 10", problem: "No routine route to this substitution" },
    placed: true,
    proposed: 11.2,
    judged: 13.9,
  },
  {
    pool: "all",
    id: "c2",
    round: 2,
    name: "CBD-H9",
    smiles: "OCCCCCc1cc(O)c(C2CC(C)=CCC2C(C)=C)c(O)c1",
    rationale:
      "A hydroxyl at the end of the tail instead, which is a one-step change from cannabidiol and the same trick two dropped compounds used to cut logP.",
    builds_on: "CBD-N4",
    summary: "Clears every check.",
    bad: null,
    placed: true,
    proposed: 29.4,
    judged: 32.0,
  },
  {
    pool: "investigational",
    id: "b1",
    round: 1,
    name: "TFN-C3",
    smiles: "CC(N)C(=O)N1CCCC1C(=O)NC(CCC(=O)O)C(=O)NC",
    rationale: "Capping the free acid as a methylamide, the usual first move to get a peptide past the gut.",
    builds_on: "Trofinetide",
    summary: "Still a peptide, and no easier to make than the one it came from.",
    bad: { id: "makeable", status: "fail", value: "7.4 of 10", problem: "Four coupling steps with a protecting group" },
    placed: false,
    proposed: 10.1,
    judged: 12.4,
  },
];

function attemptOf(spec: Spec): Attempt {
  return {
    id: spec.id,
    track: spec.pool,
    round: spec.round,
    name: spec.name,
    rationale: spec.rationale,
    builds_on: spec.builds_on,
    check: evaluate(spec.smiles, spec.summary, spec.bad, {
      formula: "C21H29NO3",
      mol_weight: 343.5,
      logp: 3.9,
      qed: 0.62,
      sa_score: 3.4,
      parent_similarity: 0.61,
      ...(spec.placed ? { pocket: POCKET } : {}),
    }),
  };
}

const ATTEMPTS = SPECS.map(attemptOf);
const attemptFor = (id: string) => ATTEMPTS.find((a) => a.id === id)!;

const SYNTHESIS = {
  difficulty: "3.4 of 10, routine medicinal chemistry",
  steps: [
    { n: 1, what: "Brominate the free ring position of cannabidiol", why: "Opens the position the amide has to go on" },
    { n: 2, what: "Palladium-catalysed carbonylation under ammonia", why: "Puts the primary amide on directly" },
    { n: 3, what: "Shorten the pentyl tail by one carbon", why: "Brings the weight back under 350" },
  ],
  note: "Three steps from a compound you can buy. The difficulty score is computed from the structure, not estimated by the model.",
};

// Six items, in the order the backend emits them.
const ADMET = {
  items: [
    { label: "Size", value: "343 daltons", status: "pass" as CheckStatus, detail: "Comfortably under the 500 that usually costs a molecule its oral absorption." },
    { label: "Greasiness", value: "cLogP 3.9", status: "pass" as CheckStatus, detail: "Greasy, but inside the range approved drugs occupy." },
    { label: "Polar surface", value: "66 Å²", status: "pass" as CheckStatus, detail: "Low enough to cross a membrane, high enough to dissolve." },
    { label: "Hydrogen-bond donors", value: "3", status: "warn" as CheckStatus, detail: "The amide adds a third donor, and three is where brain penetration starts to suffer." },
    { label: "Flexibility", value: "6 rotatable bonds", status: "pass" as CheckStatus, detail: "Rigid enough to bind one shape rather than many." },
    { label: "Reaches the brain", value: "likely, CNS MPO-style 4.8 of 6", status: "pass" as CheckStatus, detail: "Two of the six terms are substituted, because nothing here predicts pKa: cLogP stands in for logD, and the acid-base term is scored from whether a basic centre is present at all." },
  ],
  note: "Every number here is computed from the structure. None of it is measured, and none of it is a substitute for an assay.",
};

const OFFTARGET = {
  items: [
    { symbol: "TRPV2", uniprot_id: "Q9Y5S1", identity: 0.49, concern: "Close enough to hit. TRPV2 sits in mast cells, so hitting it would show up as an immune effect." },
    { symbol: "TRPV3", uniprot_id: "Q8NET8", identity: 0.43, concern: "Skin and hair follicles. An effect here would be visible rather than dangerous." },
  ],
  note: "Sequence identity to the target, from the protein similarity matrix. It says which proteins could plausibly be hit, not which are.",
};

/** The honest negative: an empty list that means the data has a gap. */
const OFFTARGET_NONE = {
  items: [],
  note: "No relative of this target passed the 40% identity and 60% coverage cutoff the similarity table was built with, and only disease-associated proteins were searched. An empty list here is a gap in the data, not evidence that the molecule is selective.",
};

const CASE = {
  verdict: "Worth making, and worth nothing until someone measures whether it binds.",
  for: [
    "Three steps from a compound you can buy, with no unusual chemistry",
    "Keeps the part of cannabidiol that sits in the pocket and changes only what is exposed",
    "Lighter and less greasy than the drug it came from, which is cannabidiol's main problem",
  ],
  against: [
    "Nothing here tests binding. No assay was run and none could be.",
    "163 of 200 random molecules pass these same checks, so passing them is a low bar.",
    "The pocket picture is a placement onto cannabidiol's measured position, not a docking: nothing searched for a better pose and the protein could not move.",
    "Two phenols remain, so the metabolic problem that limits cannabidiol may limit this too.",
  ],
  next_step: "A TRPV1 binding assay against cannabidiol as the control. One plate, and it either binds or it does not.",
};

function trackOf(pool: Pool, done: boolean): Track {
  const specs = SPECS.filter((s) => s.pool === pool);
  const attempts = specs.map((s) => attemptFor(s.id));
  const best = pool === "approved" ? attemptFor("a3") : pool === "all" ? attemptFor("c2") : null;
  const failed = pool === "investigational";
  return {
    pool,
    ...LABELS[pool],
    status: done ? (failed ? "error" : "done") : "waiting",
    seed: done ? (failed ? SEED_TROFINETIDE : SEED_CBD) : null,
    studied: pool === "approved" ? { approved: 48, investigational: 0 } : pool === "investigational" ? { approved: 0, investigational: 23 } : { approved: 48, investigational: 23 },
    pocket: done && !failed ? { pdb_id: "5IRZ", resolution_A: 2.6 } : null,
    proteins: done && !failed ? PROTEINS : [],
    attempts: done ? [...attempts].sort((a, b) => rank(a) - rank(b)) : [],
    best: done ? best : null,
    workup:
      done && pool === "approved"
        ? { synthesis: SYNTHESIS, admet: ADMET, offtarget: OFFTARGET, case: CASE }
        : done && pool === "all"
          ? { ...EMPTY_WORKUP, synthesis: SYNTHESIS, offtarget: OFFTARGET_NONE, case: CASE }
          : null,
    error: done && failed ? "Gemini returned no parsable molecule for two rounds running, so this track was stopped." : null,
  };
}

const ORDER: Record<CheckStatus, number> = { pass: 0, warn: 1, fail: 2 };
const rank = (a: Attempt) => ORDER[a.check.status] * 10 - a.round;

/** The run as a list of events, in the order they happened. */
function events(): RunEvent[] {
  const raw: Omit<RunEvent, "i">[] = [];
  const push = (e: Omit<RunEvent, "i">) => raw.push(e);

  push({ type: "phase", at: 0.4, text: "Reading the disease, its genes and the drugs already ranked for it" });
  push({ type: "phase", at: 1.6, text: "Three tracks starting at once" });

  push({ type: "seed", at: 2.1, track: "approved", seed: SEED_CBD });
  push({ type: "seed", at: 2.4, track: "all", seed: SEED_CBD });
  push({ type: "seed", at: 2.9, track: "investigational", seed: SEED_TROFINETIDE });

  push({
    type: "pocket",
    at: 3.8,
    track: "approved",
    text: "Cannabidiol was measured inside TRPV1 at 2.6 Å, so designs can be placed into that pocket.",
    pocket: { pdb_id: "5IRZ", resolution_A: 2.6 },
    proteins: PROTEINS,
  });
  push({
    type: "pocket",
    at: 4.1,
    track: "all",
    text: "Same seed, same measured pocket: TRPV1 at 2.6 Å.",
    pocket: { pdb_id: "5IRZ", resolution_A: 2.6 },
    proteins: PROTEINS,
  });
  push({
    type: "pocket",
    at: 4.6,
    track: "investigational",
    text: "No co-crystal structure exists for trofinetide, so nothing in this track can be placed in a pocket.",
    proteins: [
      { gene_id: "ENSG00000017427", symbol: "IGF1", uniprot_id: "P05019", has_structure: false, pdb_id: null },
    ],
  });

  // Round one, all three at once.
  push({ type: "round", at: 5.0, track: "approved", n: 1, of: 3 });
  push({ type: "round", at: 5.2, track: "all", n: 1, of: 3 });
  push({ type: "round", at: 5.4, track: "investigational", n: 1, of: 3 });
  push({ type: "thinking", at: 6.0, track: "approved", text: "Cannabidiol's problem is not its shape, it is how fast the body clears it." });
  push({
    type: "thinking",
    at: 6.8,
    track: "approved",
    text: "Cannabidiol's problem is not its shape, it is how fast the body clears it. The two phenols are what get glucuronidated, so the question is which of them can go.",
  });
  push({ type: "thinking", at: 7.0, track: "investigational", text: "Trofinetide is a tripeptide, so anything built on it inherits a peptide's problems." });

  for (const spec of SPECS) {
    push({
      type: "molecule",
      at: spec.proposed,
      track: spec.pool,
      id: spec.id,
      round: spec.round,
      name: spec.name,
      smiles: spec.smiles,
      rationale: spec.rationale,
      builds_on: spec.builds_on,
    });
    const attempt = attemptFor(spec.id);
    push({
      type: "verdict",
      at: spec.judged,
      track: spec.pool,
      id: spec.id,
      status: attempt.check.status,
      summary: attempt.check.summary,
      check: attempt.check,
    });
  }

  push({
    type: "reasoning",
    at: 9.6,
    track: "approved",
    round: 1,
    text: "Fluorine was the wrong first move: it slows oxidation but leaves the molecule indistinguishable from cannabidiol.",
  });
  push({ type: "round", at: 14.0, track: "approved", n: 2, of: 3 });
  push({ type: "round", at: 15.0, track: "all", n: 2, of: 3 });

  // The investigational track gives up, and the other two carry on.
  push({ type: "round", at: 16.2, track: "investigational", n: 2, of: 3 });
  push({ type: "note", at: 17.4, track: "investigational", text: "Nothing parsable came back. Asking once more." });
  push({
    type: "error",
    at: 19.8,
    track: "investigational",
    text: "Gemini returned no parsable molecule for two rounds running, so this track was stopped.",
  });

  push({ type: "thinking", at: 20.2, track: "approved", text: "Cap one phenol, keep the other. The one facing the solvent is the one to lose." });
  push({
    type: "reasoning",
    at: 25.0,
    track: "approved",
    round: 2,
    text: "Capping the phenol worked for novelty and cost a contact in the pocket. The next one has to give that contact back.",
  });
  push({ type: "round", at: 34.0, track: "approved", n: 3, of: 3 });
  push({ type: "thinking", at: 35.2, track: "approved", text: "An amide can make the same hydrogen bond the phenol made, and it is not a phenol." });

  push({ type: "best", at: 33.0, track: "all", id: "c2", name: "CBD-H9" });
  push({ type: "best", at: 42.5, track: "approved", id: "a3", name: "CBD-A7" });

  // The workup, on the winner, section by section.
  push({ type: "workup_step", at: 34.0, track: "all", step: 1, kind: "synthesis", label: "Working out how to make it", status: "running" });
  push({ type: "workup_step", at: 37.5, track: "all", step: 1, kind: "synthesis", label: "Working out how to make it", status: "done" });
  push({ type: "workup", at: 37.6, track: "all", kind: "synthesis", data: SYNTHESIS });
  push({ type: "workup_step", at: 37.8, track: "all", step: 2, kind: "admet", label: "What the body would do to it", status: "running" });
  push({
    type: "workup_step",
    at: 40.0,
    track: "all",
    step: 2,
    kind: "admet",
    label: "What the body would do to it",
    status: "error",
    text: "The model returned prose that did not parse against the six computed properties.",
  });
  push({ type: "workup_step", at: 40.1, track: "all", step: 3, kind: "offtarget", label: "What else it might hit", status: "running" });
  push({ type: "workup_step", at: 40.6, track: "all", step: 3, kind: "offtarget", label: "What else it might hit", status: "done" });
  push({ type: "workup", at: 40.7, track: "all", kind: "offtarget", data: OFFTARGET_NONE });
  push({ type: "workup_step", at: 40.9, track: "all", step: 4, kind: "case", label: "The case for taking it forward", status: "running" });
  push({ type: "workup_step", at: 43.0, track: "all", step: 4, kind: "case", label: "The case for taking it forward", status: "done" });
  push({ type: "workup", at: 43.1, track: "all", kind: "case", data: CASE });
  push({ type: "track_done", at: 43.6, track: "all", tried: 2, accepted: 1 });

  const steps: [number, "synthesis" | "admet" | "offtarget" | "case", string, number, unknown][] = [
    [1, "synthesis", "Working out how to make it", 43.0, SYNTHESIS],
    [2, "admet", "What the body would do to it", 47.0, ADMET],
    [3, "offtarget", "What else it might hit", 51.0, OFFTARGET],
    [4, "case", "The case for taking it forward", 55.0, CASE],
  ];
  for (const [step, kind, label, at, data] of steps) {
    push({ type: "workup_step", at: at - 3.4, track: "approved", step, kind, label, status: "running" });
    push({ type: "workup_step", at, track: "approved", step, kind, label, status: "done" });
    push({ type: "workup", at: at + 0.1, track: "approved", kind, data });
  }
  push({ type: "track_done", at: 56.0, track: "approved", tried: 3, accepted: 1 });
  push({ type: "done", at: 56.4, tried: 6, accepted: 2 });

  // Sorting by time and then numbering keeps both invariants the contract
  // promises: `at` never goes backwards and `i` never repeats.
  return raw.sort((a, b) => a.at - b.at).map((e, i) => ({ ...e, i }));
}

function job(diseaseId: string, done: boolean, list: RunEvent[]): Job {
  const disease = DEMO_DISEASES.find((d) => d.disease_id === diseaseId);
  return {
    job_id: "snapshot",
    status: done ? "done" : "running",
    disease_id: diseaseId,
    disease_name: disease?.name ?? "Rett syndrome",
    tracks: {
      approved: trackOf("approved", done),
      investigational: trackOf("investigational", done),
      all: trackOf("all", done),
    },
    events: list,
    random_pass_rate: 0.815,
    error: null,
    cached: true,
  };
}

/** The saved run: what to show first, what to replay, and where it ends up. */
export function fixtureJob(diseaseId: string): { initial: Job; events: RunEvent[]; final: Job } {
  const list = events();
  return { initial: job(diseaseId, false, []), events: list, final: job(diseaseId, true, list) };
}
