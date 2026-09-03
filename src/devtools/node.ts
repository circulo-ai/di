import { writeFile } from "node:fs/promises";
import type { DependencyGraphSnapshot } from "./graph.js";
import {
  renderDependencyGraphHtml,
  type DependencyGraphViewerOptions,
} from "./viewer.js";

/** Write an offline runtime graph report for opening in any modern browser. */
export async function writeDependencyGraphReport(
  filePath: string,
  snapshot: DependencyGraphSnapshot,
  options?: DependencyGraphViewerOptions,
): Promise<void> {
  await writeFile(
    filePath,
    renderDependencyGraphHtml(snapshot, options),
    "utf8",
  );
}
