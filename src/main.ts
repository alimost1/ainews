/**
 * main.ts — Orchestrator
 * 
 * Runs all agents sequentially:
 * 1. Director → 2. ScriptWriter → 3. VisualArtist + VoiceDirector (parallel) → 4. Editor → 5. Render
 * 
 * Usage: npx tsx src/main.ts --topic="AI breakthroughs" --duration=120
 */

import { execSync } from "child_process";
import * as path from "path";
import { logger, CONFIG } from "./agents/shared";

const SCRIPT_PATH = path.join(CONFIG.dataDir, "script.json");

/**
 * Run a command and log output
 */
function runCommand(cmd: string, description: string): void {
  logger.info(`Running: ${description}`);
  try {
    execSync(cmd, {
      cwd: CONFIG.projectRoot,
      stdio: "inherit",
      timeout: 300000, // 5 min timeout
    });
    logger.success(`${description} completed`);
  } catch (err: any) {
    logger.error(`${description} failed: ${err.message}`);
    throw err;
  }
}

/**
 * Main orchestration
 */
async function main() {
  const args = process.argv.slice(2);
  const parseArgs = () => {
    const result: Record<string, string> = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith("--") && args[i + 1]) {
        result[args[i].replace("--", "")] = args[i + 1];
        i++;
      }
    }
    return result;
  };

  const parsed = parseArgs();
  const topic = parsed.topic || "Latest AI breakthroughs and news";
  const duration = parsed.duration || "120";
  const skipRender = parsed["skip-render"] === "true";

  console.log("\n" + "=".repeat(60));
  console.log("🎬 iAnews — AI News Video Generator");
  console.log("=".repeat(60));
  console.log(`📌 Topic: ${topic}`);
  console.log(`⏱️  Duration: ${duration}s`);
  console.log(`📐 Resolution: ${CONFIG.videoWidth}x${CONFIG.videoHeight} @ ${CONFIG.fps}fps`);
  console.log("=".repeat(60) + "\n");

  const startTime = Date.now();

  try {
    // ─── Step 1: Director ───────────────────────────────────────
    logger.info("━━━ Step 1/5: Director Agent ━━━");
    runCommand(
      `npx tsx src/agents/Director.ts --topic="${topic}" --duration=${duration}`,
      "Director Agent"
    );

    // ─── Step 2: ScriptWriter ───────────────────────────────────
    logger.info("━━━ Step 2/5: ScriptWriter Agent ━━━");
    runCommand(
      `npx tsx src/agents/ScriptWriter.ts --topic="${topic}"`,
      "ScriptWriter Agent"
    );

    // ─── Step 3: VisualArtist + VoiceDirector (parallel) ────────
    logger.info("━━━ Step 3/5: VisualArtist + VoiceDirector (parallel) ━━━");
    try {
      runCommand(`npx tsx src/agents/VisualArtist.ts`, "VisualArtist Agent");
    } catch (err) {
      logger.warn("VisualArtist had errors, continuing...");
    }
    try {
      runCommand(`npx tsx src/agents/VoiceDirector.ts`, "VoiceDirector Agent");
    } catch (err) {
      logger.warn("VoiceDirector had errors, continuing...");
    }

    // ─── Step 4: Editor ─────────────────────────────────────────
    logger.info("━━━ Step 4/5: Editor Agent ━━━");
    runCommand(`npx tsx src/agents/Editor.ts`, "Editor Agent");

    // ─── Step 5: Render ─────────────────────────────────────────
    if (!skipRender) {
      logger.info("━━━ Step 5/5: Rendering Video ━━━");
      runCommand(
        `npx remotion render src/index.ts VideoComposition output/output.mp4`,
        "Remotion Render"
      );
    } else {
      logger.info("Skipping render (use --skip-render=false to render)");
    }

    // ─── Done ───────────────────────────────────────────────────
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log("\n" + "=".repeat(60));
    console.log(`✅ Video generation complete in ${elapsed}s!`);
    console.log(`📁 Output: ${path.join(CONFIG.outputDir, "output.mp4")}`);
    console.log("=".repeat(60) + "\n");

  } catch (err: any) {
    logger.error(`Pipeline failed: ${err.message}`);
    process.exit(1);
  }
}

main();
