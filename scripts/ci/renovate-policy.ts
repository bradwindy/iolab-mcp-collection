/**
 * Checks the repository Renovate policy against the PR workflow.
 *
 * Preset package rules below are copied from Renovate 44.222.0
 * `security:minimumReleaseAgeNpm` (`lib/config/presets/internal/security.preset.ts`).
 * They are applied before this repo's package rules, which is Renovate's order.
 * The official validator still has to accept renovate.json; this module checks
 * the merge decisions that validator does not print.
 */

export const RENOVATE_VALIDATOR_VERSION = "44.222.0";

/**
 * Matches the version string Renovate tests for a regex `matchCurrentVersion`:
 * `lockedVersion ?? currentVersion ?? currentValue`.
 * `<1.0.0` is not used: npm semver ignores prereleases, and GitHub Actions
 * versioning does not implement less-than ranges.
 */
export const MANUAL_CURRENT_VERSION =
  "/^v?(?:\\^|~|>=|<=)?(?:0(?:\\.|$)|1\\.0\\.0-)/";

export const SAFE_UPDATE_TYPES = [
  "minor",
  "patch",
  "pinDigest",
  "digest",
] as const;

export type SafeUpdateType = (typeof SAFE_UPDATE_TYPES)[number];

export interface PackageRule {
  description?: string;
  matchManagers?: string[];
  matchDatasources?: string[];
  matchUpdateTypes?: string[];
  matchCurrentVersion?: string;
  matchDepNames?: string[];
  automerge?: boolean;
  automergeType?: string;
  platformAutomerge?: boolean;
  ignoreTests?: boolean;
  minimumReleaseAge?: string | null;
  internalChecksFilter?: string;
  prBodyNotes?: string[];
}

export interface RenovateConfig {
  $schema?: string;
  description?: string;
  extends?: string[];
  dependencyDashboard?: boolean;
  enabledManagers?: string[];
  prCreation?: string;
  automerge?: boolean;
  automergeType?: string;
  platformAutomerge?: boolean;
  ignoreTests?: boolean;
  internalChecksFilter?: string;
  rebaseWhen?: string;
  minimumReleaseAge?: string | null;
  lockFileMaintenance?: { automerge?: boolean };
  vulnerabilityAlerts?: { enabled?: boolean; automerge?: boolean };
  packageRules?: PackageRule[];
}

export interface UpdateSample {
  manager: string;
  datasource?: string;
  updateType: string;
  currentVersion?: string;
  depName?: string;
}

export interface Decision {
  automerge: boolean;
  automergeType: string | undefined;
  platformAutomerge: boolean;
  ignoreTests: boolean;
  minimumReleaseAge: string | null | undefined;
  internalChecksFilter: string | undefined;
  enabled: boolean;
}

export interface WorkflowAction {
  name: string;
  stepConditional: boolean;
}

export interface WorkflowJob {
  id: string;
  name: string | undefined;
  ifCondition: string | undefined;
  actions: WorkflowAction[];
  runs: string[];
}

export interface ParsedWorkflow {
  pullRequestHasPathFilter: boolean;
  jobs: WorkflowJob[];
}

interface DecisionState {
  automerge: boolean;
  automergeType: string | undefined;
  platformAutomerge: boolean;
  ignoreTests: boolean;
  minimumReleaseAge: string | null | undefined;
  internalChecksFilter: string | undefined;
}

/**
 * `security:minimumReleaseAgeNpm` in Renovate 44.222.0.
 * Datasource matchers are npm, not the npm manager name.
 */
export const VENDORED_NPM_RELEASE_AGE_RULES: readonly PackageRule[] = [
  {
    description: "security:minimumReleaseAgeNpm",
    matchDatasources: ["npm"],
    internalChecksFilter: "strict",
    minimumReleaseAge: "3 days",
  },
  {
    description: "npm lock file maintenance cannot be aged",
    matchDatasources: ["npm"],
    matchUpdateTypes: ["lockFileMaintenance"],
    minimumReleaseAge: null,
  },
  {
    description: "npm replacements cannot be aged",
    matchDatasources: ["npm"],
    matchUpdateTypes: ["replacement"],
    minimumReleaseAge: null,
  },
  {
    description: "npm pin updates cannot be aged",
    matchDatasources: ["npm"],
    matchUpdateTypes: ["pin"],
    minimumReleaseAge: null,
  },
  {
    description: "npm bump, lockfileUpdate, and rollback cannot be aged",
    matchDatasources: ["npm"],
    matchUpdateTypes: ["bump", "lockfileUpdate", "rollback"],
    minimumReleaseAge: null,
  },
];

const ENGINE_DEFAULTS: DecisionState = {
  automerge: false,
  automergeType: "pr",
  platformAutomerge: true,
  ignoreTests: false,
  minimumReleaseAge: undefined,
  internalChecksFilter: "strict",
};

export function parseRenovateConfig(source: string): RenovateConfig {
  const value: unknown = JSON.parse(source);
  if (!isRecord(value)) {
    throw new Error("renovate.json must be an object");
  }
  const packageRules = value.packageRules;
  if (packageRules !== undefined && !Array.isArray(packageRules)) {
    throw new Error("packageRules must be an array");
  }
  return value as RenovateConfig;
}

export function decide(
  config: RenovateConfig,
  update: UpdateSample,
): Decision {
  const enabled = (config.enabledManagers ?? []).includes(update.manager);
  const state: DecisionState = {
    ...ENGINE_DEFAULTS,
    ...(config.automerge === undefined ? {} : { automerge: config.automerge }),
    ...(config.automergeType === undefined
      ? {}
      : { automergeType: config.automergeType }),
    ...(config.platformAutomerge === undefined
      ? {}
      : { platformAutomerge: config.platformAutomerge }),
    ...(config.ignoreTests === undefined
      ? {}
      : { ignoreTests: config.ignoreTests }),
    ...(config.minimumReleaseAge === undefined
      ? {}
      : { minimumReleaseAge: config.minimumReleaseAge }),
    ...(config.internalChecksFilter === undefined
      ? {}
      : { internalChecksFilter: config.internalChecksFilter }),
  };

  const rules = [
    ...VENDORED_NPM_RELEASE_AGE_RULES,
    ...(config.packageRules ?? []),
  ];
  for (const rule of rules) {
    if (!ruleMatches(rule, update)) continue;
    overlay(state, rule);
  }

  if (!enabled) {
    state.automerge = false;
  }

  return { ...state, enabled };
}

export function parseWorkflow(source: string): ParsedWorkflow {
  const jobs: WorkflowJob[] = [];
  let section: "root" | "on" | "jobs" = "root";
  let pullRequestIndent = -1;
  let pullRequestHasPathFilter = false;
  let job: WorkflowJob | undefined;
  let inSteps = false;
  let step: { stepConditional: boolean; uses?: string; run?: string } | undefined;

  const flushStep = (): void => {
    if (!job || !step) {
      step = undefined;
      return;
    }
    if (step.uses) {
      job.actions.push({
        name: step.uses,
        stepConditional: step.stepConditional,
      });
    }
    if (step.run) job.runs.push(step.run);
    step = undefined;
  };

  for (const raw of source.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    const indent = raw.match(/^ */)?.[0].length ?? 0;
    const content = raw.trim();

    if (indent === 0) {
      flushStep();
      inSteps = false;
      job = undefined;
      pullRequestIndent = -1;
      if (content.startsWith("on:")) section = "on";
      else if (content.startsWith("jobs:")) section = "jobs";
      else section = "root";
      continue;
    }

    if (section === "on") {
      if (
        content.startsWith("pull_request:") ||
        content.startsWith("pull_request ")
      ) {
        pullRequestIndent = indent;
        continue;
      }
      if (pullRequestIndent >= 0 && indent > pullRequestIndent) {
        if (
          content.startsWith("paths:") ||
          content.startsWith("paths-ignore:")
        ) {
          pullRequestHasPathFilter = true;
        }
        continue;
      }
      if (pullRequestIndent >= 0 && indent <= pullRequestIndent) {
        pullRequestIndent = -1;
      }
      continue;
    }

    if (section !== "jobs") continue;

    if (indent === 2 && content.endsWith(":")) {
      flushStep();
      inSteps = false;
      job = {
        id: content.slice(0, -1),
        name: undefined,
        ifCondition: undefined,
        actions: [],
        runs: [],
      };
      jobs.push(job);
      continue;
    }

    if (!job) continue;

    if (!inSteps && indent === 4 && content.startsWith("name:")) {
      job.name = unquote(content.slice("name:".length).trim());
      continue;
    }
    if (!inSteps && indent === 4 && content.startsWith("if:")) {
      job.ifCondition = content.slice("if:".length).trim();
      continue;
    }
    if (indent === 4 && content.startsWith("steps:")) {
      flushStep();
      inSteps = true;
      continue;
    }
    if (!inSteps) continue;

    if (content.startsWith("- ")) {
      flushStep();
      step = { stepConditional: false };
      applyStepField(step, content.slice(2).trim());
      continue;
    }
    if (step) applyStepField(step, content);
  }
  flushStep();

  return { pullRequestHasPathFilter, jobs };
}

export function deployOnlyActions(workflow: ParsedWorkflow): string[] {
  const build = workflow.jobs.find((item) => item.id === "build");
  const exercised = new Set<string>();
  if (build && !build.ifCondition) {
    for (const action of build.actions) {
      if (!action.stepConditional) exercised.add(action.name);
    }
  }
  const blocked = new Set<string>();
  for (const candidate of workflow.jobs) {
    if (!isMainPushOnly(candidate.ifCondition)) continue;
    for (const action of candidate.actions) {
      if (!exercised.has(action.name)) blocked.add(action.name);
    }
  }
  return [...blocked].sort();
}

export function assertRepositoryPolicy(input: {
  config: RenovateConfig;
  workflowSource: string;
  packageManager: string;
  testScript: string;
}): string[] {
  const errors: string[] = [];
  const { config } = input;
  const workflow = parseWorkflow(input.workflowSource);
  const rules = config.packageRules ?? [];

  if (
    config.extends?.length !== 2 ||
    config.extends[0] !== "config:best-practices" ||
    config.extends[1] !== ":semanticCommits"
  ) {
    errors.push(
      "extends must be exactly config:best-practices and :semanticCommits",
    );
  }
  if (!input.testScript.includes("scripts/ci/renovate-policy.test.ts")) {
    errors.push("the root test script must run the Renovate policy tests");
  }
  if (config.dependencyDashboard !== true) {
    errors.push("dependencyDashboard must be true");
  }
  if (!sameMembers(config.enabledManagers ?? [], ["npm", "github-actions"])) {
    errors.push("enabledManagers must be exactly npm and github-actions");
  }
  if (config.prCreation !== "immediate") {
    errors.push("prCreation must be immediate so pull_request CI can start");
  }
  if (config.automergeType !== "pr") errors.push("automergeType must be pr");
  if (config.platformAutomerge !== false) {
    errors.push("root platformAutomerge must be false");
  }
  if (config.ignoreTests !== false) errors.push("root ignoreTests must be false");
  if (config.internalChecksFilter !== "none") {
    errors.push("root internalChecksFilter must be none");
  }
  if (config.rebaseWhen !== "behind-base-branch") {
    errors.push("rebaseWhen must be behind-base-branch");
  }
  if (config.lockFileMaintenance?.automerge !== false) {
    errors.push("lockFileMaintenance.automerge must be false");
  }
  if (config.vulnerabilityAlerts?.enabled !== true) {
    errors.push("vulnerabilityAlerts.enabled must be true");
  }
  if (config.vulnerabilityAlerts?.automerge !== false) {
    errors.push("vulnerabilityAlerts.automerge must be false");
  }
  if (config.automerge === true) {
    errors.push("root automerge must not be true");
  }

  const automergeRuleIndexes = rules.flatMap((rule, index) =>
    rule.automerge === true ? [index] : [],
  );
  if (automergeRuleIndexes.length !== 1) {
    errors.push("exactly one package rule may set automerge true");
  }
  for (const index of automergeRuleIndexes) {
    const rule = rules[index];
    if (!rule) continue;
    if (
      !sameMembers(rule.matchManagers ?? [], ["npm", "github-actions"]) ||
      !sameMembers(rule.matchUpdateTypes ?? [], [...SAFE_UPDATE_TYPES])
    ) {
      errors.push(
        "the automerge rule must be limited to npm and github-actions minor, patch, pinDigest, and digest",
      );
    }
    if (rule.platformAutomerge !== false || rule.ignoreTests !== false) {
      errors.push("the automerge rule must keep platformAutomerge and ignoreTests false");
    }
    if (rule.automergeType !== "pr") {
      errors.push("the automerge rule must use automergeType pr");
    }
    if (rule.minimumReleaseAge !== "7 days") {
      errors.push("the automerge rule must set minimumReleaseAge to 7 days");
    }
    if (rule.internalChecksFilter !== "none") {
      errors.push("the automerge rule must keep internalChecksFilter none");
    }
  }

  for (const rule of rules) {
    if (rule.platformAutomerge === true) {
      errors.push("no package rule may set platformAutomerge true");
    }
    if (rule.ignoreTests === true) {
      errors.push("no package rule may set ignoreTests true");
    }
    if (rule.minimumReleaseAge === "0 days") {
      errors.push("minimumReleaseAge of 0 days disables the stability gate");
    }
  }

  const lastAutomerge = automergeRuleIndexes.at(-1) ?? -1;
  const requireAfterAutomerge = (predicate: (rule: PackageRule) => boolean, label: string): void => {
    const index = rules.findIndex(predicate);
    if (index === -1 || index < lastAutomerge) {
      errors.push(`${label} must exist after the automerge rule`);
    }
  };
  requireAfterAutomerge(
    (rule) =>
      sameMembers(rule.matchUpdateTypes ?? [], ["major"]) &&
      rule.automerge === false,
    "major manual rule",
  );
  requireAfterAutomerge(
    (rule) =>
      rule.matchCurrentVersion === MANUAL_CURRENT_VERSION &&
      sameMembers(rule.matchManagers ?? [], ["npm", "github-actions"]) &&
      rule.automerge === false,
    "0.x manual rule",
  );
  requireAfterAutomerge(
    (rule) =>
      sameMembers(rule.matchUpdateTypes ?? [], ["pin"]) &&
      rule.automerge === false &&
      rule.minimumReleaseAge === undefined,
    "pin manual rule",
  );
  requireAfterAutomerge(
    (rule) =>
      sameMembers(rule.matchDepNames ?? [], ["pnpm"]) && rule.automerge === false,
    "pnpm manual rule",
  );
  requireAfterAutomerge(
    (rule) =>
      sameMembers(rule.matchDepNames ?? [], ["node"]) && rule.automerge === false,
    "node manual rule",
  );

  if (workflow.pullRequestHasPathFilter) {
    errors.push("pull_request CI must not be path-filtered");
  }
  const build = workflow.jobs.find((item) => item.id === "build");
  if (!build) errors.push("CI must have a build job");
  if (build?.ifCondition) {
    errors.push("the build job must run for every pull request");
  }
  for (const command of [
    "pnpm install --frozen-lockfile",
    "pnpm run typecheck",
    "pnpm run lint",
    "pnpm run test",
    "pnpm run build",
    "bash scripts/ci/validate-renovate.sh",
  ]) {
    if (!build?.runs.includes(command)) {
      errors.push(`build job must run ${command}`);
    }
  }
  if (build?.actions.some((action) => action.stepConditional)) {
    errors.push("build job actions must be unconditional");
  }

  const deploy = workflow.jobs.find((item) => item.id === "deploy");
  if (!isMainPushOnly(deploy?.ifCondition)) {
    errors.push("deploy job must be limited to pushes of main");
  }

  const packageManagerVersion = input.packageManager.startsWith("pnpm@")
    ? input.packageManager.slice("pnpm@".length)
    : input.packageManager;
  const pins = pnpmVersionPins(input.workflowSource);
  if (pins.length === 0 || pins.some((pin) => pin !== packageManagerVersion)) {
    errors.push(
      `pnpm/action-setup version pins (${pins.join(", ")}) must equal packageManager ${packageManagerVersion}`,
    );
  }

  for (const action of deployOnlyActions(workflow)) {
    for (const updateType of SAFE_UPDATE_TYPES) {
      const decision = decide(config, {
        manager: "github-actions",
        datasource: "github-tags",
        updateType,
        currentVersion: "1.2.3",
        depName: action,
      });
      if (decision.automerge) {
        errors.push(
          `${action} ${updateType} is not exercised by the PR build job and must not automerge`,
        );
      }
    }
  }

  return errors;
}

export function pnpmVersionPins(workflowSource: string): string[] {
  const pins: string[] = [];
  const lines = workflowSource.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]?.includes("uses: pnpm/action-setup@")) continue;
    for (let follow = index + 1; follow < Math.min(index + 6, lines.length); follow += 1) {
      const match = lines[follow]?.match(/^\s*version:\s*['"]?(\d+\.\d+\.\d+)['"]?\s*$/);
      if (match?.[1]) {
        pins.push(match[1]);
        break;
      }
    }
  }
  return pins;
}

function ruleMatches(rule: PackageRule, update: UpdateSample): boolean {
  if (rule.matchManagers && !rule.matchManagers.includes(update.manager)) {
    return false;
  }
  if (
    rule.matchDatasources &&
    !rule.matchDatasources.includes(update.datasource ?? "")
  ) {
    return false;
  }
  if (
    rule.matchUpdateTypes &&
    !rule.matchUpdateTypes.includes(update.updateType)
  ) {
    return false;
  }
  if (
    rule.matchDepNames &&
    !rule.matchDepNames.includes(update.depName ?? "")
  ) {
    return false;
  }
  if (rule.matchCurrentVersion) {
    if (!update.currentVersion) return false;
    if (!currentVersionMatches(rule.matchCurrentVersion, update.currentVersion)) {
      return false;
    }
  }
  return true;
}

function overlay(state: DecisionState, rule: PackageRule): void {
  if (rule.automerge !== undefined) state.automerge = rule.automerge;
  if (rule.automergeType !== undefined) state.automergeType = rule.automergeType;
  if (rule.platformAutomerge !== undefined) {
    state.platformAutomerge = rule.platformAutomerge;
  }
  if (rule.ignoreTests !== undefined) state.ignoreTests = rule.ignoreTests;
  if (rule.minimumReleaseAge !== undefined) {
    state.minimumReleaseAge = rule.minimumReleaseAge;
  }
  if (rule.internalChecksFilter !== undefined) {
    state.internalChecksFilter = rule.internalChecksFilter;
  }
}

function currentVersionMatches(pattern: string, current: string): boolean {
  const regex = renovateRegex(pattern);
  if (regex) return regex.test(current);
  // Renovate's npm matcher uses semver.satisfies without includePrerelease,
  // so this range misses 0.x prereleases. Kept so a regression back to it fails.
  if (pattern === "<1.0.0") {
    const major = current.split(".")[0];
    return (
      major !== undefined &&
      /^\d+\.\d+\.\d+$/.test(current) &&
      Number(major) < 1
    );
  }
  throw new Error(`unsupported matchCurrentVersion pattern: ${pattern}`);
}

function renovateRegex(pattern: string): RegExp | null {
  const match = /^\/(.+)\/([a-z]*)$/.exec(pattern);
  if (!match?.[1]) return null;
  return new RegExp(match[1], match[2] ?? "");
}

function applyStepField(
  step: { stepConditional: boolean; uses?: string; run?: string },
  content: string,
): void {
  if (content.startsWith("if:")) {
    step.stepConditional = true;
    return;
  }
  if (content.startsWith("uses:")) {
    const name = actionName(content.slice("uses:".length).trim());
    if (name) step.uses = name;
    return;
  }
  if (content.startsWith("run:")) {
    const run = content.slice("run:".length).trim();
    if (run && run !== "|" && run !== "|-" && run !== ">") step.run = unquote(run);
  }
}

function actionName(uses: string): string {
  const trimmed = unquote(uses);
  if (
    trimmed.startsWith("./") ||
    trimmed.startsWith("docker://") ||
    trimmed.length === 0
  ) {
    return "";
  }
  const at = trimmed.lastIndexOf("@");
  return at === -1 ? trimmed : trimmed.slice(0, at);
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function isMainPushOnly(condition: string | undefined): boolean {
  if (!condition) return false;
  return (
    condition.includes("github.event_name == 'push'") &&
    condition.includes("refs/heads/main")
  );
}

function sameMembers(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const pending = [...expected];
  for (const item of actual) {
    const index = pending.indexOf(item);
    if (index === -1) return false;
    pending.splice(index, 1);
  }
  return pending.length === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
