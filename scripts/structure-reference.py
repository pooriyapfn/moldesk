#!/usr/bin/env python3
"""Independent reference values for `moldesk analyze` tests (Biopython, not Mol*).

    python3 scripts/structure-reference.py > packages/core/src/analysis/testdata/reference.json

Definitions mirror docs/analysis-json.md: first model; first alternate location (lowest id);
non-water, non-hydrogen atoms with a known element; mass-weighted centre and radius of gyration.
Sequences use the 20 standard amino acids and the standard DNA/RNA bases; anything else is `X`.
"""
import json
import math
import sys
import warnings
from pathlib import Path

from Bio.Data.IUPACData import atom_weights, protein_letters_3to1
from Bio.PDB import MMCIFParser, PDBParser
from Bio.PDB.Polypeptide import is_aa

warnings.simplefilter("ignore")

FIXTURES = Path(__file__).resolve().parent.parent / "packages" / "visualizer" / "test" / "fixtures"
NAMES = ["1CRN.pdb", "1CRN.cif", "1AAY.pdb", "1BNA.pdb", "1D3Z-3models.pdb", "1IGT-VH.pdb", "3HZ7.pdb"]
PROTEIN = {k.upper(): v for k, v in protein_letters_3to1.items()}
DNA = {"DA": "A", "DC": "C", "DG": "G", "DT": "T"}


def kept_atoms(residue):
    atoms = residue.get_unpacked_list()
    alts = sorted({a.get_altloc() for a in atoms if a.get_altloc().strip()})
    first = alts[0] if alts else ""
    return [a for a in atoms if not a.get_altloc().strip() or a.get_altloc() == first]


def analyze(path):
    parser = MMCIFParser(QUIET=True) if path.suffix == ".cif" else PDBParser(QUIET=True)
    model = next(iter(parser.get_structure("s", str(path))))
    sequences, waters = {}, 0
    total = 0.0
    com = [0.0, 0.0, 0.0]
    atoms = []
    for chain in model:
        seq, kind = "", None
        for residue in chain:
            hetflag = residue.id[0].strip()
            name = residue.get_resname().strip().upper()
            if hetflag == "W" or name in ("HOH", "WAT"):
                waters += 1
                continue
            letter = PROTEIN.get(name) if name in PROTEIN else None
            if letter is not None and hetflag == "":
                seq, kind = seq + letter, "protein"
            elif name in DNA and hetflag == "":
                seq, kind = seq + DNA[name], "dna"
            elif hetflag == "" or is_aa(residue, standard=False):
                seq, kind = seq + "X", kind or "protein"  # modified residue, e.g. MSE
            for atom in kept_atoms(residue):
                element = atom.element.strip().capitalize()
                if element in ("H", "D") or element not in atom_weights:
                    continue
                atoms.append((atom_weights[element], atom.coord))
        if seq:
            sequences[f"{chain.id}:{kind}"] = seq
    total = sum(m for m, _ in atoms)
    for m, c in atoms:
        for k in range(3):
            com[k] += m * c[k]
    com = [v / total for v in com]
    rg = math.sqrt(sum(m * sum((c[k] - com[k]) ** 2 for k in range(3)) for m, c in atoms) / total)
    return {"sequences": sequences, "waterResidues": waters, "centerOfMass": com, "radiusOfGyration": rg}


json.dump({name: analyze(FIXTURES / name) for name in NAMES}, sys.stdout, indent=2, sort_keys=True)
print()
