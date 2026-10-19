FROM docker.io/cloudflare/sandbox:0.12.9@sha256:4a56a37a3cfd9b38d65bb4b5d0b341e6490a3a4c0226274ae4c1cca4948e85fe

# cloudflare/sandbox's server and backup tools (mksquashfs, fuse-overlayfs)
# expect to run as root inside the container. The user-facing toolchain is
# still isolated by the Sandbox runtime, so running as root here is correct.
RUN npm install -g pnpm@12.4.2 wrangler@4.133.0

# Checks-in-pipeline toolchain: repos run their own check commands in this
# image — Go for veil's make ci, git for diff-coverage's HEAD^1 compare.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates postgresql make \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL "https://go.dev/dl/go1.24.5.linux-$(dpkg --print-architecture | sed 's/amd64/amd64/;s/arm64/arm64/').tar.gz" \
    -o /tmp/go.tgz && tar -C /usr/local -xzf /tmp/go.tgz && rm /tmp/go.tgz
ENV PATH="$PATH:/usr/local/go/bin:/root/go/bin"
