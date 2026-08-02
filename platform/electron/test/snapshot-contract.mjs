import assert from "node:assert/strict";
import test from "node:test";

import {
  nodesWithinViewport,
  renderAccessibilityTree,
  snapshotAccessibilityTree,
} from "../../linux/ego-browser.mjs";

const fixtureNodes = [
  {
    nodeId: "root",
    role: { value: "RootWebArea" },
    name: { value: "Snapshot fixture" },
    childIds: ["heading", "button", "offscreen"],
    backendDOMNodeId: 1,
  },
  {
    nodeId: "heading",
    role: { value: "heading" },
    name: { value: "Snapshot fixture" },
    childIds: [],
    backendDOMNodeId: 2,
  },
  {
    nodeId: "button",
    role: { value: "button" },
    name: { value: "Increment counter" },
    childIds: [],
    backendDOMNodeId: 3,
  },
  {
    nodeId: "offscreen",
    role: { value: "paragraph" },
    name: { value: "Below the fold" },
    childIds: [],
    backendDOMNodeId: 4,
  },
];

test("snapshot renderer emits action marks and stable role locators", () => {
  const result = renderAccessibilityTree(fixtureNodes, {
    includeActionMarks: true,
    includeStableLocator: true,
  });

  assert.match(
    result.content,
    /- button "Increment counter" \[ref=3, loc=role:button\[name="Increment counter"\]\]/,
  );
  assert.doesNotMatch(result.content, /heading "Snapshot fixture" \[ref=/);
  assert.deepEqual(result.refs, [
    { backendNodeId: 3, role: "button", name: "Increment counter" },
  ]);
});

test("snapshot renderer honors compact options and result limits", () => {
  const result = renderAccessibilityTree(fixtureNodes, {
    includeActionMarks: false,
    includeStableLocator: false,
    maxResultLength: 45,
  });

  assert.doesNotMatch(result.content, /\[ref=/);
  assert.doesNotMatch(result.content, /loc=/);
  assert.deepEqual(result.refs, []);
  assert.match(result.content, /…$/);
});

test("viewport scope keeps visible nodes and their accessibility ancestors", async () => {
  const boxes = new Map([
    [1, [0, 0, 800, 0, 800, 600, 0, 600]],
    [2, [20, 20, 220, 20, 220, 60, 20, 60]],
    [3, [20, 80, 220, 80, 220, 130, 20, 130]],
    [4, [20, 900, 220, 900, 220, 950, 20, 950]],
  ]);
  const connection = {
    async request(method, params) {
      if (method === "Page.getLayoutMetrics") {
        return {
          cssVisualViewport: {
            pageX: 0,
            pageY: 0,
            clientWidth: 800,
            clientHeight: 600,
          },
        };
      }
      if (method === "DOM.getBoxModel") {
        return { model: { border: boxes.get(params.backendNodeId) } };
      }
      throw new Error(`unexpected CDP method: ${method}`);
    },
  };

  const scoped = await nodesWithinViewport(connection, "session", fixtureNodes);
  assert.deepEqual(
    scoped.map((node) => node.nodeId),
    ["root", "heading", "button"],
  );
});

test("snapshot accessibility tree includes nested frame content and frame refs", async () => {
  const trees = new Map([
    [
      "root-frame",
      [
        {
          nodeId: "root",
          role: { value: "RootWebArea" },
          childIds: ["owner"],
          backendDOMNodeId: 1,
        },
        {
          nodeId: "owner",
          role: { value: "Iframe" },
          name: { value: "Child frame" },
          childIds: [],
          backendDOMNodeId: 2,
        },
        { nodeId: "ignored-a", ignored: true, childIds: [] },
        { nodeId: "ignored-b", ignored: true, childIds: [] },
      ],
    ],
    [
      "child-frame",
      [
        {
          nodeId: "child-root",
          role: { value: "RootWebArea" },
          childIds: ["child-button"],
          backendDOMNodeId: 10,
        },
        {
          nodeId: "child-button",
          role: { value: "button" },
          name: { value: "Child action" },
          childIds: [],
          backendDOMNodeId: 11,
        },
        { nodeId: "ignored-a", ignored: true, childIds: [] },
        { nodeId: "ignored-b", ignored: true, childIds: [] },
      ],
    ],
  ]);
  const connection = {
    async request(method, params) {
      if (method === "Page.getFrameTree") {
        return {
          frameTree: {
            frame: { id: "root-frame" },
            childFrames: [{ frame: { id: "child-frame", parentId: "root-frame" } }],
          },
        };
      }
      if (method === "Accessibility.getFullAXTree") {
        return { nodes: trees.get(params.frameId) };
      }
      if (method === "DOM.getFrameOwner") return { backendNodeId: 2 };
      return {};
    },
  };

  const nodes = await snapshotAccessibilityTree(connection, "session");
  const rendered = renderAccessibilityTree(nodes, {
    includeActionMarks: true,
    includeStableLocator: true,
  });
  assert.match(rendered.content, /Iframe "Child frame"/);
  assert.match(rendered.content, /button "Child action" \[ref=11\]/);
  assert.doesNotMatch(rendered.content, /Child action.*loc=role/);
  assert.deepEqual(rendered.refs, [
    {
      backendNodeId: 11,
      role: "button",
      name: "Child action",
      frameId: "child-frame",
    },
  ]);
});
