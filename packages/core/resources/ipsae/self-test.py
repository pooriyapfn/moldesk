"""Deterministic two-chain fixture. d0=1; directional PAE 1/2 => ipSAE .5/.2."""
import json
import numpy as np

fields = "group_PDB id type_symbol label_atom_id label_alt_id label_comp_id label_seq_id auth_seq_id pdbx_PDB_ins_code label_asym_id Cartn_x Cartn_y Cartn_z occupancy label_entity_id auth_asym_id auth_comp_id B_iso_or_equiv pdbx_PDB_model_num".split()
with open("prediction.cif", "w") as out:
    out.write("data_prediction\nloop_\n" + "\n".join("_atom_site." + f for f in fields) + "\n")
    for i in range(4):
        chain = "A" if i < 2 else "B"
        for j, atom in enumerate(("CA", "CB")):
            out.write(f"ATOM {i*2+j+1} C {atom} . ALA {i%2+1} {i%2+1} ? {chain} {i%2*3} {i//2*4+j} 0 1 {i//2+1} {chain} ALA 90 1\n")
pae = np.zeros((4, 4), dtype=np.float32)
pae[:2, 2:] = 1
pae[2:, :2] = 2
np.savez_compressed("pae_prediction.npz", pae=pae)
with open("confidence_prediction.json", "w") as out:
    json.dump({"pair_chains_iptm": {"0": {"0": 1, "1": .8}, "1": {"0": .8, "1": 1}}}, out)
