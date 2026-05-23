import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Framework detection by reading the target project's package.json.
// Intentionally narrow — no AST walking, no source scanning. The user
// gets one printed snippet; codemod is "month, not weekend" per PRD §10.

export type DetectedFramework = "vercel" | "mastra" | "openai";

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

// Detection precedence: most specific framework first. Mastra wraps
// Vercel internally, so a Mastra app also has `ai` in its tree — we
// pick Mastra because that's the seam the user actually authors against.
const DEPS_TO_FRAMEWORK: Array<{ pkg: string; framework: DetectedFramework }> = [
  { pkg: "@mastra/core", framework: "mastra" },
  { pkg: "ai", framework: "vercel" },
  { pkg: "@ai-sdk/openai", framework: "vercel" },
  { pkg: "openai", framework: "openai" },
];

function allDeps(pkg: PackageJson): Record<string, string> {
  return {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
  };
}

export interface DetectionResult {
  packageJsonPath: string;
  // All detected frameworks (a project can have more than one);
  // ordered by detection precedence above.
  detected: DetectedFramework[];
  // The single framework we recommend in the snippet; first of detected
  // or undefined if nothing matched.
  primary?: DetectedFramework;
}

export function detect(cwd: string = process.cwd()): DetectionResult {
  const pkgPath = resolve(cwd, "package.json");
  if (!existsSync(pkgPath)) {
    return { packageJsonPath: pkgPath, detected: [] };
  }
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as PackageJson;
  } catch {
    return { packageJsonPath: pkgPath, detected: [] };
  }
  const deps = allDeps(pkg);
  const seen = new Set<DetectedFramework>();
  const ordered: DetectedFramework[] = [];
  for (const { pkg: name, framework } of DEPS_TO_FRAMEWORK) {
    if (deps[name] && !seen.has(framework)) {
      seen.add(framework);
      ordered.push(framework);
    }
  }
  return {
    packageJsonPath: pkgPath,
    detected: ordered,
    primary: ordered[0],
  };
}
