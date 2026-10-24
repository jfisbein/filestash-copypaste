# A throwaway Samba server for the integration test: user "alice", shares "one" and "two".
FROM debian:trixie-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends samba \
    && rm -rf /var/lib/apt/lists/*
COPY smb.conf /etc/samba/smb.conf
COPY entrypoint.sh /entrypoint.sh
EXPOSE 445
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
