#!/bin/bash
# Dump the appliance database to a file outside the live data volume.
set -euo pipefail
dest="${1:-/tmp/factorix-backup.dump}"
su postgres -c "/usr/lib/postgresql/17/bin/pg_dump -d factorix -Fc -f $dest"
echo "$dest"
