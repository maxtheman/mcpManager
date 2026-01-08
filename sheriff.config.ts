import type { SheriffConfig } from "@softarc/sheriff-core";

export const config: SheriffConfig = {
  enableBarrelLess: true,
  excludeRoot: true,
  entryPoints: {
    "gateway-cli": "apps/gateway/src/entry/cli.ts",
    "gateway-manager": "apps/gateway/src/entry/manager-cli.ts",
    "gateway-skills": "apps/gateway/src/entry/skills-cli.ts",
  },
  modules: {
    "apps/gateway/src": {
      entry: "entry",
      core: "core",
      infra: "infra",
      shared: "shared",
    },
  },
  depRules: {
    entry: ["entry", "core", "infra", "shared"],
    core: ["core", "infra", "shared"],
    infra: ["infra", "shared"],
    shared: ["shared"],
    root: "noTag",
    noTag: "noTag",
  },
};
