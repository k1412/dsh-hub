# Contributing

English | [中文](CONTRIBUTING.zh.md)

DSH Hub accepts focused issues and pull requests. The repository is a fork of DeepSeek Harness: Hub code is maintained here, while a change intended for upstream DSH should be isolated from Hub-specific work and proposed to the upstream project under its contribution policy.

## Product invariants

Contributions must preserve these boundaries:

- Hub is a single-user, full-authority control plane. Enrolled nodes do not add a second interactive approval layer.
- Hub is not a DSH runtime and has no local execution mode or Hub-side DSH plugin host.
- Nodes connect outbound; Connector does not expose or proxy the DSH Web listener.
- Connector, local Web, and desktop clients share the existing DSH runtime and session owner.
- Node data remains authoritative; Hub stores control state and explicit artifacts, not a transparent content mirror.
- A node never supplies executable JavaScript to the authenticated Hub browser origin.

A product that intentionally changes the full-authority contract, adds node confirmation, or runs DSH inside Hub should be maintained as a separate fork rather than submitted as a behavior change here.

## Before opening a pull request

Open or reference an issue for a behavioral change. Create a topic branch from current `master`, keep unrelated upstream and Hub changes in separate commits or pull requests, and do not rewrite generated or vendored material without following its owning workflow.

Never commit credentials, enrollment codes, Access tokens, private keys, personal identifiers, or deployment-specific hostnames and addresses. Use generic examples in public documentation and `.env.example`; keep live configuration in the deployment secret store.

Every non-trivial change adds or updates an [Agent Note](.agents/notes/README.md). English and Chinese documents change together, retain identical structure and link targets, and refresh their `.i18n.yaml` record.

## Validation

Run the narrowest package tests while developing, then run the Hub gates before requesting review:

```sh
pnpm install --frozen-lockfile
pnpm run hub:typecheck
pnpm run hub:lint
pnpm run hub:test
pnpm run hub:web:build
pnpm run test:gui
DSH_SNAPSHOT=replay pnpm run test:web
pnpm run hub:release:pack
pnpm run hub:release:verify
pnpm run doc-sync
```

Protocol, authentication, storage, plugin transaction, snapshot, terminal, or recovery changes require tests for malformed input and failure behavior in addition to the successful path. Connector changes require a real Cordis Loader composition test and must preserve local Web and desktop coexistence. Deployment changes require a Linux AMD64 container build and an origin-isolation smoke test.

## Pull request and review

Complete the pull request template with the issue, user-visible outcome, validation evidence, security impact, compatibility impact, and documentation changes. Keep the diff reviewable, preserve repository formatting and package boundaries, and respond to review with new commits until approval.

The `Hub CI` checks must pass on Linux and macOS, Windows type-check, official Web regression, documentation, and Linux AMD64 container jobs. CODEOWNERS review is required for Hub protocol, authentication, node authority, deployment, and release workflow paths. Merge by squash after approval so `master` retains one reviewed change per pull request.

## Releases

Hub releases use tags of the form `hub-v<package-version>`. The release workflow verifies tests and packed installation, publishes checksum-protected Node Agent and Connector assets, and publishes a provenance-bearing Linux AMD64 image. Release tags are created only from reviewed `master` commits.
