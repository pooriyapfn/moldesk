# RFD4-Proteina smoke test

`monomer.yaml` asks for one unconditioned 100-residue protein monomer, the smallest design
problem the model accepts. It is a compute/install smoke test, not a validated scientific
design. The condition spec is MoleculeDesk's own (MIT).

`monomer-short.cif` is the unmodified `examples/monomer.cif` from the model repository
[nvidia/RFD4-Proteina](https://huggingface.co/nvidia/RFD4-Proteina) at revision
`a06e2509c7033b010fc43614e9fd840303588502` (sha256
`2211795f856d1df247b828ed2362d5508726fd19d8b6c661417630857f35b8e1`). It is an annotated CIF
holding a 100-residue length request with no coordinates. It is redistributed under the
upstream BSD 3-Clause license, reproduced here as that license requires:

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
moldesk run rfd4-proteina examples/rfd4-proteina/monomer.yaml \
  --param numReplicates=1 --param seed=42 --param recycle=thinking_low
```

Requires a Linux/NVIDIA installation, or Runpod: add `--compute runpod --cache-policy ephemeral
--accept-file-upload` (the CIF next to the spec is uploaded). On Runpod the smoke test took about 2.7 minutes
and roughly $0.05 on an RTX 6000 Ada (2026-10-26). A random seed is chosen and recorded when `--param seed` is
omitted. Writing your own spec: see `models/rfd4-proteina/README.md`. RFD4-Proteina has been run on
Runpod only, not yet on a local Linux machine.
