"""Name display rules. Run: python -m pytest tests/ -q

These are locked down because the rules are fiddly and a regression is silent:
a wrong name still renders, it just reads as sloppy to a reader who knows the
chemistry. Every case below came from a real name in the dataset.
"""

import pytest

from api.naming import _best_synonym, display_name, prettify


@pytest.mark.parametrize("raw,expected", [
    # ordinary drug names, shouted in the source data
    ("CETIRIZINE", "Cetirizine"),
    ("VALPROIC ACID", "Valproic Acid"),
    ("SODIUM CHLORIDE", "Sodium Chloride"),
    ("AMIFAMPRIDINE PHOSPHATE", "Amifampridine Phosphate"),
    ("ARBACLOFEN PLACARBIL", "Arbaclofen Placarbil"),
    # research codes keep their shape
    ("SGS-742", "SGS-742"),
    ("ME-344", "ME-344"),
    ("R-406", "R-406"),
    ("NV-128", "NV-128"),
    ("1400W", "1400W"),
    # acronyms stay shouted
    ("NADH", "NADH"),
    ("DNA", "DNA"),
    ("ATP", "ATP"),
    # chemical locants: numbers keep position, letter locants stay capital
    ("2-CHLOROPHENOL", "2-Chlorophenol"),
    ("N-ACETYLCYSTEINE", "N-Acetylcysteine"),
    ("D-GLUCOSE", "D-Glucose"),
    # greek letters and descriptors stay lowercase
    ("ALPHA-TOCOPHEROL", "alpha-Tocopherol"),
    ("GAMMA-AMINOBUTYRIC ACID", "gamma-Aminobutyric Acid"),
    ("TERT-BUTYL ALCOHOL", "tert-Butyl Alcohol"),
    # already mixed case: left exactly alone
    ("Di-Stearoyl-3-Sn-Phosphatidylethanolamine",
     "Di-Stearoyl-3-Sn-Phosphatidylethanolamine"),
    ("Pentazocine", "Pentazocine"),
])
def test_prettify(raw, expected):
    assert prettify(raw) == expected


def test_prettify_handles_empty():
    assert prettify("") == ""
    assert prettify(None) is None


@pytest.mark.parametrize("name,drug_id,synonyms,expected", [
    ("METFORMIN", "CHEMBL1431", ["Glucophage"], ("Metformin", "graph")),
    ("CHEMBL55555", "CHEMBL55555", ["Foobarinib", "a-much-longer-synonym-here"],
     ("Foobarinib", "synonym")),
    ("CHEMBL100109", "CHEMBL100109", [], ("CHEMBL100109", "chembl_id")),
    (None, "CHEMBL999", ["Thingamycin"], ("Thingamycin", "synonym")),
])
def test_display_name(name, drug_id, synonyms, expected):
    assert display_name(name, drug_id, synonyms) == expected


def test_best_synonym_rejects_junk():
    assert _best_synonym(["InChI=1S/C8H10", "CHEMBL123", "CAS-50-78-2"]) is None
    assert _best_synonym(["X", "Aspirin"]) == "Aspirin"          # too short rejected
    assert _best_synonym(["N1234567890123"]) is None             # too many digits
    assert _best_synonym([]) is None
    assert _best_synonym(None) is None


def test_display_name_never_returns_blank():
    """Whatever the input, something renderable comes back."""
    for name in (None, "", "CHEMBL1"):
        shown, _ = display_name(name, "CHEMBL1", None)
        assert shown
