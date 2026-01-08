export const RELIABILITY = {
  crud: {
    backendDir: "convex",
    uiDir: "src/features",
    requiredBackendExports: ["list", "get", "create", "update", "remove"] as const,
    skipTables: [] as string[],
    requiredUiFiles: ["api.ts", "ui.tsx"] as const,
  },

  ids: {
    idNameRegex: /(^|_)id$|Id$/i,
    bannedPrimitiveIdTypes: new Set(["string", "number"]),
    ignoreFileComment: "@id-ignore",
  },

  flow: {
    featureRoot: "src/features",
    ignoreFileComment: "@flow-ignore",
    allowUseEffectComment: "@allow-useEffect",
    flowStateNames: ["status", "step", "stage", "mode", "phase"] as const,
    statusBooleanPrefixes: [
      "isLoading",
      "isFetching",
      "isSubmitting",
      "isSaving",
      "isPending",
      "isRetrying",
      "isError",
      "isSuccess",
    ] as const,
    xstateModules: ["xstate", "@xstate/react"] as const,
    maxStatusBooleansWithoutXState: 1,
  },
} as const;
