import { getDefaultHelixClient } from "../src/core/playwright-sessions/helix-client.js";

async function main() {
  const client = getDefaultHelixClient();
  const proposalKey = "prop_1766905063414_3e0813f7";
  
  console.log("Raw query for GetProposalByKey:", proposalKey);
  const rawResult = await (client as any).query("GetProposalByKey", { proposal_key: proposalKey });
  console.log("Raw result type:", typeof rawResult);
  console.log("Raw result:", JSON.stringify(rawResult, null, 2));
  console.log("Is array:", Array.isArray(rawResult));
  console.log("Keys:", rawResult ? Object.keys(rawResult) : "null");
}

main().catch(console.error);
