# syntax=docker/dockerfile:1
# One image, both services. The operator and the reconciler differ only in their command: same code,
# same interpreter versions, same pinned py_ecc. A seat whose signer and whose NAV attribution came
# from different bases is a seat that can disagree with itself.
#
# Digest-pinned, not tag-pinned. `node:22-bookworm-slim` moves; this exact image does not, so two
# operators building a month apart get the same base rather than two silently different ones.
FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

# py_ecc is PINNED: signing shells out to signer.py, and an upgrade that changed serialisation would
# break signatures on this seat alone while the rest of the set kept working — a minority fault that
# reads as a flaky operator rather than a version skew.
ARG PY_ECC_VERSION=8.0.0
# Matches foundry.toml's pinned forge 1.5.1, so the cast that reads chains here is the cast the
# project is tested against. "stable" would drift.
ARG FOUNDRY_VERSION=1.5.1

# util-linux is for flock(1) -- see the CMD at the bottom for why the signature log needs it.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv ca-certificates curl git util-linux \
    && rm -rf /var/lib/apt/lists/*

# PEP 668 blocks a system-wide pip on bookworm, so the venv is not optional.
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir "py_ecc==${PY_ECC_VERSION}" \
    && /opt/venv/bin/python3 -c "import py_ecc"

# Foundry installs to $HOME/.foundry/bin, i.e. /root here — mode 0700, so the non-root runtime user
# could not read it and every chain read would fail with "cast: not found". Move the one binary we
# need to /usr/local/bin, which is on the default PATH for every user and needs no PATH juggling.
# Checksums are the GitHub release asset digests for v1.5.1, checked into the source.
# No downloaded installer is executed. A version bump requires reviewing new digests.
RUN set -eu; [ "$FOUNDRY_VERSION" = "1.5.1" ]; \
    arch=$(dpkg --print-architecture); \
    case "$arch" in \
      amd64) sum=73640b01bd9ed29fdb4965085099371f8cf0dbbec3e2086cf54564efc4dcfe88 ;; \
      arm64) sum=cccf28bdf202289e837a9e21ed213b2b80dc1e806e12f1717bc98a44315c331e ;; \
      *) echo "unsupported cast architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl --fail --location --retry 3 --connect-timeout 15 --max-time 120 \
      "https://github.com/foundry-rs/foundry/releases/download/v${FOUNDRY_VERSION}/foundry_v${FOUNDRY_VERSION}_linux_${arch}.tar.gz" \
      -o /tmp/foundry.tar.gz; \
    printf '%s  /tmp/foundry.tar.gz\n' "$sum" | sha256sum -c -; \
    tar -xzf /tmp/foundry.tar.gz -C /usr/local/bin cast; \
    chmod 0755 /usr/local/bin/cast; rm /tmp/foundry.tar.gz; \
    version=$(cast --version); \
    case "$version" in "cast Version: ${FOUNDRY_VERSION}-"*) ;; *) echo "unexpected cast version" >&2; exit 1 ;; esac
# BOTH, and the PATH entry is the load-bearing one. Code that shells out reads $PYTHON, but a
# HUMAN following docs/ONBOARD.md types `python3` -- and with only $PYTHON set that resolved to
# /usr/bin/python3, which has no py_ecc, so the documented keygen command died with
# ModuleNotFoundError on an external operator's first attempt (dry run, 2026-08-22). The image built
# and every service worked, because the services read $PYTHON; only the documented command was
# broken. Putting the venv first on PATH makes `python3` mean the same interpreter everywhere,
# which is what compose.yaml's tools service already claims.
ENV PATH=/opt/venv/bin:$PATH
ENV PYTHON=/opt/venv/bin/python3

WORKDIR /app
COPY package.json package-lock.json ./
# npm ci, not npm install: it installs exactly the lockfile and fails if package.json disagrees.
# An operator's dependency tree should be identical to the one this was tested with.
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .

# Non-root. Whoever can read the BLS key can sign as this operator, so the process holding it should
# not also be able to rewrite its own code.
#
# Every mount point is created AND owned here. Docker gives a fresh named volume the ownership of the
# image path it covers — so a directory that does not exist in the image becomes root-owned and the
# runtime user cannot write it. That is silent until the first write: the reconciler cannot save
# cursors, or the operator cannot append to its signature log, and neither failure names the cause.
# Named `ditto`, not `operator`: Debian ships a legacy system group called `operator` (gid 37), so
# `useradd --system operator` collides with it and fails the build. CI found this on the first real
# docker build -- it is invisible from the Dockerfile alone.
RUN groupadd --system --gid 10001 ditto \
    && useradd --system --uid 10001 --gid 10001 --home-dir /app --shell /usr/sbin/nologin ditto \
    && mkdir -p /var/lib/ditto-operator /sigs /config \
    && chown -R ditto:ditto /var/lib/ditto-operator /sigs /config \
    && chown -R root:root /app && chmod -R go-w /app

USER ditto
EXPOSE 4000
# A native process defaults to loopback. The image's default command opts into the container
# interface so `docker run -p` works, while utility commands and `npm test` retain the secure native
# default. `exec` keeps Node as PID 1; Compose may still override OPERATOR_LISTEN_HOST explicitly.
#
# ONE WRITER, enforced by the kernel. The signature log is this seat's anti-equivocation evidence:
# it is what makes a retry of the same round return the same signature instead of producing a second
# one over different content. Two processes on the same file each hold their own sql.js snapshot in
# memory and export it whole, so the one that writes last silently erases the other's record -- and
# the seat then equivocates without any component reporting a fault.
#
# flock(1) rather than a lockfile the program manages: the kernel releases the lock when the holding
# process dies, so a hard crash or `kill -9` cannot leave a stale lock that needs a human to clear,
# and no timeout can steal the lock from a process that is still alive. -n makes a second start fail
# immediately instead of queueing behind the first, which is the difference between a clear error
# and a container that looks like it is starting forever. The lock file sits beside the database on
# the same local volume: flock's semantics over NFS are not something to rely on here.
#
# --no-fork is load-bearing, not tidiness. Without it flock forks and waits, so flock is PID 1 and
# node is its child; flock does not forward signals, and `docker stop` would then kill the supervisor
# while node kept running until the timeout. With it, flock execs node directly and node inherits the
# open descriptor that holds the lock -- node is PID 1, signals reach it, and the kernel drops the
# lock when node exits however it exits.
CMD ["sh", "-c", "OPERATOR_LISTEN_HOST=${OPERATOR_LISTEN_HOST:-0.0.0.0} exec flock --no-fork -n \"${PARTIAL_SIG_DB:-/sigs/partial-sigs.db}.lock\" node ops/operator/server.mjs"]
