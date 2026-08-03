import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const testDir = import.meta.dirname;
const repoDir = resolve(testDir, "../../..");
const skillPath = resolve(repoDir, "skills/ego-browser/SKILL.md");
const packagedSkillPath = resolve(
  repoDir,
  "platform/electron/dist/linux-unpacked/resources/ego-lite/ego-browser/SKILL.md",
);

const staleGlobals = [
  "cliLog",
  "snapshotText",
  "captureScreenshot",
  "useOrCreateTaskSpace",
  "completeTaskSpace",
];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function assertCurrentSkill(path) {
  const content = await readFile(path, "utf8");
  assert.match(content, /taskSpaces\.useOrCreate/);
  assert.match(content, /browser\.openOrReuseTab/);
  assert.match(content, /page\.snapshot/);
  assert.match(content, /console\.log/);
  for (const name of staleGlobals) {
    assert.equal(
      content.includes(name),
      false,
      `${path} still documents removed helper ${name}`,
    );
  }
}

await assertCurrentSkill(skillPath);
if (process.env.EGO_LITE_CHECK_PACKAGED_SKILL === "1") {
  assert.equal(
    await exists(packagedSkillPath),
    true,
    `packaged skill missing at ${packagedSkillPath}`,
  );
  await assertCurrentSkill(packagedSkillPath);
}

console.log("skill contract: passed");
