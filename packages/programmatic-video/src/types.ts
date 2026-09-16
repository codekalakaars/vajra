/** Position in pixels from top-left */
export interface Position {
  x: number;
  y: number;
}

/** Size in pixels */
export interface Size {
  width: number;
  height: number;
}

/** CSS color value */
export type Color = string;

/** CSS font family */
export type FontFamily = string;

/** Easing function name (GSAP eases) */
export type Ease =
  | "none"
  | "power1.out"
  | "power1.inOut"
  | "power2.out"
  | "power2.inOut"
  | "power3.out"
  | "power3.inOut"
  | "power4.out"
  | "power4.inOut"
  | "back.out"
  | "back.inOut"
  | "elastic.out"
  | "elastic.inOut"
  | "bounce.out"
  | "bounce.inOut"
  | "steps";

/** Alignment options */
export type Align = "left" | "center" | "right" | "top" | "middle" | "bottom";

/** Video composition configuration */
export interface CompositionConfig {
  /** Unique composition ID */
  id: string;
  /** Width in pixels (default: 1920) */
  width?: number;
  /** Height in pixels (default: 1080) */
  height?: number;
  /** Frame rate (default: 30) */
  fps?: number;
  /** Total duration in seconds (auto-calculated if omitted) */
  duration?: number;
  /** Background color (default: "#000000") */
  background?: Color;
  /** Font family for the composition */
  fontFamily?: FontFamily;
  /** CSS variables to expose */
  variables?: VariableDeclaration[];
}

/** Variable declaration for composition */
export interface VariableDeclaration {
  id: string;
  type: "string" | "number" | "color" | "boolean" | "enum";
  label: string;
  default: string | number | boolean;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  placeholder?: string;
  maxLength?: number;
}

/** Scene configuration */
export interface SceneConfig {
  /** Unique scene ID */
  id: string;
  /** Start time in seconds (auto-calculated from previous scene if omitted) */
  start?: number;
  /** Duration in seconds */
  duration: number;
  /** Track index for temporal ordering (default: 1) */
  track?: number;
  /** Scene background color (overrides composition) */
  background?: Color;
  /** Scene opacity (0-1, default: 1) */
  opacity?: number;
  /** CSS classes to add */
  classes?: string[];
  /** Inline styles */
  style?: string;
  /** Child elements */
  children?: ChildElement[];
  /** Animation effects applied to the scene */
  effects?: Effect[];
}

/** Child element types */
export type ChildElement = TextElement | ShapeElement | ImageElement;

/** Text element configuration */
export interface TextElement {
  type: "text";
  id: string;
  content: string;
  position?: Position;
  size?: { fontSize: number; lineHeight?: number };
  color?: Color;
  fontFamily?: FontFamily;
  fontWeight?: number | string;
  textAlign?: "left" | "center" | "right";
  maxWidth?: number;
  style?: string;
  effects?: Effect[];
}

/** Shape element configuration */
export interface ShapeElement {
  type: "shape";
  id: string;
  shape: "rect" | "circle" | "ellipse";
  position?: Position;
  size: Size;
  fill?: Color;
  stroke?: Color;
  strokeWidth?: number;
  borderRadius?: number;
  opacity?: number;
  style?: string;
  effects?: Effect[];
}

/** Image element configuration */
export interface ImageElement {
  type: "image";
  id: string;
  src: string;
  position?: Position;
  size?: Size;
  objectFit?: "cover" | "contain" | "fill" | "none";
  borderRadius?: number;
  opacity?: number;
  style?: string;
  effects?: Effect[];
}

/** Animation effect */
export interface Effect {
  type: EffectType;
  /** Delay in seconds before the effect starts */
  delay?: number;
  /** Duration in seconds */
  duration?: number;
  /** Easing function */
  ease?: Ease;
  /** Effect-specific properties */
  [key: string]: unknown;
}

/** Built-in effect types */
export type EffectType =
  | "fadeIn"
  | "fadeOut"
  | "slideIn"
  | "slideOut"
  | "scaleIn"
  | "scaleOut"
  | "rotateIn"
  | "typewrite"
  | "blurIn"
  | "blurOut";

/** Render options */
export interface RenderOptions {
  /** Output file path */
  output?: string;
  /** Quality: draft or high */
  quality?: "draft" | "high";
  /** Render variables override */
  variables?: Record<string, string | number | boolean>;
  /** Run strict validation */
  strict?: boolean;
  /** Use Docker for reproducible builds */
  docker?: boolean;
}

/** Project scaffold options */
export interface ScaffoldOptions {
  /** Output directory */
  outputDir: string;
  /** Composition configuration */
  config: CompositionConfig;
  /** Scene configurations */
  scenes: SceneConfig[];
}
