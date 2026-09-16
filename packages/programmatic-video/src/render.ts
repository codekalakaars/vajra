import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Composition } from "./Composition";
import type { RenderOptions } from "./types";

export interface ScaffoldResult {
  /** The output directory path */
  dir: string;
  /** List of generated files */
  files: string[];
}

/**
 * Scaffold a HyperFrames project from a Composition.
 * Writes the HTML files to disk and initializes HF project structure.
 */
export function scaffold(
  composition: Composition,
  outputDir: string,
): ScaffoldResult {
  const files = composition.toFiles();
  const filePaths: string[] = [];

  // Create the output directory
  mkdirSync(outputDir, { recursive: true });

  // Create compositions directory
  const compDir = join(outputDir, "compositions");
  mkdirSync(compDir, { recursive: true });

  // Create assets directory
  const assetsDir = join(outputDir, "assets");
  mkdirSync(assetsDir, { recursive: true });

  // Write all files
  for (const [filename, content] of files) {
    const filePath = join(outputDir, filename);
    const dir = join(outputDir, filename.split("/").slice(0, -1).join("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, content, "utf-8");
    filePaths.push(filePath);
  }

  return { dir: outputDir, files: filePaths };
}

/**
 * Lint a HyperFrames project.
 */
export function lint(projectDir: string): { ok: boolean; output: string } {
  try {
    const output = execSync("npx hyperframes lint", {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { ok: true, output };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      output: err.stdout ?? err.stderr ?? err.message ?? "Unknown error",
    };
  }
}

/**
 * Validate a HyperFrames project.
 */
export function validate(
  projectDir: string,
): { ok: boolean; output: string } {
  try {
    const output = execSync("npx hyperframes validate", {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { ok: true, output };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      output: err.stdout ?? err.stderr ?? err.message ?? "Unknown error",
    };
  }
}

/**
 * Render a HyperFrames project to MP4.
 */
export function render(
  projectDir: string,
  options: RenderOptions = {},
): { ok: boolean; output: string; outputPath?: string } {
  const args = ["npx", "hyperframes", "render"];

  if (options.quality) {
    args.push("--quality", options.quality);
  }

  if (options.output) {
    args.push("--output", options.output);
  }

  if (options.variables) {
    args.push("--variables", JSON.stringify(options.variables));
  }

  if (options.strict) {
    args.push("--strict");
  }

  if (options.docker) {
    args.push("--docker");
  }

  try {
    const output = execSync(args.join(" "), {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const outputPath = options.output
      ? join(projectDir, options.output)
      : undefined;
    return { ok: true, output, outputPath };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      output: err.stdout ?? err.stderr ?? err.message ?? "Unknown error",
    };
  }
}

/**
 * Full pipeline: scaffold, lint, validate, and optionally render.
 */
export function build(
  composition: Composition,
  outputDir: string,
  options: {
    render?: boolean;
    renderOptions?: RenderOptions;
    skipValidation?: boolean;
  } = {},
): {
  scaffold: ScaffoldResult;
  lint?: { ok: boolean; output: string };
  validate?: { ok: boolean; output: string };
  render?: { ok: boolean; output: string; outputPath?: string };
} {
  const result: {
    scaffold: ScaffoldResult;
    lint?: { ok: boolean; output: string };
    validate?: { ok: boolean; output: string };
    render?: { ok: boolean; output: string; outputPath?: string };
  } = {
    scaffold: scaffold(composition, outputDir),
  };

  if (!options.skipValidation) {
    result.lint = lint(outputDir);
    if (!result.lint.ok) {
      return result;
    }

    result.validate = validate(outputDir);
    if (!result.validate.ok) {
      return result;
    }
  }

  if (options.render) {
    result.render = render(outputDir, options.renderOptions);
  }

  return result;
}

export const pipeline = { scaffold, lint, validate, render, build };
