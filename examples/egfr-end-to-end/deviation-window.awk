# Reads `moldesk compare --json` on stdin and prints "<first> <last>": the experimental (structure B) residue numbers
# that bound the run of WINDOW consecutive aligned pairs with the largest mean deviation, followed by that mean (Å).
#
#   moldesk compare pred.cif exp.cif --json | awk -v window=5 -f deviation-window.awk
#
# It relies on the CLI's pretty-printed JSON: `result.mapping[]` entries with a "b" object holding "authSeqId" and a
# "distance" key after it, and `mapping` closing with a `]` at four spaces of indentation.
BEGIN { n = 0 }
/^    "mapping": \[/ { inmap = 1; next }
inmap && /^    \]/ { inmap = 0 }
inmap && /^ *"b": \{/ { inb = 1; next }
inmap && inb && /"authSeqId":/ { split($0, parts, ":"); residue = parts[2] + 0; inb = 0; next }
inmap && /^ *"distance":/ { split($0, parts, ":"); residues[n] = residue; distances[n] = parts[2] + 0; n++ }
END {
  if (n == 0) { print "no aligned pairs in the input" > "/dev/stderr"; exit 1 }
  w = (window + 0 > 0 && window + 0 < n) ? window + 0 : n
  best = -1
  for (i = 0; i + w <= n; i++) {
    sum = 0
    for (k = i; k < i + w; k++) sum += distances[k]
    if (sum > best) { best = sum; first = residues[i]; last = residues[i + w - 1] }
  }
  printf "%d %d %.3f\n", first, last, best / w
}
