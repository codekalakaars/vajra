// Core
export { Composition } from "./Composition";
export { Scene } from "./scenes/Scene";

// Effects
export {
  fadeIn,
  fadeOut,
  slideIn,
  slideOut,
  scaleIn,
  scaleOut,
  rotateIn,
  typewrite,
  blurIn,
  blurOut,
  stagger,
  effects,
} from "./effects/index";

// Elements
export { text, rect, circle, ellipse, image, elements } from "./scenes/elements";

// Render pipeline
export { scaffold, lint, validate, render, build, pipeline } from "./render";

// Types
export type {
  CompositionConfig,
  SceneConfig,
  VariableDeclaration,
  ChildElement,
  TextElement,
  ShapeElement,
  ImageElement,
  Effect,
  EffectType,
  Position,
  Size,
  Color,
  FontFamily,
  Ease,
  Align,
  RenderOptions,
} from "./types";
