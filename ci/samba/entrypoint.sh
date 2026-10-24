#!/bin/sh
set -e
id alice >/dev/null 2>&1 || useradd -M -s /usr/sbin/nologin alice
mkdir -p /srv/one /srv/two
chown alice /srv/one /srv/two
printf '%s\n%s\n' "$SMB_PASSWORD" "$SMB_PASSWORD" | smbpasswd -s -a alice >/dev/null
exec smbd --foreground --no-process-group --debug-stdout
