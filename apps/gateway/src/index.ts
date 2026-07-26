import { buildMultiServerOAuthWorker } from "@iolab/mcp-kit";
import { app as portal } from "@iolab/portal";
import { SERVERS, NzCultureMcp, NzEnvironmentMcp, NzGeoMcp, NzGovtMcp, NzMarketsMcp, NzStatsMcp, NzTransportMcp } from "./servers.js";

export { NzCultureMcp, NzEnvironmentMcp, NzGeoMcp, NzGovtMcp, NzMarketsMcp, NzStatsMcp, NzTransportMcp };

export default buildMultiServerOAuthWorker<Env>(SERVERS, portal);
