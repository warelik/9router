import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../../.github/workflows/docker-publish.yml", import.meta.url), "utf8");
const currentRecipe = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
const sourceCheckout = workflow.match(
  /      - name: Check out release source at validated commit\n([\s\S]*?)(?=\n      - name:)/
)?.[1];
const imageBuild = workflow.match(
  /      - name: Build and push platform image by digest\n([\s\S]*?)(?=\n      - name:)/
)?.[1];

describe("Docker publishing uses the selected release's recipe", () => {
  it("keeps source checkout pinned to the validated commit", () => {
    expect(sourceCheckout).toContain("ref: ${{ needs.prepare.outputs.commit }}");
    expect(sourceCheckout).toContain("path: source");
    expect(sourceCheckout).not.toContain("ref: ${{ github.ref_name }}");
    expect(sourceCheckout).not.toContain("ref: ${{ github.workflow_sha }}");
  });

  it.each([
    { label: "a pre-shrinkwrap release", hasShrinkwrap: false },
    { label: "a locked release", hasShrinkwrap: true },
  ])("uses the release-owned Dockerfile for $label", ({ hasShrinkwrap }) => {
    expect(imageBuild).toBeDefined();
    const context = imageBuild.match(/^          context: (\S+)$/m)?.[1];
    const configuredFile = imageBuild.match(/^          file: (\S+)$/m)?.[1];
    expect(context).toBe("source");
    // The existing v6 action defaults its file input to {context}/Dockerfile.
    const selectedFile = configuredFile ?? `${context}/Dockerfile`;
    const fixture = mkdtempSync(join(tmpdir(), "9router-publish-source-"));
    try {
      mkdirSync(join(fixture, "source"));
      mkdirSync(join(fixture, "workflow"));
      const releaseRecipe = hasShrinkwrap
        ? currentRecipe
        : "FROM node:22-alpine\nCOPY package.json ./\nRUN npm install\n";
      writeFileSync(join(fixture, "source", "Dockerfile"), releaseRecipe);
      writeFileSync(join(fixture, "source", "package.json"), "{}\n");
      writeFileSync(join(fixture, "workflow", "Dockerfile"), currentRecipe);
      if (hasShrinkwrap) {
        writeFileSync(join(fixture, "source", "npm-shrinkwrap.json"), "{}\n");
      }
      expect(existsSync(join(fixture, "source", "npm-shrinkwrap.json"))).toBe(hasShrinkwrap);
      expect(selectedFile).toBe(`${context}/Dockerfile`);
      expect(readFileSync(join(fixture, selectedFile), "utf8")).toBe(releaseRecipe);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
