module.exports = {
  forbidden: [
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
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["development", "import", "node", "default"] },
  },
};
