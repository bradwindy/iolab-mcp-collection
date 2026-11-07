# Agreed scope

Recorded from the already confirmed maintenance mandate for this repository. This file does not widen that mandate.

## Mandate

Bradley selected `bradwindy/iolab-mcp-collection` on 7 Nov 2026 as one of eight maintained repositories and said: "And all of these should have an up-to-date Renovate setup, including automated merge requests and other bits and pieces for dependency updates."

The ongoing maintenance goal includes working through dependency blockers, not only reporting them.

## This change

- Base is the current `main` tip `ce087ef990262c918627bc869a7645c30ae5f9a6`.
- Branch: `cursor/renovate-pr-automerge-3151`.
- Add Renovate configuration, a repo-local Dependabot version-update pause, and tests that check the automerge decisions against the PR workflow.
- Renovate schema validation uses Renovate `44.222.0` with `renovate-config-validator --strict`.

## Automerge that this config allows

PR automerge (`automergeType: pr`, `platformAutomerge: false`, `ignoreTests: false`) for `minor`, `patch`, `pinDigest`, and `digest` updates from the `npm` and `github-actions` managers, after `minimumReleaseAge` of 7 days, and only when the unfiltered PR `build` job has run the changed code on a branch Renovate rebases once it is behind `main`.

`internalChecksFilter` is `none` so those PRs open while `renovate/stability-days` is still pending. The pending check blocks automerge; it does not hide the PR until day seven.

## Held manual

- Major updates.
- `pin` updates. Pin carries no release timestamp. With `minimumReleaseAgeBehaviour` `timestamp-required`, a seven-day age stays pending forever, so `security:minimumReleaseAgeNpm` clears it. Leaving that age cleared and turning automerge on would merge a pin on the first green build, which skips the seven-day wait. Pins stay manual.
- npm and GitHub Actions updates whose current version is `0.x` or a `1.0.0` prerelease, including versions written as `^0.x` or `v0.x`. A `<1.0.0` semver range does not match prereleases, and Actions versioning does not apply less-than ranges.
- `pnpm` itself. CI installs the `pnpm/action-setup` `version:` pin, not `packageManager` alone.
- `node`. A green PR job is not a production Worker deploy.
- Lock file maintenance.
- Vulnerability alerts. They are enabled and opened for review. Renovate appends `vulnerabilityAlerts` as a forced package rule, and `automerge` there is false. This does not disable GitHub or Dependabot security settings.
- Managers other than `npm` and `github-actions`.
- Any GitHub Action that appears only in the main-push deploy job. The current workflow has no such action. The policy test fails if one is added without an automerge override.

## Out of scope

- Merging this PR, deploying, changing repository settings, secrets, branch protection, or GitHub App installations.
- Closing the existing Dependabot pull requests or upgrading dependencies in this change.
- Self-approval, force-push, or bypassing required checks.

## Activation

Config on a branch is not proof the Renovate GitHub App is installed or running. The parent owns the merge and the decision to enable the app if it is not already active.
