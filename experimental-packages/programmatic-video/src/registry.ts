import { execSync } from "node:child_process";

const REGISTRY_BASE =
  "https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry";

export interface RegistryItem {
  name: string;
  type: "hyperframes:block" | "hyperframes:component" | "hyperframes:example";
}

export interface BlockInfo {
  name: string;
  compositionId: string;
  duration: number;
  width: number;
  height: number;
  files: string[];
}

export interface ExampleInfo {
  name: string;
  description: string;
  resolution: string;
}

/**
 * Fetch the registry manifest
 */
export async function fetchRegistry(): Promise<RegistryItem[]> {
  const response = await fetch(`${REGISTRY_BASE}/registry.json`);
  const data = (await response.json()) as { items: RegistryItem[] };
  return data.items;
}

/**
 * Fetch available examples
 */
export async function fetchExamples(): Promise<ExampleInfo[]> {
  const items = await fetchRegistry();
  return items
    .filter((i) => i.type === "hyperframes:example")
    .map((i) => ({
      name: i.name,
      description: `${i.name} example`,
      resolution: "1920x1080",
    }));
}

/**
 * Fetch available blocks
 */
export async function fetchBlocks(): Promise<
  { name: string; type: string }[]
> {
  const items = await fetchRegistry();
  return items
    .filter((i) => i.type === "hyperframes:block")
    .map((i) => ({ name: i.name, type: "block" }));
}

/**
 * Fetch available components
 */
export async function fetchComponents(): Promise<
  { name: string; type: string }[]
> {
  const items = await fetchRegistry();
  return items
    .filter((i) => i.type === "hyperframes:component")
    .map((i) => ({ name: i.name, type: "component" }));
}

/**
 * Install a registry block into a project
 */
export async function installBlock(
  projectName: string,
  blockName: string,
): Promise<{ success: boolean; files: string[]; snippet: string }> {
  // Use hyperframes CLI to install the block
  try {
    const output = execSync(
      `npx hyperframes add ${blockName} --dir ${projectName} --no-clipboard`,
      {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    // Parse the output to find installed files
    const files: string[] = [];
    const lines = output.split("\n");
    for (const line of lines) {
      if (line.includes("compositions/") || line.includes("assets/")) {
        const match = line.match(/(compositions\/[^\s]+|assets\/[^\s]+)/);
        if (match) files.push(match[1]);
      }
    }

    // Generate wiring snippet
    const snippet = generateBlockSnippet(blockName);

    return { success: true, files, snippet };
  } catch (error) {
    return { success: false, files: [], snippet: "" };
  }
}

/**
 * Initialize a project from an HF example
 */
export async function initFromExample(
  projectName: string,
  exampleName: string,
  options: {
    resolution?: string;
    tailwind?: boolean;
  } = {},
): Promise<{ success: boolean; dir: string }> {
  try {
    const args = [
      "npx",
      "hyperframes",
      "init",
      projectName,
      "--example",
      exampleName,
      "--non-interactive",
    ];

    if (options.resolution) {
      args.push("--resolution", options.resolution);
    }

    if (options.tailwind) {
      args.push("--tailwind");
    }

    execSync(args.join(" "), {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    return { success: true, dir: projectName };
  } catch (error) {
    return { success: false, dir: "" };
  }
}

/**
 * Generate a wiring snippet for a block
 */
function generateBlockSnippet(blockName: string): string {
  return `<!-- Wire this into your index.html -->
<div
  id="el-${blockName}"
  data-composition-id="${blockName}"
  data-composition-src="compositions/${blockName}.html"
  data-start="0"
  data-duration="5"
  data-track-index="1"
  data-width="1920"
  data-height="1080"
></div>`;
}

/**
 * Get block info from the registry
 */
export async function getBlockInfo(
  blockName: string,
): Promise<BlockInfo | null> {
  try {
    const response = await fetch(
      `${REGISTRY_BASE}/blocks/${blockName}/registry-item.json`,
    );
    if (!response.ok) return null;
    const data = (await response.json()) as {
      name: string;
      compositionId?: string;
      duration?: number;
      width?: number;
      height?: number;
      files?: string[];
    };
    return {
      name: data.name,
      compositionId: data.compositionId ?? blockName,
      duration: data.duration ?? 5,
      width: data.width ?? 1920,
      height: data.height ?? 1080,
      files: data.files ?? [],
    };
  } catch {
    return null;
  }
}
