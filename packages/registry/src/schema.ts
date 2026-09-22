import { z } from "zod";

const kebabCase = z
  .string()
  .min(1)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be lowercase kebab-case");

const sha256Hex = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, "must be a 64-char hex SHA-256");

const dockerDigest = z
  .string()
  .regex(/^sha256:[0-9a-fA-F]{64}$/, "must be `sha256:<64 hex>`");

const httpsUrl = z.string().url("must be a valid URL").refine(
  (v) => v.startsWith("https://"),
  "must use https protocol",
);

const safeVersionSegment = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/, "must be a safe single path segment");

const semver = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    "must be a semantic version",
  );

function isSafeRelativeTarget(target: string): boolean {
  if (!target || target.length === 0) return false;
  if (target.includes("\\")) return false;
  if (target.startsWith("/") || /^[A-Za-z]:/.test(target)) return false;
  const parts = target.split("/");
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") return false;
  }
  return true;
}

function isSafeRelativeGlob(glob: string): boolean {
  if (!glob || glob.includes("\\") || glob.startsWith("/") || /^[A-Za-z]:/.test(glob)) return false;
  return glob.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

const safeTarget = z
  .string()
  .min(1)
  .refine(isSafeRelativeTarget, "must be a safe path relative to the model assets directory (no absolute paths, .., or backslashes)");

const modelStatus = z.enum(["available", "beta", "planned"]);
const runtimeKind = z.enum(["python", "docker"]);
const requirementLevel = z.enum(["required", "recommended", "unsupported"]);
const category = z.enum(["sequence-design", "structure-prediction", "docking", "other"]);
const platformId = z.enum(["darwin-arm64", "linux-x64"]);

const pythonRequirementSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1).optional(),
    source: z.string().min(1).optional(),
    revision: z.string().min(1).optional(),
  })
  .strict();

const pythonRuntimeSchema = z
  .object({
    kind: z.literal("python"),
    python: z.string().min(1),
    installer: z.literal("uv"),
    estimatedDownloadBytes: z.number().int().nonnegative().optional(),
    estimatedDiskBytes: z.number().int().nonnegative().optional(),
    requirements: z.array(pythonRequirementSchema).min(1),
  })
  .strict();

const dockerRuntimeSchema = z
  .object({
    kind: z.literal("docker"),
    image: z.string().min(1),
    digest: dockerDigest,
    gpu: z.enum(["none", "optional", "required"]),
    estimatedDownloadBytes: z.number().int().nonnegative().optional(),
    estimatedDiskBytes: z.number().int().nonnegative().optional(),
  })
  .strict();

const runtimeSpecSchema = z.discriminatedUnion("kind", [
  pythonRuntimeSchema,
  dockerRuntimeSchema,
]);

const cudaSchema = z
  .object({
    level: requirementLevel,
    // Minimum driver-supported CUDA version, e.g. "12.1" — compared against the
    // driver's max-supported CUDA (not the local CUDA toolkit) as a major.minor
    // floor, not a semver range.
    minDriverCudaVersion: z
      .string()
      .regex(/^\d+\.\d+$/, "must be a major.minor CUDA version, e.g. \"12.1\"")
      .optional(),
  })
  .strict();

const hardwareSchema = z
  .object({
    platforms: z.array(platformId).min(1).optional(),
    minRamGb: z.number().positive().optional(),
    minDiskGb: z.number().positive().optional(),
    nvidiaGpu: requirementLevel.optional(),
    minVramGb: z.number().positive().optional(),
    cuda: cudaSchema.optional(),
  })
  .strict();

const assetSchema = z
  .object({
    id: z.string().min(1),
    url: httpsUrl,
    source: z.string().min(1).optional(),
    license: z.string().min(1).optional(),
    sha256: sha256Hex,
    target: safeTarget,
    sizeBytes: z.number().int().nonnegative().optional(),
    archive: z.enum(["none", "tar.gz", "zip"]).optional(),
  })
  .strict();

const inputSpecSchema = z
  .object({
    formats: z.array(z.string().min(1)).min(1),
    required: z.boolean(),
  })
  .strict();

const outputSpecSchema = z
  .object({
    id: z.string().min(1),
    glob: z.string().min(1),
    required: z.boolean(),
  })
  .strict()
  .refine((v) => isSafeRelativeGlob(v.glob), {
    message: "must be a safe path relative to the staged output directory",
    path: ["glob"],
  });

const sourceSchema = z
  .object({
    repository: httpsUrl,
    revision: z
      .string()
      .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i, "must be a full immutable commit digest"),
  })
  .strict();

const adapterVerificationSchema = z
  .object({
    lastVerifiedAt: z.string().datetime({ offset: true }),
    platforms: z.array(z.string().min(1)).min(1),
    notes: z.string().optional(),
  })
  .strict();

export const allowedCommandTokens = ["{{input}}", "{{outputDir}}", "{{modelDir}}", "{{assetsDir}}"] as const;

const allowedCommandTokenSet = new Set<string>(allowedCommandTokens);

function hasOnlyAllowedCommandTokens(value: string): boolean {
  let remainder = value;
  for (const token of allowedCommandTokenSet) remainder = remainder.split(token).join("");
  return !remainder.includes("{{") && !remainder.includes("}}");
}

const commandValue = z
  .string()
  .refine((v) => !v.includes("\0"), "must not contain a NUL byte")
  .refine(hasOnlyAllowedCommandTokens, "contains an unsupported command template token");

export const commandSpecSchema = z
  .object({
    executable: z
      .string()
      .min(1)
      .refine((v) => !v.includes("\0"), "must not contain a NUL byte")
      .refine((v) => !v.includes("{{"), "executable must not contain template tokens"),
    args: z.array(commandValue),
    env: z.record(z.string().min(1), commandValue).optional(),
  })
  .strict();

export const modelManifestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    name: kebabCase,
    displayName: z.string().min(1),
    modelVersion: safeVersionSegment,
    adapterVersion: semver,
    description: z.string().min(1),
    category,
    status: modelStatus,
    license: z.string().min(1).optional(),
    homepage: httpsUrl.optional(),
    source: sourceSchema.optional(),
    adapterVerification: adapterVerificationSchema.optional(),
    runtimes: z.array(runtimeSpecSchema).min(1),
    hardware: hardwareSchema,
    assets: z.array(assetSchema).optional(),
    input: inputSpecSchema,
    outputs: z.array(outputSpecSchema).min(1),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.hardware.minVramGb !== undefined && val.hardware.nvidiaGpu === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "hardware.nvidiaGpu must be set (\"required\" or \"recommended\") whenever minVramGb is specified",
        path: ["hardware", "nvidiaGpu"],
      });
    }
    const names = new Set<string>();
    for (const out of val.outputs) {
      if (names.has(out.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate output id "${out.id}"`, path: ["outputs"] });
      }
      names.add(out.id);
    }
    if (val.assets) {
      const assetIds = new Set<string>();
      const targets = new Set<string>();
      for (const a of val.assets) {
        if (assetIds.has(a.id)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate asset id "${a.id}"`, path: ["assets"] });
        }
        assetIds.add(a.id);
        if (targets.has(a.target)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate asset target "${a.target}"`, path: ["assets"] });
        }
        targets.add(a.target);
      }
    }
    if (val.status === "available") {
      if (!val.source) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "available models require source provenance",
          path: ["source"],
        });
      }
      if (!val.adapterVerification) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "available models require adapter verification metadata",
          path: ["adapterVerification"],
        });
      }
      for (const [runtimeIndex, runtime] of val.runtimes.entries()) {
        if (runtime.kind !== "python") continue;
        for (const [requirementIndex, requirement] of runtime.requirements.entries()) {
          const pinnedPackage = requirement.version !== undefined;
          const pinnedSource = requirement.source !== undefined && requirement.revision !== undefined;
          if (!pinnedPackage && !pinnedSource) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "available models require every Python dependency to be pinned by version or source revision",
              path: ["runtimes", runtimeIndex, "requirements", requirementIndex],
            });
          }
        }
      }
    }
  });

export type ModelStatus = z.infer<typeof modelStatus>;
export type RuntimeKind = z.infer<typeof runtimeKind>;
export type RequirementLevel = z.infer<typeof requirementLevel>;
export type ModelCategory = z.infer<typeof category>;
export type PlatformId = z.infer<typeof platformId>;
export type PythonRuntimeSpec = z.infer<typeof pythonRuntimeSchema>;
export type DockerRuntimeSpec = z.infer<typeof dockerRuntimeSchema>;
export type RuntimeSpec = z.infer<typeof runtimeSpecSchema>;
export type HardwareRequirements = z.infer<typeof hardwareSchema>;
export type AssetSpec = z.infer<typeof assetSchema>;
export type InputSpec = z.infer<typeof inputSpecSchema>;
export type OutputSpec = z.infer<typeof outputSpecSchema>;
export type ModelManifestV1 = z.infer<typeof modelManifestV1Schema>;
export type CommandSpec = z.infer<typeof commandSpecSchema>;
