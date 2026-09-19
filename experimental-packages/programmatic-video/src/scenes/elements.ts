import type { TextElement, ShapeElement, ImageElement } from "../types";

/** Create a text element */
export function text(
  id: string,
  content: string,
  opts?: Partial<Omit<TextElement, "type" | "id" | "content">>,
): TextElement {
  return { type: "text", id, content, ...opts };
}

/** Create a rectangle shape */
export function rect(
  id: string,
  width: number,
  height: number,
  opts?: Partial<Omit<ShapeElement, "type" | "id" | "shape" | "size">>,
): ShapeElement {
  return {
    type: "shape",
    id,
    shape: "rect",
    size: { width, height },
    ...opts,
  };
}

/** Create a circle shape */
export function circle(
  id: string,
  diameter: number,
  opts?: Partial<Omit<ShapeElement, "type" | "id" | "shape" | "size">>,
): ShapeElement {
  return {
    type: "shape",
    id,
    shape: "circle",
    size: { width: diameter, height: diameter },
    ...opts,
  };
}

/** Create an ellipse shape */
export function ellipse(
  id: string,
  width: number,
  height: number,
  opts?: Partial<Omit<ShapeElement, "type" | "id" | "shape" | "size">>,
): ShapeElement {
  return {
    type: "shape",
    id,
    shape: "ellipse",
    size: { width, height },
    ...opts,
  };
}

/** Create an image element */
export function image(
  id: string,
  src: string,
  opts?: Partial<Omit<ImageElement, "type" | "id" | "src">>,
): ImageElement {
  return { type: "image", id, src, ...opts };
}

export const elements = { text, rect, circle, ellipse, image };
