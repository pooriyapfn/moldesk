"""Offline NPZ validation; never unpickles. Limits apply before array allocation.

At most 2,048 protein tokens, one numeric NPY member, 4 KiB header,
34 MiB archive and decompressed member. Scientific scoring stays in upstream.
"""
import json
import os
import sys
import struct
import zipfile
import numpy as np

CAP = 34 * 1024 * 1024


def load_array(file, key, shape):
    if os.path.getsize(file) > CAP:
        raise ValueError("archive exceeds 34 MiB")
    # Bound central-directory metadata before zipfile allocates ZipInfo objects.
    with open(file, "rb") as raw:
        raw.seek(max(0, os.path.getsize(file) - 65557))
        tail = raw.read(65557)
    at = tail.rfind(b"PK\x05\x06")
    if at < 0 or len(tail) - at < 22:
        raise ValueError("missing ZIP end record")
    disk, start_disk, on_disk, total, size, offset, comment = struct.unpack_from("<4H2IH", tail, at + 4)
    end_offset = os.path.getsize(file) - len(tail) + at
    if disk or start_disk or on_disk != 1 or total != 1 or size > 4096 or offset + size != end_offset or at + 22 + comment != len(tail):
        raise ValueError("unexpected ZIP directory, member count or ZIP64 archive")
    with zipfile.ZipFile(file) as archive:
        members = archive.infolist()
        if len(members) != 1 or members[0].filename != key + ".npy":
            raise ValueError("expected exactly one named NPY member")
        info = members[0]
        if info.file_size > CAP or info.compress_size > CAP or info.flag_bits & 1:
            raise ValueError("oversized/encrypted member")
        with archive.open(info) as stream:
            version = np.lib.format.read_magic(stream)
            width = 2 if version == (1, 0) else 4
            header_size = int.from_bytes(stream.read(width), "little")
            if header_size > 4096 or header_size > info.file_size:
                raise ValueError("oversized NPY header")
            stream.seek(8)
            if version == (1, 0):
                actual, fortran, dtype = np.lib.format.read_array_header_1_0(stream, max_header_size=4096)
            elif version == (2, 0):
                actual, fortran, dtype = np.lib.format.read_array_header_2_0(stream, max_header_size=4096)
            else:
                raise ValueError("unsupported NPY version")
            if actual != tuple(shape):
                raise ValueError("PAE_STRUCTURE_MISMATCH: array shape differs from token order")
            if dtype.kind not in "fiu" or dtype.itemsize > 8 or fortran:
                raise ValueError("invalid numeric dtype, shape or order")
            expected_bytes = int(np.prod(shape)) * dtype.itemsize
            if expected_bytes > CAP or stream.tell() + expected_bytes != info.file_size:
                raise ValueError("array size/header mismatch")
        with np.load(file, allow_pickle=False, max_header_size=4096) as data:
            array = data[key]
            if not np.isfinite(array).all() or (array < 0).any():
                raise ValueError("non-finite or negative values")
            if key == "plddt" and (array > 100).any():
                raise ValueError("pLDDT exceeds 100")
    return array


def main():
    count = int(sys.argv[1])
    if not 2 <= count <= 2048:
        raise ValueError("token count must be 2..2048")
    load_array("pae_prediction.npz", "pae", (count, count))
    if os.path.exists("plddt_prediction.npz"):
        load_array("plddt_prediction.npz", "plddt", (count,))
    print(json.dumps({"validatedTokens": count}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(2)
