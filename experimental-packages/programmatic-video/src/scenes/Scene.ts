import type {
  SceneConfig,
  ChildElement,
  Effect,
  TextElement,
  ShapeElement,
  ImageElement,
} from "../types";

/**
 * Scene - represents a timed segment of a HyperFrames composition.
 *
 * Each scene generates:
 * 1. HTML markup for child elements (text, shapes, images)
 * 2. GSAP timeline tweens for animation effects
 */
export class Scene {
  readonly id: string;
  readonly duration: number;
  readonly track: number;
  private start: number;
  private background?: string;
  private opacity: number;
  private classes: string[];
  private style: string;
  private children: ChildElement[];
  private effects: Effect[];

  constructor(config: SceneConfig) {
    this.id = config.id;
    this.duration = config.duration;
    this.track = config.track ?? 1;
    this.start = config.start ?? 0;
    this.background = config.background;
    this.opacity = config.opacity ?? 1;
    this.classes = config.classes ?? [];
    this.style = config.style ?? "";
    this.children = config.children ?? [];
    this.effects = config.effects ?? [];
  }

  /** Set the start time (called by Composition during layout) */
  setStart(time: number): void {
    this.start = time;
  }

  /** Get the start time */
  getStart(): number {
    return this.start;
  }

  /** Add a child element to the scene */
  addChild(child: ChildElement): this {
    this.children.push(child);
    return this;
  }

  /** Add an animation effect to the scene */
  addEffect(effect: Effect): this {
    this.effects.push(effect);
    return this;
  }

  /** Generate CSS for this scene */
  generateCSS(): string {
    const lines: string[] = [];
    lines.push(`#${this.id} {`);
    lines.push(`  position: absolute;`);
    lines.push(`  inset: 0;`);
    if (this.background) {
      lines.push(`  background: ${this.background};`);
    }
    if (this.opacity !== 1) {
      lines.push(`  opacity: ${this.opacity};`);
    }
    lines.push(`  overflow: hidden;`);
    if (this.style) {
      lines.push(`  ${this.style}`);
    }
    lines.push(`}`);

    // Child element styles
    for (const child of this.children) {
      lines.push(this.generateChildCSS(child));
    }

    return lines.join("\n");
  }

  /** Generate HTML for this scene */
  generateHTML(): string {
    const lines: string[] = [];
    const classes = ["scene", ...this.classes].join(" ");

    lines.push(
      `<section id="${this.id}" class="${classes}" data-start="${this.start}" data-duration="${this.duration}" data-track-index="${this.track}">`,
    );

    for (const child of this.children) {
      lines.push(this.generateChildHTML(child));
    }

    lines.push(`</section>`);
    return lines.join("\n");
  }

  /** Generate GSAP timeline tweens for this scene's effects */
  generateTimeline(sceneStartTime: number): string {
    const lines: string[] = [];
    const t = sceneStartTime;

    // Scene-level effects
    for (const effect of this.effects) {
      const delay = effect.delay ?? 0;
      const dur = effect.duration ?? 0.6;
      const ease = effect.ease ?? "power3.out";
      const target = `#${this.id}`;

      switch (effect.type) {
        case "fadeIn":
          lines.push(
            `  tl.fromTo("${target}", {opacity:0}, {opacity:1, duration:${dur}, ease:"${ease}"}, ${t + delay});`,
          );
          break;
        case "fadeOut":
          lines.push(
            `  tl.to("${target}", {opacity:0, duration:${dur}, ease:"${ease}"}, ${t + delay});`,
          );
          break;
        case "slideIn": {
          const from = (effect.from as { x: number; y: number }) ?? {
            x: -80,
            y: 0,
          };
          lines.push(
            `  tl.fromTo("${target}", {x:${from.x}, y:${from.y}, opacity:0}, {x:0, y:0, opacity:1, duration:${dur}, ease:"${ease}"}, ${t + delay});`,
          );
          break;
        }
        case "scaleIn": {
          const scaleFrom = (effect.from as number) ?? 0;
          lines.push(
            `  tl.fromTo("${target}", {scale:${scaleFrom}, opacity:0}, {scale:1, opacity:1, duration:${dur}, ease:"${ease}"}, ${t + delay});`,
          );
          break;
        }
        case "rotateIn": {
          const rotFrom = (effect.from as number) ?? -15;
          lines.push(
            `  tl.fromTo("${target}", {rotation:${rotFrom}, opacity:0}, {rotation:0, opacity:1, duration:${dur}, ease:"${ease}"}, ${t + delay});`,
          );
          break;
        }
        case "blurIn": {
          const blurFrom = (effect.from as number) ?? 10;
          lines.push(
            `  tl.fromTo("${target}", {filter:"blur(${blurFrom}px)", opacity:0}, {filter:"blur(0px)", opacity:1, duration:${dur}, ease:"${ease}"}, ${t + delay});`,
          );
          break;
        }
      }
    }

    // Child element effects
    for (const child of this.children) {
      if (child.effects) {
        for (const effect of child.effects) {
          const delay = effect.delay ?? 0;
          const dur = effect.duration ?? 0.6;
          const ease = effect.ease ?? "power3.out";
          const target = `#${child.id}`;

          switch (effect.type) {
            case "fadeIn":
              lines.push(
                `  tl.fromTo("${target}", {opacity:0}, {opacity:1, duration:${dur}, ease:"${ease}"}, ${t + delay});`,
              );
              break;
            case "fadeOut":
              lines.push(
                `  tl.to("${target}", {opacity:0, duration:${dur}, ease:"${ease}"}, ${t + delay});`,
              );
              break;
            case "slideIn": {
              const from = (effect.from as { x: number; y: number }) ?? {
                x: -80,
                y: 0,
              };
              lines.push(
                `  tl.fromTo("${target}", {x:${from.x}, y:${from.y}, opacity:0}, {x:0, y:0, opacity:1, duration:${dur}, ease:"${ease}"}, ${t + delay});`,
              );
              break;
            }
            case "scaleIn": {
              const scaleFrom = (effect.from as number) ?? 0;
              lines.push(
                `  tl.fromTo("${target}", {scale:${scaleFrom}, opacity:0}, {scale:1, opacity:1, duration:${dur}, ease:"${ease}"}, ${t + delay});`,
              );
              break;
            }
            case "rotateIn": {
              const rotFrom = (effect.from as number) ?? -15;
              lines.push(
                `  tl.fromTo("${target}", {rotation:${rotFrom}, opacity:0}, {rotation:0, opacity:1, duration:${dur}, ease:"${ease}"}, ${t + delay});`,
              );
              break;
            }
            case "blurIn": {
              const blurFrom = (effect.from as number) ?? 10;
              lines.push(
                `  tl.fromTo("${target}", {filter:"blur(${blurFrom}px)", opacity:0}, {filter:"blur(0px)", opacity:1, duration:${dur}, ease:"${ease}"}, ${t + delay});`,
              );
              break;
            }
            case "typewrite": {
              lines.push(
                `  tl.fromTo("${target}", {opacity:0}, {opacity:1, duration:0.05, ease:"none"}, ${t + delay});`,
              );
              break;
            }
          }
        }
      }
    }

    return lines.join("\n");
  }

  private generateChildCSS(child: ChildElement): string {
    const lines: string[] = [];
    lines.push(`#${child.id} {`);
    lines.push(`  position: absolute;`);

    if (child.position) {
      lines.push(`  left: ${child.position.x}px;`);
      lines.push(`  top: ${child.position.y}px;`);
    }

    switch (child.type) {
      case "text": {
        const t = child as TextElement;
        if (t.size) {
          lines.push(`  font-size: ${t.size.fontSize}px;`);
          if (t.size.lineHeight)
            lines.push(`  line-height: ${t.size.lineHeight}px;`);
        }
        if (t.color) lines.push(`  color: ${t.color};`);
        if (t.fontFamily) lines.push(`  font-family: ${t.fontFamily};`);
        if (t.fontWeight) lines.push(`  font-weight: ${t.fontWeight};`);
        if (t.textAlign) lines.push(`  text-align: ${t.textAlign};`);
        if (t.maxWidth) lines.push(`  max-width: ${t.maxWidth}px;`);
        lines.push(`  white-space: pre-wrap;`);
        break;
      }
      case "shape": {
        const s = child as ShapeElement;
        if (s.fill) lines.push(`  background: ${s.fill};`);
        if (s.stroke) {
          lines.push(`  border: ${s.strokeWidth ?? 1}px solid ${s.stroke};`);
        }
        if (s.borderRadius !== undefined) {
          if (s.shape === "circle") {
            lines.push(`  border-radius: 50%;`);
          } else {
            lines.push(`  border-radius: ${s.borderRadius}px;`);
          }
        }
        if (s.size) {
          lines.push(`  width: ${s.size.width}px;`);
          lines.push(`  height: ${s.size.height}px;`);
        }
        if (s.opacity !== undefined) {
          lines.push(`  opacity: ${s.opacity};`);
        }
        break;
      }
      case "image": {
        const i = child as ImageElement;
        if (i.size) {
          lines.push(`  width: ${i.size.width}px;`);
          lines.push(`  height: ${i.size.height}px;`);
        }
        if (i.objectFit) lines.push(`  object-fit: ${i.objectFit};`);
        if (i.borderRadius !== undefined) {
          lines.push(`  border-radius: ${i.borderRadius}px;`);
        }
        if (i.opacity !== undefined) {
          lines.push(`  opacity: ${i.opacity};`);
        }
        break;
      }
    }

    if (child.style) {
      lines.push(`  ${child.style}`);
    }

    lines.push(`}`);
    return lines.join("\n");
  }

  private generateChildHTML(child: ChildElement): string {
    switch (child.type) {
      case "text": {
        const t = child as TextElement;
        const escaped = t.content
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        return `  <div id="${child.id}" class="child">${escaped}</div>`;
      }
      case "shape": {
        return `  <div id="${child.id}" class="child"></div>`;
      }
      case "image": {
        const i = child as ImageElement;
        return `  <img id="${child.id}" class="child" src="${i.src}" crossorigin="anonymous" />`;
      }
    }
  }
}
