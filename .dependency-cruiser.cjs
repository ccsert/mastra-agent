const { readdirSync } = require("node:fs");
const { join } = require("node:path");
const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Discover feature directories so a newly added module gets the same protection automatically.
const entries = ["apps/control-plane/src/modules", "apps/console/src/features", "apps/runtime/src"];
const modules = entries.flatMap((base) =>
  readdirSync(join(__dirname, base), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${base}/${entry.name}`),
);
const moduleRules = modules.map((root) => ({
  name: `${root.replaceAll("/", "-")}-public-entry`,
  severity: "error",
  from: { path: "^apps/", pathNot: `^${escapePattern(root)}/` },
  to: {
    path: `^${escapePattern(root)}/(?!index\\.ts$${root.startsWith("apps/control-plane") ? "|routes\\.ts$" : root.startsWith("apps/console") ? "|styles\\.css$" : ""})`,
  },
}));

module.exports = {
  forbidden: [
    ...moduleRules,
    {
      name: "only-composition-registers-domain-routes",
      severity: "error",
      from: { path: "^apps/control-plane/src/", pathNot: "^apps/control-plane/src/app\\.ts$" },
      to: { path: "^apps/control-plane/src/modules/[^/]+/routes\\.ts$" },
    },
    {
      name: "domain-implementation-does-not-depend-on-http",
      severity: "error",
      from: { path: "^apps/control-plane/src/modules/", pathNot: "/routes\\.ts$" },
      to: { path: "^apps/control-plane/src/http/" },
    },
    {
      name: "infrastructure-does-not-depend-on-domains",
      severity: "error",
      from: { path: "^apps/control-plane/src/(infrastructure|http)/" },
      to: { path: "^apps/control-plane/src/modules/" },
    },
    {
      name: "console-shared-does-not-depend-on-features",
      severity: "error",
      from: { path: "^apps/console/src/shared/" },
      to: { path: "^apps/console/src/(features|app)/" },
    },
    {
      name: "console-features-do-not-depend-on-app",
      severity: "error",
      from: { path: "^apps/console/src/features/" },
      to: { path: "^apps/console/src/app/" },
    },
    {
      name: "contracts-do-not-import-their-barrel",
      severity: "error",
      from: { path: "^packages/contracts/src/", pathNot: "/index\\.ts$" },
      to: { path: "^packages/contracts/src/index\\.ts$" },
    },
    {
      name: "domains-do-not-import-composition-root",
      severity: "error",
      from: { path: "^apps/control-plane/src/(?!app\\.ts$|main\\.ts$|platform\\.ts$)" },
      to: { path: "^apps/control-plane/src/platform\\.ts$" },
    },
    { name: "no-unresolved-imports", severity: "error", from: {}, to: { couldNotResolve: true } },
    {
      name: "no-runtime-cycles",
      severity: "error",
      from: {},
      to: { circular: true, dependencyTypesNot: ["type-only"] },
    },
    ...["console", "control-plane", "runtime"].map((app) => ({
      name: `${app}-cannot-import-another-application`,
      severity: "error",
      from: { path: `^apps/${app}/src/` },
      to: { path: `^apps/(?!${app}/)[^/]+/src/` },
    })),
    {
      name: "runtime-has-no-database-access",
      severity: "error",
      from: { path: "^apps/runtime/src/" },
      to: { path: "(^packages/database/|(^|/)(pg|pg-pool)/)" },
    },
    {
      name: "packages-do-not-depend-on-applications",
      severity: "error",
      from: { path: "^packages/" },
      to: { path: "^apps/" },
    },
  ],
  options: {
    doNotFollow: { path: "(^|/)node_modules/|/generated/|/dist/" },
    exclude: { path: "/(dist|tests)/|\\.d\\.ts$" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["development", "import", "node", "default"],
    },
  },
};
