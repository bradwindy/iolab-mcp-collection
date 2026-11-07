import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  RENOVATE_VALIDATOR_VERSION,
  assertRepositoryPolicy,
  decide,
  deployOnlyActions,
  parseRenovateConfig,
  parseWorkflow,
  type RenovateConfig,
  type UpdateSample,
} from "./renovate-policy.ts";

const root = new URL("../../", import.meta.url);
const config = parseRenovateConfig(
  readFileSync(new URL("renovate.json", root), "utf8"),
);
const workflowSource = readFileSync(
  new URL(".github/workflows/ci.yml", root),
  "utf8",
);
const packageManager = JSON.parse(
  readFileSync(new URL("package.json", root), "utf8"),
) as { packageManager: string };

function sample(overrides: UpdateSample): UpdateSample {
  return overrides;
}

const repository = {
  config,
  workflowSource,
  packageManager: packageManager.packageManager,
  testScript: JSON.parse(
    readFileSync(new URL("package.json", root), "utf8"),
  ) as { scripts: { test: string } },
};

function policyErrors(overrides: {
  config?: RenovateConfig;
  workflowSource?: string;
  packageManager?: string;
  testScript?: string;
}): string[] {
  return assertRepositoryPolicy({
    config: overrides.config ?? config,
    workflowSource: overrides.workflowSource ?? workflowSource,
    packageManager: overrides.packageManager ?? packageManager.packageManager,
    testScript: overrides.testScript ?? repository.testScript.scripts.test,
  });
}

test("repository policy matches the tested automerge gate", () => {
  assert.deepEqual(policyErrors({}), []);
  const validator = readFileSync(
    new URL("scripts/ci/validate-renovate.sh", root),
    "utf8",
  );
  assert.match(validator, /renovate@\$\{renovate_version\}/);
  assert.match(validator, /renovate-config-validator --strict --no-global/);
  assert.match(validator, /renovate_version="44\.222\.0"/);
  assert.match(validator, /node_version="24\.11\.0"/);
});

test("stable npm and exercised Actions updates automerge only after seven days", () => {
  const npmMinor = decide(
    config,
    sample({
      manager: "npm",
      datasource: "npm",
      updateType: "minor",
      currentVersion: "4.12.28",
      depName: "hono",
    }),
  );
  assert.equal(npmMinor.enabled, true);
  assert.equal(npmMinor.automerge, true);
  assert.equal(npmMinor.automergeType, "pr");
  assert.equal(npmMinor.platformAutomerge, false);
  assert.equal(npmMinor.ignoreTests, false);
  assert.equal(npmMinor.minimumReleaseAge, "7 days");
  assert.equal(npmMinor.internalChecksFilter, "none");

  for (const updateType of ["patch", "pinDigest", "digest"] as const) {
    const decision = decide(
      config,
      sample({
        manager: "github-actions",
        datasource: "github-tags",
        updateType,
        currentVersion: "4.2.2",
        depName: "actions/checkout",
      }),
    );
    assert.equal(decision.automerge, true, updateType);
    assert.equal(decision.minimumReleaseAge, "7 days", updateType);
    assert.equal(decision.platformAutomerge, false, updateType);
    assert.equal(decision.ignoreTests, false, updateType);
  }
});

test("majors, 0.x, pins, pnpm, node, lockfile maintenance, and unknown managers stay manual", () => {
  const cases: Array<{ update: UpdateSample; age: string | null | undefined }> = [
    {
      update: {
        manager: "npm",
        datasource: "npm",
        updateType: "major",
        currentVersion: "6.0.3",
        depName: "typescript",
      },
      age: "3 days",
    },
    {
      update: {
        manager: "npm",
        datasource: "npm",
        updateType: "minor",
        currentVersion: "0.17.3",
        depName: "agents",
      },
      age: "7 days",
    },
    {
      update: {
        manager: "npm",
        datasource: "npm",
        updateType: "patch",
        currentVersion: "0.8.1",
        depName: "@cloudflare/workers-oauth-provider",
      },
      age: "7 days",
    },
    {
      update: {
        manager: "npm",
        datasource: "npm",
        updateType: "patch",
        currentVersion: "0.17.3-beta.1",
        depName: "agents",
      },
      age: "7 days",
    },
    {
      update: {
        manager: "npm",
        datasource: "npm",
        updateType: "minor",
        currentVersion: "^0.17.3",
        depName: "agents",
      },
      age: "7 days",
    },
    {
      update: {
        manager: "npm",
        datasource: "npm",
        updateType: "minor",
        currentVersion: "1.0.0-rc.1",
        depName: "example",
      },
      age: "7 days",
    },
    {
      update: {
        manager: "github-actions",
        datasource: "github-tags",
        updateType: "minor",
        currentVersion: "v0.4.2",
        depName: "example/action",
      },
      age: "7 days",
    },
    {
      update: {
        manager: "npm",
        datasource: "npm",
        updateType: "pin",
        currentVersion: "4.1.10",
        depName: "vitest",
      },
      age: null,
    },
    {
      update: {
        manager: "npm",
        datasource: "npm",
        updateType: "minor",
        currentVersion: "10.33.0",
        depName: "pnpm",
      },
      age: "7 days",
    },
    {
      update: {
        manager: "github-actions",
        datasource: "node-version",
        updateType: "major",
        currentVersion: "22.0.0",
        depName: "node",
      },
      age: undefined,
    },
    {
      update: {
        manager: "npm",
        datasource: "npm",
        updateType: "lockFileMaintenance",
        depName: "pnpm-lock.yaml",
      },
      age: null,
    },
    {
      update: {
        manager: "dockerfile",
        datasource: "docker",
        updateType: "patch",
        currentVersion: "1.2.3",
        depName: "library/node",
      },
      age: undefined,
    },
  ];

  for (const item of cases) {
    const decision = decide(config, item.update);
    assert.equal(
      decision.automerge,
      false,
      `${item.update.depName ?? item.update.manager} ${item.update.updateType}`,
    );
    assert.equal(decision.platformAutomerge, false);
    assert.equal(decision.ignoreTests, false);
    assert.equal(decision.minimumReleaseAge, item.age);
  }

  const docker = cases.find((item) => item.update.manager === "dockerfile");
  assert.ok(docker);
  assert.equal(decide(config, docker.update).enabled, false);
});

test("a semver less-than range does not hold prereleases or action tags", () => {
  const ranged: RenovateConfig = {
    ...config,
    packageRules: (config.packageRules ?? []).map((rule) =>
      rule.matchCurrentVersion
        ? {
            ...rule,
            matchManagers: ["npm"],
            matchCurrentVersion: "<1.0.0",
          }
        : rule,
    ),
  };
  for (const currentVersion of ["0.17.3-beta.1", "1.0.0-rc.1", "v0.4.2"]) {
    const decision = decide(ranged, {
      manager: currentVersion.startsWith("v") ? "github-actions" : "npm",
      datasource: currentVersion.startsWith("v") ? "github-tags" : "npm",
      updateType: "patch",
      currentVersion,
      depName: "example",
    });
    assert.equal(decision.automerge, true, currentVersion);
  }
  assert.equal(
    decide(ranged, {
      manager: "npm",
      datasource: "npm",
      updateType: "patch",
      currentVersion: "0.8.1",
      depName: "example",
    }).automerge,
    false,
  );
});

test("the seven-day rule overrides the vendored three-day npm preset", () => {
  const decision = decide(config, {
    manager: "npm",
    datasource: "npm",
    updateType: "patch",
    currentVersion: "8.5.16",
    depName: "postcss",
  });
  assert.equal(decision.minimumReleaseAge, "7 days");
  assert.equal(decision.internalChecksFilter, "none");
  assert.notEqual(decision.internalChecksFilter, "strict");
});

test("a deploy-only action cannot automerge from the green PR job", () => {
  const live = parseWorkflow(workflowSource);
  assert.deepEqual(deployOnlyActions(live), []);
  assert.deepEqual(
    live.jobs.find((job) => job.id === "build")?.actions.map((action) => action.name),
    ["actions/checkout", "pnpm/action-setup", "actions/setup-node"],
  );

  const privileged = `${workflowSource}
  release:
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    steps:
      - uses: azure/login@v2
`;
  const unprotected = policyErrors({ workflowSource: privileged });
  assert.ok(
    unprotected.some((error) => error.includes("azure/login")),
    unprotected.join("\n"),
  );

  const protectedConfig: RenovateConfig = {
    ...config,
    packageRules: [
      ...(config.packageRules ?? []),
      {
        description: "Deploy-only action.",
        matchManagers: ["github-actions"],
        matchDepNames: ["azure/login"],
        automerge: false,
      },
    ],
  };
  const minorOnly: RenovateConfig = {
    ...config,
    packageRules: [
      ...(config.packageRules ?? []),
      {
        description: "Only the minor update is manual.",
        matchManagers: ["github-actions"],
        matchDepNames: ["azure/login"],
        matchUpdateTypes: ["minor"],
        automerge: false,
      },
    ],
  };
  const minorOnlyErrors = policyErrors({
    config: minorOnly,
    workflowSource: privileged,
  });
  assert.ok(
    minorOnlyErrors.some((error) => error.includes("azure/login patch")),
    minorOnlyErrors.join("\n"),
  );

  const protectedErrors = policyErrors({
    config: protectedConfig,
    workflowSource: privileged,
  });
  assert.deepEqual(protectedErrors, []);
  assert.equal(
    decide(protectedConfig, {
      manager: "github-actions",
      datasource: "github-tags",
      updateType: "minor",
      currentVersion: "2.0.0",
      depName: "azure/login",
    }).automerge,
    false,
  );
});

test("skipped or conditional build steps are not treated as exercised", () => {
  const conditional = workflowSource.replace(
    "      - uses: actions/setup-node@v4\n",
    "      - if: github.event_name == 'push'\n        uses: actions/setup-node@v4\n",
  );
  const errors = policyErrors({ workflowSource: conditional });
  assert.ok(
    errors.some((error) => error.includes("unconditional")),
    errors.join("\n"),
  );
});

test("path filters and a drifted pnpm pin fail the gate", () => {
  const filtered = workflowSource.replace(
    "  pull_request:\n",
    "  pull_request:\n    paths:\n      - '**'\n",
  );
  const filterErrors = policyErrors({ workflowSource: filtered });
  assert.ok(filterErrors.some((error) => error.includes("path-filtered")));

  const drifted = workflowSource.replaceAll("version: 10.33.0", "version: 10.34.0");
  const pinErrors = policyErrors({ workflowSource: drifted });
  assert.ok(pinErrors.some((error) => error.includes("packageManager")));
});

test("broad automerge and platform automerge are rejected", () => {
  const broadened: RenovateConfig = {
    ...config,
    platformAutomerge: true,
    packageRules: (config.packageRules ?? []).map((rule) =>
      rule.automerge === true
        ? { ...rule, matchUpdateTypes: ["minor", "patch", "pin", "major"] }
        : rule,
    ),
  };
  const errors = policyErrors({ config: broadened });
  assert.ok(errors.some((error) => error.includes("platformAutomerge")));
  assert.ok(errors.some((error) => error.includes("automerge rule")));
  assert.equal(RENOVATE_VALIDATOR_VERSION, "44.222.0");
});
