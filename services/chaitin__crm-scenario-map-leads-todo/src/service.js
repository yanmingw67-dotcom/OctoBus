import { defineService } from "@chaitin-ai/octobus-sdk";

import { handlers } from "./crm-scenario-map-leads-todo.js";

export { handlers } from "./crm-scenario-map-leads-todo.js";

export const service = defineService({ handlers });
