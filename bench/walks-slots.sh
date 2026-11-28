#!/usr/bin/env bash
# One measurement of the walk slots (issue #180): bench/walks.mjs with 2, 1, 2, 1 slots on one tree.
# Run it from a COPY of the repo (it changes `walkSlots` in src/core/workspace.ts with sed), as
#   bench/walks-slots.sh <files> <results dir> <tree dir>
# bench.yml runs it on the runner and in a Docker container with --cpus 2.
set -euo pipefail
files=$1
results=$2
tree=$3
mkdir -p "$results"
{
  echo "files $files"
  echo "nproc $(nproc)"
  node --version
} | tee -a "$results/results.txt"
slots() { sed -i "s/walkSlots: [0-9]*,/walkSlots: $1,/" src/core/workspace.ts; grep -n "walkSlots" src/core/workspace.ts; }
# A first pass makes the tree and warms the file cache: its numbers are dropped, so no slot count has the warm cache alone.
slots 1
node --experimental-strip-types bench/walks.mjs --files "$files" --runs 1 --tree "$tree" > /dev/null 2>&1
pass=0
for s in 2 1 2 1; do
  pass=$((pass + 1))
  slots "$s"
  {
    echo
    echo "== pass $pass, walkSlots $s"
    node --experimental-strip-types bench/walks.mjs --files "$files" --runs 3 --tree "$tree"
  } 2>&1 | tee "$results/pass$pass-slots$s.txt" | tee -a "$results/results.txt"
done
echo
echo "== summary (median of every run of every pass of a slot count)"
node bench/walks-summary.mjs "$results" 2>&1 | tee -a "$results/results.txt"
