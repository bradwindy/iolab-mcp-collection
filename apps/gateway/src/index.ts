import { buildMultiServerOAuthWorker } from "@iolab/mcp-kit";
import { app as portal } from "@iolab/portal";
import {
  SERVERS,
  InternetArchiveMcp,
  NzCultureMcp,
  NzEnvironmentMcp,
  NzGeoMcp,
  NzGovtMcp,
  NzMarketsMcp,
  NzStatsMcp,
  NzTransportMcp,
  WikimediaMcp,
} from "./servers.js";

export {
  InternetArchiveMcp,
  NzCultureMcp,
  NzEnvironmentMcp,
  NzGeoMcp,
  NzGovtMcp,
  NzMarketsMcp,
  NzStatsMcp,
  NzTransportMcp,
  WikimediaMcp,
};

export default buildMultiServerOAuthWorker<Env>(SERVERS, portal);
