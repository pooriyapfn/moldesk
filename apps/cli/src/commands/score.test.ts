import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MoldeskError, scoreProteinInterface } from "@moldesk/core";
import { registerScoreCommand } from "./score.js";
vi.mock("@moldesk/core", async (original) => ({ ...await original<typeof import("@moldesk/core")>(), scoreProteinInterface: vi.fn() }));
let output: string[], errors: string[];
beforeEach(() => { output=[]; errors=[]; process.exitCode=undefined; vi.spyOn(console,"log").mockImplementation((s)=>{output.push(String(s));}); vi.spyOn(console,"error").mockImplementation((s)=>{errors.push(String(s));}); });
afterEach(()=>{vi.restoreAllMocks();vi.clearAllMocks();process.exitCode=undefined;});
const command = async (...extra: string[]) => { const p=new Command();registerScoreCommand(p);await p.parseAsync(["score","interface","job_model_0.cif","--pae","pae_job_model_0.npz","--confidence","confidence_job_model_0.json","--target-chain","A","--binder-chain","B","--json",...extra],{from:"user"}); };
it("prints one JSON result, forwards roles/cutoffs and installs no signal listener leaks",async()=>{
  const value={schemaVersion:1,kind:"moldesk.interface",status:"ok",result:{scores:{ipsaeMax:.5}},warnings:[]};
  vi.mocked(scoreProteinInterface).mockResolvedValue(value as never);
  const before=process.listenerCount("SIGINT"); await command("--pae-cutoff","10","--output","score.json");
  expect(output).toHaveLength(1);expect(JSON.parse(output[0])).toEqual(value);expect(errors).toHaveLength(0);
  expect(scoreProteinInterface).toHaveBeenCalledWith(expect.objectContaining({targetChain:"A",binderChain:"B",paeCutoffAngstrom:10,outputPath:"score.json"}));
  expect(process.listenerCount("SIGINT")).toBe(before);
});
it.each([["INVALID_INTERFACE_ARGS",2],["INVALID_PAE",2],["PAE_STRUCTURE_MISMATCH",2],["BOLTZ_ARTIFACT_MISMATCH",2],["UNSUPPORTED_INTERFACE_INPUT",2],["IPSAE_NOT_INSTALLED",2],["IPSAE_DAMAGED",2],["IPSAE_NO_RESULT",2],["INTERFACE_CANCELLED",8],["IPSAE_EXECUTION_FAILED",10]])("maps %s to exit %d and one JSON error",async(code,exit)=>{
  vi.mocked(scoreProteinInterface).mockRejectedValue(new MoldeskError({code:String(code),message:"reason",remediation:"fix"}));await command();
  expect(output).toHaveLength(1);expect(JSON.parse(output[0])).toMatchObject({status:"error",code});expect(process.exitCode).toBe(exit);
});
