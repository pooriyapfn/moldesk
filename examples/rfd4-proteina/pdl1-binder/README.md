# PD-L1 binder example

`binder.yaml` asks RFD4-Proteina to design a new 50-120 residue protein that binds the immune checkpoint
protein PD-L1 near three hotspot residues (Tyr56, Met115 and Tyr123 of the 5O45 numbering). It is the example from
the upstream guide [Design a binder in 10 lines](https://rfd4-proteina.org/latest/how-to/binder-in-10-lines.html);
only the `input` path differs (the structure sits beside the spec, as MoleculeDesk requires).

`5o45_cropped.cif.zst` is the unmodified file `docs/examples/inputs/5o45_cropped.cif.zst` from
[RosettaCommons/RFD4-Proteina](https://github.com/RosettaCommons/RFD4-Proteina) at commit
`bc004fe61811225b83ef5a815963dfed47dd3639` (tag v0.0.3), sha256
`95e2a099fac25dc93bac6d7073da0241d3616db997c0ba3a12a856dc9fa4acb8`. It holds PD-L1 chain A, residues 17-131 of PDB
entry 5O45 (115 residues, 924 atoms). It is redistributed under the upstream BSD 3-Clause license, reproduced as that
license requires:

```text
BSD 3-Clause License

Copyright (c) 2026, Institute for Protein Design, University of Washington

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the copyright holder nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

```bash
moldesk run rfd4-proteina examples/rfd4-proteina/pdl1-binder/binder.yaml \
  --param numReplicates=4 --param batchSize=4 --param seed=42
```

On Runpod (an NVIDIA L40S, 2026-10-26) the same run took 4-5 minutes and cost about $0.07-0.09 including the install
and download:

```bash
moldesk run rfd4-proteina examples/rfd4-proteina/pdl1-binder/binder.yaml --compute runpod --cache-policy ephemeral \
  --max-budget 3 --max-lifetime 3600 --accept-file-upload --param numReplicates=4 --param batchSize=4 --param seed=42
```

Upstream's cookbook asks for eight designs: `--param numReplicates=8 --param batchSize=8` took about 5 minutes and
$0.09 on the same GPU type (one run), and two of the eight have a binder-target atom pair closer than 2.2 Å.

The designs are computational candidates: no refolding or scoring is run, and binding needs experimental validation.
