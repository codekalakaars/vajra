import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Composition } from "../src/Composition";
import { text, rect, circle, image } from "../src/scenes/elements";
import { fadeIn, fadeOut, slideIn, scaleIn, typewrite } from "../src/effects";
import { scaffold } from "../src/render";
import { existsSync } from "node:fs";
import { join } from "node:path";

describe("Composition", () => {
  it("should generate valid HTML with one scene", () => {
    const comp = new Composition({
      id: "test",
      width: 1920,
      height: 1080,
      duration: 5,
    });

    comp.addScene({
      id: "scene-1",
      start: 0,
      duration: 5,
      children: [
        text("title", "Hello World", {
          position: { x: 100, y: 100 },
          size: { fontSize: 96 },
          color: "#ffffff",
        }),
      ],
    });

    const html = comp.toHTML();

    assert.ok(html.includes('data-composition-id="test"'));
    assert.ok(html.includes('data-width="1920"'));
    assert.ok(html.includes('data-height="1080"'));
    assert.ok(html.includes('data-duration="5"'));
    assert.ok(html.includes('data-composition-src="compositions/scene-1.html"'));

    // Text content is in the sub-composition, not the main HTML
    const files = comp.toFiles();
    const sceneHTML = files.get("compositions/scene-1.html")!;
    assert.ok(sceneHTML.includes("Hello World"));
  });

  it("should auto-layout scenes sequentially", () => {
    const comp = new Composition({
      id: "test",
      width: 1920,
      height: 1080,
    });

    comp.addScene({ id: "a", duration: 3 });
    comp.addScene({ id: "b", duration: 4 });
    comp.addScene({ id: "c", duration: 2 });

    const html = comp.toHTML();

    assert.ok(html.includes('data-start="0" data-duration="3"'));
    assert.ok(html.includes('data-start="3" data-duration="4"'));
    assert.ok(html.includes('data-start="7" data-duration="2"'));
    assert.ok(html.includes('data-duration="9"'));
  });

  it("should generate scene sub-composition HTML", () => {
    const comp = new Composition({
      id: "test",
      width: 1920,
      height: 1080,
    });

    comp.addScene({
      id: "scene-1",
      duration: 5,
      children: [
        text("title", "Hello", {
          position: { x: 100, y: 100 },
          size: { fontSize: 96 },
        }),
      ],
    });

    const files = comp.toFiles();

    assert.ok(files.has("index.html"));
    assert.ok(files.has("compositions/scene-1.html"));
    assert.ok(files.has("STORYBOARD.md"));

    const sceneHTML = files.get("compositions/scene-1.html")!;
    assert.ok(sceneHTML.includes("<template>"));
    assert.ok(sceneHTML.includes('data-composition-id="scene-1"'));
    assert.ok(sceneHTML.includes("window.__timelines"));
    assert.ok(sceneHTML.includes("Hello"));
  });

  it("should apply effects to timeline", () => {
    const comp = new Composition({
      id: "test",
      width: 1920,
      height: 1080,
    });

    comp.addScene({
      id: "scene-1",
      duration: 5,
      effects: [fadeIn({ delay: 0.2 })],
      children: [
        text("title", "Hello", {
          position: { x: 100, y: 100 },
          size: { fontSize: 96 },
          effects: [slideIn("left", 80, { delay: 0.5 })],
        }),
      ],
    });

    const files = comp.toFiles();
    const sceneHTML = files.get("compositions/scene-1.html")!;

    assert.ok(sceneHTML.includes("fromTo"));
    assert.ok(sceneHTML.includes("opacity:0"));
    assert.ok(sceneHTML.includes("opacity:1"));
    assert.ok(sceneHTML.includes("x:-80"));
    assert.ok(sceneHTML.includes("x:0"));
  });

  it("should generate media elements as root children", () => {
    const comp = new Composition({
      id: "test",
      width: 1920,
      height: 1080,
      media: [
        {
          type: "video",
          id: "bg-video",
          src: "assets/background.mp4",
          start: 0,
          duration: 10,
          track: 0,
          style: "position:absolute; left:0; top:0; width:100%; height:100%; object-fit:cover;",
        },
        {
          type: "audio",
          id: "bgm",
          src: "assets/music.mp3",
          start: 0,
          duration: 10,
          track: 10,
          volume: 0.6,
        },
      ],
    });

    comp.addScene({
      id: "scene-1",
      duration: 10,
      children: [text("title", "Video")],
    });

    const html = comp.toHTML();

    // Media must be direct root children in index.html
    assert.ok(html.includes('<video id="bg-video"'));
    assert.ok(html.includes('<audio id="bgm"'));
    assert.ok(html.includes('src="assets/background.mp4"'));
    assert.ok(html.includes('src="assets/music.mp3"'));
    assert.ok(html.includes('data-volume="0.6"'));
  });

  it("should support shared background pattern", () => {
    const comp = new Composition({
      id: "test",
      width: 1920,
      height: 1080,
      background: "#0a0a0a",
      sharedBackground: true,
    });

    comp.addScene({
      id: "scene-1",
      duration: 5,
      children: [text("title", "Hello")],
    });

    const html = comp.toHTML();

    // Should have shared background div
    assert.ok(html.includes('<div id="bg"></div>'));
    // Scenes should use .scene class, not .clip
    assert.ok(html.includes('class="scene"'));
    assert.ok(!html.includes('class="clip"'));
  });

  it("should generate variables JSON", () => {
    const comp = new Composition({
      id: "test",
      width: 1920,
      height: 1080,
      variables: [
        { id: "title", type: "string", label: "Title", default: "Hello" },
        { id: "accent", type: "color", label: "Accent", default: "#ff0000" },
      ],
    });

    comp.addScene({
      id: "scene-1",
      duration: 5,
      children: [text("title", "Hello")],
    });

    const html = comp.toHTML();

    assert.ok(html.includes("data-composition-variables"));
    assert.ok(html.includes('"title"'));
    assert.ok(html.includes('"accent"'));
  });

  it("should generate STORYBOARD.md", () => {
    const comp = new Composition({
      id: "test-video",
      width: 1920,
      height: 1080,
    });

    comp.addScene({ id: "intro", duration: 3 });
    comp.addScene({ id: "body", duration: 5 });
    comp.addScene({ id: "outro", duration: 2 });

    const files = comp.toFiles();
    const storyboard = files.get("STORYBOARD.md")!;

    assert.ok(storyboard.includes("format: 1920x1080"));
    assert.ok(storyboard.includes("## Frame 1 — intro"));
    assert.ok(storyboard.includes("## Frame 2 — body"));
    assert.ok(storyboard.includes("## Frame 3 — outro"));
    assert.ok(storyboard.includes("- duration: 3s"));
    assert.ok(storyboard.includes("- duration: 5s"));
    assert.ok(storyboard.includes("- duration: 2s"));
  });
});

describe("Elements", () => {
  it("text() creates a text element", () => {
    const el = text("t1", "Hello", {
      position: { x: 10, y: 20 },
      size: { fontSize: 48 },
      color: "#ff0000",
    });

    assert.equal(el.type, "text");
    assert.equal(el.id, "t1");
    assert.equal(el.content, "Hello");
    assert.deepEqual(el.position, { x: 10, y: 20 });
    assert.equal(el.size?.fontSize, 48);
    assert.equal(el.color, "#ff0000");
  });

  it("rect() creates a rectangle", () => {
    const el = rect("r1", 200, 100, { fill: "#00ff00" });

    assert.equal(el.type, "shape");
    assert.equal(el.shape, "rect");
    assert.deepEqual(el.size, { width: 200, height: 100 });
    assert.equal(el.fill, "#00ff00");
  });

  it("circle() creates a circle", () => {
    const el = circle("c1", 50);

    assert.equal(el.type, "shape");
    assert.equal(el.shape, "circle");
    assert.deepEqual(el.size, { width: 50, height: 50 });
  });

  it("image() creates an image element", () => {
    const el = image("i1", "/path/to/image.png", {
      position: { x: 0, y: 0 },
      size: { width: 1920, height: 1080 },
    });

    assert.equal(el.type, "image");
    assert.equal(el.src, "/path/to/image.png");
  });
});

describe("Effects", () => {
  it("fadeIn creates correct effect", () => {
    const e = fadeIn({ delay: 0.5 });
    assert.equal(e.type, "fadeIn");
    assert.equal(e.delay, 0.5);
  });

  it("slideIn creates correct effect", () => {
    const e = slideIn("right", 100);
    assert.equal(e.type, "slideIn");
    assert.deepEqual((e as any).from, { x: 100, y: 0 });
  });

  it("scaleIn creates correct effect", () => {
    const e = scaleIn(0.5);
    assert.equal(e.type, "scaleIn");
    assert.equal((e as any).from, 0.5);
  });
});

describe("Render pipeline", () => {
  it("should scaffold a project", () => {
    const comp = new Composition({
      id: "test-scaffold",
      width: 1920,
      height: 1080,
    });

    comp.addScene({
      id: "scene-1",
      duration: 5,
      children: [text("t", "Hello")],
    });

    const result = scaffold(comp, "/tmp/test-programmatic-video");

    assert.ok(result.dir === "/tmp/test-programmatic-video");
    assert.ok(result.files.length > 0);
    assert.ok(existsSync(join(result.dir, "index.html")));
    assert.ok(existsSync(join(result.dir, "compositions", "scene-1.html")));
    assert.ok(existsSync(join(result.dir, "STORYBOARD.md")));
  });
});
