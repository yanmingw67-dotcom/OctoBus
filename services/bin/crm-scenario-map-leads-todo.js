#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { runServiceMain } from "@chaitin-ai/octobus-sdk";

import { service } from "../chaitin__crm-scenario-map-leads-todo/src/service.js";

runServiceMain(service, {
  entryFile: fileURLToPath(new URL("../chaitin__crm-scenario-map-leads-todo/bin/crm-scenario-map-leads-todo.js", import.meta.url)),
});
