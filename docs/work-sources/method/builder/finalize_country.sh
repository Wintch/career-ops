#!/bin/bash
# usage: finalize_country.sh CC "Country" ROWS AUDIT CAVKEYS DROPNAMES LANG(es|pt) TITLE
set -e
CC=$1; NAME=$2; ROWS=$3; AUD=$4; CAV=$5; DROP=$6; LANG=$7; TITLE=$8
S=${WORK_DIR:-.}   # directory holding the rows, audits and the scripts of builder/
cd $S
export SUPPORTED_HOSTS=supported-hosts.json
GROUP=lane CAVEATS=$CAV DROP_NAMES=$DROP python3 -I build_catalog.py $ROWS out-$CC $CC "$TITLE" $AUD | grep -v "^   (" | cut -c1-260
if [ "$LANG" = "pt" ]; then python3 -I localize_pt.py out-$CC out-$CC-l >/dev/null; SRC=out-$CC-l; else SRC=out-$CC; fi
python3 -I split_catalog.py $SRC/$CC.md out-$CC-split/trabajo $LANG
