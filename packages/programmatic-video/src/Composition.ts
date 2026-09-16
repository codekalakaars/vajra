import type {
  CompositionConfig,
  SceneConfig,
  MediaElement,
  RegistryBlock,
} from "./types";
import { Scene } from "./scenes/Scene";

/**
 * Composition - the main orchestrator for a HyperFrames video.
 *
 * Generates valid HyperFrames HTML from a declarative configuration.
 * Follows HyperFrames conventions:
 * - Sub-compositions via <template> transport
 * - Media as direct root children
 * - Shared background pattern for full-screen motion
 * - Proper data-* attributes
 */
export class Composition {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  private duration: number;
  private background: string;
  private fontFamily?: string;
  private variables: { id: string; type: string; label: string; default: string | number | boolean }[];
  private media: MediaElement[];
  private sharedBackground: boolean;
  private scenes: Scene[] = [];
  private blocks: RegistryBlock[] = [];

  constructor(config: CompositionConfig) {
    this.id = config.id;
    this.width = config.width ?? 1920;
    this.height = config.height ?? 1080;
    this.fps = config.fps ?? 30;
    this.duration = config.duration ?? 0;
    this.background = config.background ?? "#000000";
    this.fontFamily = config.fontFamily;
    this.variables = (config.variables ?? []).map((v) => ({
      id: v.id,
      type: v.type,
      label: v.label,
      default: v.default,
    }));
    this.media = config.media ?? [];
    this.sharedBackground = config.sharedBackground ?? false;
  }

  /** Add a scene to the composition */
  addScene(config: SceneConfig): Scene {
    const scene = new Scene(config);
    this.scenes.push(scene);
    return scene;
  }

  /** Add a registry block to the composition */
  addBlock(block: RegistryBlock): void {
    this.blocks.push(block);
  }

  /** Calculate and return the layout (start times for each scene) */
  private layout(): void {
    let currentTime = 0;
    for (const scene of this.scenes) {
      if (scene.getStart() === 0 && this.scenes.indexOf(scene) > 0) {
        scene.setStart(currentTime);
      }
      currentTime = scene.getStart() + scene.duration;
    }

    // Auto-calculate total duration if not specified
    if (this.duration === 0 && this.scenes.length > 0) {
      this.duration = Math.max(
        ...this.scenes.map((s) => s.getStart() + s.duration),
      );
    }
  }

  /** Generate data-composition-variables JSON */
  private generateVariablesJSON(): string {
    if (this.variables.length === 0) return "";
    return JSON.stringify(this.variables);
  }

  /** Generate the complete HTML file (index.html) */
  toHTML(): string {
    this.layout();

    const lines: string[] = [];

    // DOCTYPE
    lines.push(`<!doctype html>`);
    lines.push(`<html lang="en">`);

    // Head
    lines.push(`<head>`);
    lines.push(`  <meta charset="UTF-8" />`);
    lines.push(
      `  <meta name="viewport" content="width=${this.width}, height=${this.height}" />`,
    );
    lines.push(`  <title>${this.id}</title>`);
    lines.push(
      `  <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>`,
    );

    // Variables on <html>
    const varsJSON = this.generateVariablesJSON();
    if (varsJSON) {
      lines.push(`</head>`);
      lines.push(`<html data-composition-variables='${varsJSON}'>`);
      lines.push(`<head>`);
    }

    // CSS
    lines.push(`  <style>`);
    lines.push(`    body {`);
    lines.push(`      margin: 0;`);
    lines.push(`      background: ${this.background};`);
    lines.push(`      color: #ffffff;`);
    if (this.fontFamily) {
      lines.push(`      font-family: ${this.fontFamily};`);
    }
    lines.push(`    }`);
    lines.push(`    #root {`);
    lines.push(`      position: relative;`);
    lines.push(`      width: ${this.width}px;`);
    lines.push(`      height: ${this.height}px;`);
    lines.push(`      overflow: hidden;`);
    lines.push(`    }`);

    // Full-screen background pattern
    if (this.sharedBackground) {
      lines.push(`    #bg {`);
      lines.push(`      position: absolute;`);
      lines.push(`      inset: 0;`);
      lines.push(`      background: ${this.background};`);
      lines.push(`    }`);
      lines.push(`    .scene {`);
      lines.push(`      position: absolute;`);
      lines.push(`      inset: 0;`);
      lines.push(`    }`);
    } else {
      lines.push(`    .clip {`);
      lines.push(`      position: absolute;`);
      lines.push(`      inset: 0;`);
      lines.push(`    }`);
      lines.push(`    .scene {`);
      lines.push(`      position: absolute;`);
      lines.push(`      inset: 0;`);
      lines.push(`    }`);
    }

    // Scene CSS
    for (const scene of this.scenes) {
      lines.push(scene.generateCSS());
    }

    lines.push(`  </style>`);
    lines.push(`</head>`);

    // Body
    lines.push(`<body>`);

    // Root div
    if (varsJSON) {
      lines.push(
        `  <div id="root" data-composition-id="${this.id}" data-width="${this.width}" data-height="${this.height}" data-duration="${this.duration}">`,
      );
    } else {
      lines.push(
        `  <div id="root" data-composition-id="${this.id}" data-width="${this.width}" data-height="${this.height}" data-duration="${this.duration}">`,
      );
    }

    // Shared background (full-screen motion pattern)
    if (this.sharedBackground) {
      lines.push(`    <div id="bg"></div>`);
    }

    // Scenes as sub-composition hosts
    for (const scene of this.scenes) {
      const classes = this.sharedBackground ? "scene" : "clip";
      lines.push(
        `    <section id="${scene.id}" class="${classes}" data-composition-id="${scene.id}" data-composition-src="compositions/${scene.id}.html" data-start="${scene.getStart()}" data-duration="${scene.duration}" data-track-index="${scene.track}"></section>`,
      );
    }

    // Registry blocks
    for (const block of this.blocks) {
      lines.push(
        `    <div id="block-${block.name}" data-composition-id="${block.compositionId}" data-composition-src="compositions/${block.src}" data-start="0" data-duration="${block.duration}" data-track-index="${block.track ?? 1}" data-width="${block.width ?? this.width}" data-height="${block.height ?? this.height}"></div>`,
      );
    }

    // Media elements - DIRECT root children (HyperFrames requirement)
    for (const m of this.media) {
      if (m.type === "video") {
        const attrs = [
          `id="${m.id}"`,
          `class="clip"`,
          `src="${m.src}"`,
          `data-start="${m.start}"`,
          `data-duration="${m.duration}"`,
          `data-track-index="${m.track ?? 0}"`,
          `muted`,
          `playsinline`,
          `crossorigin="anonymous"`,
        ];
        if (m.hasAudio) attrs.push(`data-has-audio="true"`);
        if (m.style) attrs.push(`style="${m.style}"`);
        lines.push(`    <video ${attrs.join(" ")}></video>`);
      } else {
        lines.push(
          `    <audio id="${m.id}" src="${m.src}" data-start="${m.start}" data-duration="${m.duration}" data-track-index="${m.track ?? 10}" data-volume="${m.volume ?? 1}"></audio>`,
        );
      }
    }

    lines.push(`  </div>`);

    // Root timeline
    lines.push(`  <script>`);
    lines.push(`    window.__timelines = window.__timelines || {};`);
    lines.push(
      `    const tl = gsap.timeline({ paused: true });`,
    );

    // Shared background animations
    if (this.sharedBackground) {
      lines.push(
        `    tl.set("#bg", { backgroundColor: "${this.background}" }, 0);`,
      );
    }

    // Media animations from main timeline (for scene-specific media)
    for (const m of this.media) {
      if (m.type === "video" && m.style) {
        // Media animations are driven from the main timeline
        // The style attribute handles positioning
      }
    }

    lines.push(
      `    window.__timelines["${this.id}"] = tl;`,
    );
    lines.push(`  </script>`);

    lines.push(`</body>`);
    lines.push(`</html>`);

    return lines.join("\n");
  }

  /** Generate sub-composition HTML for a scene */
  toSceneHTML(scene: Scene): string {
    const lines: string[] = [];

    lines.push(`<!doctype html>`);
    lines.push(`<html>`);
    lines.push(`<head>`);
    lines.push(`  <meta charset="UTF-8" />`);
    lines.push(`</head>`);
    lines.push(`<body>`);
    lines.push(`  <template>`);
    lines.push(`    <style>`);
    lines.push(`      #root {`);
    lines.push(`        position: absolute;`);
    lines.push(`        inset: 0;`);
    lines.push(`      }`);
    lines.push(`      .child {`);
    lines.push(`        position: absolute;`);
    lines.push(`      }`);
    lines.push(scene.generateCSS());
    lines.push(`    </style>`);

    lines.push(
      `    <div id="root" data-composition-id="${scene.id}" data-width="${this.width}" data-height="${this.height}" data-duration="${scene.duration}">`,
    );
    lines.push(scene.generateHTML());
    lines.push(`    </div>`);

    lines.push(`    <script>`);
    lines.push(`      window.__timelines = window.__timelines || {};`);
    lines.push(`      const tl = gsap.timeline({ paused: true });`);
    lines.push(scene.generateTimeline(scene.getStart()));
    lines.push(
      `      window.__timelines["${scene.id}"] = tl;`,
    );
    lines.push(`    </script>`);

    lines.push(`  </template>`);
    lines.push(`</body>`);
    lines.push(`</html>`);

    return lines.join("\n");
  }

  /** Generate STORYBOARD.md */
  toStoryboard(): string {
    this.layout();

    const lines: string[] = [];

    // Frontmatter
    lines.push(`---`);
    lines.push(`format: ${this.width}x${this.height}`);
    lines.push(`message: "${this.id}"`);
    lines.push(`---`);
    lines.push(``);

    // Frames
    for (let i = 0; i < this.scenes.length; i++) {
      const scene = this.scenes[i];
      const frameNum = i + 1;

      lines.push(`## Frame ${frameNum} — ${scene.id}`);
      lines.push(``);
      lines.push(`- scene: ${scene.id}`);
      lines.push(`- duration: ${scene.duration}s`);
      lines.push(`- status: built`);
      lines.push(`- src: compositions/${scene.id}.html`);
      lines.push(``);
    }

    return lines.join("\n");
  }

  /** Generate all files as a map of filename -> content */
  toFiles(): Map<string, string> {
    this.layout();

    const files = new Map<string, string>();
    files.set("index.html", this.toHTML());
    files.set("STORYBOARD.md", this.toStoryboard());

    for (const scene of this.scenes) {
      files.set(`compositions/${scene.id}.html`, this.toSceneHTML(scene));
    }

    return files;
  }

  /** Get the total duration */
  getDuration(): number {
    this.layout();
    return this.duration;
  }

  /** Get all scenes */
  getScenes(): Scene[] {
    return this.scenes;
  }
}
