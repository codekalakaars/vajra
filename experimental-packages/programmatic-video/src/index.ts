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

// Registry
export {
  fetchRegistry,
  fetchExamples,
  fetchBlocks,
  fetchComponents,
  installBlock,
  initFromExample,
  getBlockInfo,
} from "./registry";

// Render pipeline
export { scaffold, lint, validate, render, build, pipeline } from "./render";

// Types
export type {
  CompositionConfig,
  SceneConfig,
  VariableDeclaration,
  MediaElement,
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
  StoryboardFrame,
  RegistryBlock,
} from "./types";

export type {
  RegistryItem,
  BlockInfo,
  ExampleInfo,
} from "./registry";
