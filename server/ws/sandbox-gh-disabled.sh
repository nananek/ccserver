#!/usr/bin/env bash
# Bound over every discovered `gh` binary path inside the sandbox (see
# sandbox.js). gh CLI operations are out of scope for the git broker (its
# API calls go over TLS straight to api.github.com, so repo-scoping them
# would need TLS termination/MITM — deliberately not implemented), so gh is
# simply disabled here rather than left to inherit unrestricted host
# credentials.
echo "sandbox: gh is disabled inside the sandbox (use git directly; https/ssh git access is repo-scoped by the git broker)" >&2
exit 1
