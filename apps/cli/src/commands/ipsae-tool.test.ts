import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installIpsae, planIpsaeInstall, uninstallIpsae } from "@moldesk/core";
import { installIpsaeTool, uninstallIpsaeTool } from "./ipsae-tool.js";
vi.mock("@moldesk/core", async (original) => ({ ...await original<typeof import("@moldesk/core")>(), installIpsae: vi.fn(), planIpsaeInstall: vi.fn(), uninstallIpsae: vi.fn() }));
let output: string[];
beforeEach(()=>{
  output=[]; process.exitCode=undefined; vi.spyOn(console,"log").mockImplementation((s)=>{output.push(String(s));});
  vi.mocked(planIpsaeInstall).mockResolvedValue({alreadyInstalled:false,revision:"a".repeat(40),source:{url:"https://example.test/pinned.py"},knownDownloadBytes:1000,pythonDownloadBytes:null} as never);
  vi.mocked(installIpsae).mockResolvedValue({status:"installed",installation:{receipt:{tool:"ipsae"}}} as never);
});
afterEach(()=>{vi.restoreAllMocks();vi.clearAllMocks();process.exitCode=undefined;});
it("requires confirmation before any tool download/install in JSON mode",async()=>{
  await installIpsaeTool({json:true}); expect(installIpsae).not.toHaveBeenCalled();
  expect(output).toHaveLength(1);expect(JSON.parse(output[0]).status).toBe("confirmation-required");expect(process.exitCode).toBe(1);
});
it("installs after explicit yes with one JSON result",async()=>{
  await installIpsaeTool({json:true,yes:true});expect(installIpsae).toHaveBeenCalledTimes(1);expect(output).toHaveLength(1);expect(JSON.parse(output[0])).toMatchObject({tool:"ipsae",status:"installed"});
});
it("reports removal as JSON",async()=>{
  vi.mocked(uninstallIpsae).mockResolvedValue(true);await uninstallIpsaeTool({json:true});expect(JSON.parse(output[0])).toEqual({tool:"ipsae",status:"uninstalled"});
});
