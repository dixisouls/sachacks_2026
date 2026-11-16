// The demo diseases offered on the landing page and the search page.
//
// Chosen because the drug each one's tracks start from has a crystal structure
// with its own target protein, so the designed molecule can be placed in a
// measured pocket rather than only judged on its own. Kidney cancer is the
// strongest: both the approved and the not-approved track get a pocket, via
// bortezomib in PSMA6. All three also have thousands of associated genes, so
// the ranking the design starts from is well supported.
export const DEMO_DISEASES = [
  { disease_id: "MONDO_0002367", name: "Kidney cancer" },
  { disease_id: "EFO_0000519", name: "Glioblastoma" },
  { disease_id: "MONDO_0001056", name: "Gastric cancer" },
];
