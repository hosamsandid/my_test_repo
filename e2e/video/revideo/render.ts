// CLI: node --import tsx revideo/render.ts <project-slug> <basename.mp4>
//
// Renders to the project's `out/` (so Revideo's `resolvePath(output, '../public', src)`
// resolves audio assets to `./public/...` — see AUDIO-FIX-REPORT.md for the
// resolve-path bug we worked around) and then moves:
//
//   out/<base>.mp4              -> out/final/<base>.mp4
//   out/<base>-0.mp4            -> out/intermediate/<base>-0.mp4
//   out/<base>-audio.wav        -> out/intermediate/<base>-audio.wav
//   out/<base>-visuals.mp4      -> out/intermediate/<base>-visuals.mp4
//
// Two Windows patches stay in place (single-process strip + outFile basename).

import puppeteerPkg from "puppeteer";
const origLaunch = puppeteerPkg.launch.bind(puppeteerPkg);
type LaunchOpts = NonNullable<Parameters<typeof origLaunch>[0]> & { args?: string[] };
(puppeteerPkg as unknown as { launch: typeof origLaunch }).launch = ((opts?: LaunchOpts) => {
  if (opts && Array.isArray(opts.args)) {
    opts.args = opts.args.filter((a: string) => a !== "--single-process");
  }
  return origLaunch(opts);
}) as typeof origLaunch;

import { renderVideo } from "@revideo/renderer";
import { resolve, dirname, join, basename } from "node:path";
import { mkdirSync, renameSync, existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const [, , slug, outName] = process.argv;
if (!slug || !outName) {
  console.error("Usage: render.ts <project-slug> <basename.mp4>");
  process.exit(1);
}

const projectFile = `./revideo/${slug}.tsx`;
const outRoot = join(root, "out");
const finalDir = join(outRoot, "final");
const intermediateDir = join(outRoot, "intermediate");
mkdirSync(outRoot, { recursive: true });
mkdirSync(finalDir, { recursive: true });
mkdirSync(intermediateDir, { recursive: true });

const baseName = basename(outName).endsWith(".mp4") ? basename(outName) : `${basename(outName)}.mp4`;
const baseNoExt = baseName.slice(0, -4);
const finalOutFile = baseName as `${string}.mp4`;

console.log(`Rendering ${projectFile}`);
console.log(`  outDir during render: ${outRoot} (so '..\\public' resolves to ./public)`);
console.log(`  final destination:    ${join(finalDir, finalOutFile)}`);

process.chdir(root);
const renderedPath = await renderVideo({
  projectFile,
  settings: {
    outFile: finalOutFile,
    outDir: outRoot, // CRITICAL — must be a sibling of ./public for audio src resolution to work.
    logProgress: true,
    puppeteer: {
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    },
  },
});

// Move final + intermediates out of out/ into their tidy subfolders.
function moveIfExists(src: string, dst: string) {
  if (existsSync(src)) {
    if (existsSync(dst)) unlinkSync(dst);
    renameSync(src, dst);
    return true;
  }
  return false;
}

const finalSrc = join(outRoot, finalOutFile);
const finalDst = join(finalDir, finalOutFile);
const movedFinal = moveIfExists(finalSrc, finalDst);

const inters = [
  `${baseNoExt}-0.mp4`,
  `${baseNoExt}-audio.wav`,
  `${baseNoExt}-visuals.mp4`,
];
const movedIntermediates: string[] = [];
for (const f of inters) {
  if (moveIfExists(join(outRoot, f), join(intermediateDir, f))) {
    movedIntermediates.push(f);
  }
}

if (movedFinal) {
  console.log(`Moved final → ${finalDst}`);
} else {
  console.warn(`Final MP4 not found at ${finalSrc}. Renderer returned: ${renderedPath}`);
}
if (movedIntermediates.length) {
  console.log(`Moved intermediates → ${intermediateDir}/{${movedIntermediates.join(", ")}}`);
}
