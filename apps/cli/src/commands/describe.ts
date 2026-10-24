import type { Command } from "commander";
import { describeModel, MoldeskError, type ModelParameter, type RuntimeKind } from "@moldesk/core";
import { reportFailure } from "../utils/report-errors.js";

function parameterLine(p: ModelParameter): string {
  const range = p.enum ? p.enum.join("|") : [p.min !== undefined ? `min ${p.min}` : "", p.max !== undefined ? `max ${p.max}` : ""].filter(Boolean).join(", ");
  const defaults = p.defaultsByPlatform
    ? `default by platform: ${Object.entries(p.defaultsByPlatform).map(([platform, v]) => `${v} on ${platform}`).join(", ")}`
    : p.default !== undefined
      ? `default ${p.default}`
      : "no default";
  return `  --param ${p.name}=<${p.type}>${p.required ? " (required)" : ""}${range ? ` [${range}]` : ""}  ${defaults}${p.description ? `. ${p.description}` : ""}`;
}

export function registerDescribeCommand(program: Command): void {
  program
    .command("describe <model>")
    .description("Describe one model: inputs, parameters, hardware needs, whether it runs on this machine, cloud support and license")
    .option("--runtime <kind>", "judge compatibility for python|docker only")
    .option("--json", "print the description as one JSON document")
    .action(async (model: string, options: { runtime?: string; json?: boolean }) => {
      try {
        if (options.runtime !== undefined && options.runtime !== "python" && options.runtime !== "docker") {
          throw new MoldeskError({ code: "INVALID_DESCRIBE_ARGS", message: `Invalid --runtime "${options.runtime}".`, remediation: "Use python or docker." });
        }
        const envelope = await describeModel(model, { requestedRuntime: options.runtime as RuntimeKind | undefined });
        if (options.json) {
          console.log(JSON.stringify(envelope, null, 2));
          return;
        }
        const d = envelope.result;
        console.log(`${d.displayName} (${d.name} ${d.modelVersion}, ${d.status}): ${d.category}`);
        console.log(`  ${d.description}`);
        console.log(`  License: ${d.license ?? "not stated"}   Input: ${d.input.formats.join(", ")}${d.input.required ? "" : " (optional)"}`);
        console.log(`  This machine: ${d.verdict}`);
        console.log(`  Installed: ${d.capabilities.installed ? "yes" : "no"}   Cloud: ${d.cloud.available ? `Runpod (at least ${d.cloud.minVramGb} GB VRAM, ${d.cloud.minRamGb} GB RAM)` : "not available"}`);
        console.log(d.parameters.length > 0 ? "Parameters:" : "Parameters: none");
        for (const p of d.parameters) console.log(parameterLine(p));
      } catch (error) {
        reportFailure(error, options.json);
      }
    });
}
