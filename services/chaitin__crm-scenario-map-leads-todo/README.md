# CRM Scenario Map Leads Todo

OctoBus service for creating a CRM lead-level todo from the scenario-map workflow.

The service exposes one agent-facing method:

- `CreateScenarioLeadTodo`: searches a scenario, searches a customer, associates the customer to the scenario, waits for the generated lead, resolves the processor, creates a todo on that lead, and verifies the todo through `leads_info`.

Credentials are supplied through instance secret:

```json
{
  "apiToken": "..."
}
```

Do not put CRM tokens in source files, config JSON, or committed examples.
