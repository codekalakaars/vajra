import type { CompositionConfig, SceneConfig } from "./types";
import { Scene } from "./scenes/Scene";

/**
 * Composition - the main orchestrator for a HyperFrames video.
 *
 * Generates valid HyperFrames HTML from a declarative configuration.
 */
export class Composition {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  private duration: number;
  private background: string;
  private fontFamily?: string;
  private scenes: Scene[] = [];

  constructor(config: CompositionConfig) {
    this.id = config.id;
    this.width = config.width ?? 1920;
    this.height = config.height ?? 1080;
    this.fps = config.fps ?? 30;
    this.duration = config.duration ?? 0;
    this.background = config.background ?? "#000000";
    this.fontFamily = config.fontFamily;
  }

  /** Add a scene to the composition */
  addScene(config: SceneConfig): Scene {
    const scene = new Scene(config);
    this.scenes.push(scene);
    return scene;
  }

  /** Calculate and return the layout (start times for each scene) */
  private layout(): void {
    let currentTime = 0;
    for (const scene of this.scenes) {
      if (scene.getStart() === 0 && this.scenes.indexOf(scene) > 0) {
        // Auto-layout: start after previous scene
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

  /** Generate the complete HTML file */
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
    lines.push(`    .clip {`);
    lines.push(`      position: absolute;`);
    lines.push(`      inset: 0;`);
    lines.push(`      display: grid;`);
    lines.push(`      place-items: center;`);
    lines.push(`    }`);
    lines.push(`    .scene {`);
    lines.push(`      position: absolute;`);
    lines.push(`      inset: 0;`);
    lines.push(`    }`);

    // Scene CSS
    for (const scene of this.scenes) {
      lines.push(scene.generateCSS());
    }

    lines.push(`  </style>`);
    lines.push(`</head>`);

    // Body
    lines.push(`<body>`);
    lines.push(
      `  <div id="root" data-composition-id="${this.id}" data-width="${this.width}" data-height="${this.height}" data-duration="${this.duration}">`,
    );

    // Scenes as sub-composition hosts
    for (const scene of this.scenes) {
      lines.push(
        `    <section id="${scene.id}" class="clip" data-composition-id="${scene.id}" data-composition-src="compositions/${scene.id}.html" data-start="${scene.getStart()}" data-duration="${scene.duration}" data-track-index="${scene.track}"></section>`,
      );
    }

    lines.push(`  </div>`);

    // Root timeline (near-empty, sub-comps drive themselves)
    lines.push(`  <script>`);
    lines.push(`    window.__timelines = window.__timelines || {};`);
    lines.push(
      `    window.__timelines["${this.id}"] = gsap.timeline({ paused: true });`,
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

  /** Generate all scene files as a map of filename -> content */
  toFiles(): Map<string, string> {
    this.layout();

    const files = new Map<string, string>();
    files.set("index.html", this.toHTML());

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
