#!/bin/sh
set -eu

fixtures=$(cd "$(dirname "$0")/fixtures" && pwd)
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
cd "$scratch"

cc -std=c11 -Wall -Wextra -Werror "$fixtures/workspace-openat2.c" -o check-workspace
mkdir -p first/src second/src
printf '%s\n' 'first workspace' > first/src/sample.txt
printf '%s\n' 'second workspace' > second/src/sample.txt
ln -s ../second/src/sample.txt first/linked.txt
ln -s ../second/src first/swap
printf '%s\n' 'outside fixture' > second/private.txt
ln second/private.txt first/linked-copy.txt
mkfifo first/pipe

./check-workspace
