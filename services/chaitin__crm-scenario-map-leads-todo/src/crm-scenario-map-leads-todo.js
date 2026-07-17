import { GrpcError, grpcStatus } from '@chaitin-ai/octobus-sdk';

export const METHOD_CREATE_SCENARIO_LEAD_TODO_FULL = 'Chaitin_CRM_ScenarioMapLeadsTodo.CrmScenarioMapLeadsTodo/CreateScenarioLeadTodo';
export const METHOD_CREATE_SCENARIO_LEAD_TODO_PATH = '/Chaitin_CRM_ScenarioMapLeadsTodo.CrmScenarioMapLeadsTodo/CreateScenarioLeadTodo';

const DEFAULT_BASE_URL = 'http://api.in.chaitin.net/crm/query';
const DEFAULT_SCENARIO_TYPE = 'first_team_self';
const DEFAULT_GROUP_ID = '645da87f24c86c2b8ef1f71f';
const DEFAULT_LEAD_POLL_ATTEMPTS = 5;
const DEFAULT_LEAD_POLL_INTERVAL_MS = 2000;

const QUERIES = {
  listOpportunityScenario: `
query ListOpportunityScenario($search: OpportunityScenarioSearchParam!, $pagination: PaginationParam, $sortBy: SortBy!) {
  list_opportunity_scenario(search: $search, pagination: $pagination, sort_by: $sortBy) {
    total
    skip
    limit
    data {
      id
      name
      type
      status
      group { id name }
      industry { id name group }
      updated_at
    }
  }
}`,
  listAllCompany: `
query ListAllCompany($search: CompanySearchParam!, $pagination: PaginationParam) {
  list_all_company(search: $search, pagination: $pagination) {
    total
    skip
    limit
    data {
      id
      name
      claim_by { id name username }
      industry { id name group }
    }
  }
}`,
  relateScenarioCompany: `
mutation OpportunityScenarioRelatedCompany($id: String!, $companyIds: [String!]!) {
  opportunity_scenario_related_company(id: $id, company_ids: $companyIds)
}`,
  listLeads: `
query ListLeads($search: LeadsSearchParam, $pagination: PaginationParam) {
  list_leads(search: $search, pagination: $pagination) {
    total
    data {
      id
      client_name
      type
      opportunity_scenario { id name }
      todos {
        id
        name
        type
        deadline
        relation { id name }
        processor { id name username }
      }
      created_at
    }
  }
}`,
  listUser: `
query ListUser($search: UserSearchParam!, $pagination: PaginationParam) {
  listUser(search: $search, pagination: $pagination) {
    total
    data {
      id
      name
      username
      enabled
    }
  }
}`,
  createTodo: `
mutation CreateTodoList($name: String!, $type: TodoType!, $relation: String!, $deadline: Time!, $processor: [ID!]!) {
  create_todo_list(name: $name, type: $type, relation: $relation, deadline: $deadline, processor: $processor)
}`,
  leadsInfo: `
query LeadsInfo($id: ID!) {
  leads_info(id: $id) {
    id
    client_name
    opportunity_scenario { id name }
    todos {
      id
      name
      type
      deadline
      is_finished
      relation { id name }
      processor { id name username }
      creator { id name username }
      created_at
    }
  }
}`,
};

const grpcError = (code, message) => new GrpcError(code, message);

const invalidArgument = (message) => grpcError(grpcStatus.INVALID_ARGUMENT, message);
const unauthenticated = (message) => grpcError(grpcStatus.UNAUTHENTICATED, message);
const unavailable = (message) => grpcError(grpcStatus.UNAVAILABLE, message);
const notFound = (message) => grpcError(grpcStatus.NOT_FOUND, message);

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj ?? {}, key);

const stringValue = (value) => {
  if (value === undefined || value === null) return '';
  return String(value).trim();
};

const positiveInteger = (value, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

const resolveConfig = (ctx = {}) => {
  const config = ctx.config ?? {};
  return {
    baseUrl: stringValue(config.baseUrl) || DEFAULT_BASE_URL,
    defaultScenarioType: stringValue(config.defaultScenarioType) || DEFAULT_SCENARIO_TYPE,
    defaultGroupId: stringValue(config.defaultGroupId) || DEFAULT_GROUP_ID,
    leadPollAttempts: positiveInteger(config.leadPollAttempts, DEFAULT_LEAD_POLL_ATTEMPTS),
    leadPollIntervalMs: positiveInteger(config.leadPollIntervalMs, DEFAULT_LEAD_POLL_INTERVAL_MS),
  };
};

const resolveSecret = (ctx = {}) => {
  const token = stringValue(ctx.secret?.apiToken);
  if (!token) {
    throw unauthenticated('secret.apiToken is required');
  }
  return { apiToken: token };
};

const requireString = (value, name) => {
  const s = stringValue(value);
  if (!s) {
    throw invalidArgument(`${name} is required`);
  }
  return s;
};

const normalizeDeadline = (value) => {
  const raw = requireString(value, 'deadline');
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return `${raw}T00:00:00+08:00`;
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    return raw;
  }
  throw invalidArgument('deadline must be YYYY-MM-DD or an ISO timestamp with timezone');
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const crmFetch = async ({ baseUrl, apiToken, query, variables, operationName, fetchImpl = globalThis.fetch }) => {
  if (typeof fetchImpl !== 'function') {
    throw unavailable('fetch is not available');
  }
  let res;
  try {
    res = await fetchImpl(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({ operationName, query, variables }),
    });
  } catch (err) {
    throw unavailable(err?.message || 'CRM request failed');
  }
  const text = await res.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw unavailable(`CRM ${operationName} returned non-JSON response: ${text}`);
  }
  if (res.status < 200 || res.status >= 300) {
    throw unavailable(`CRM returned HTTP ${res.status}: ${text}`);
  }
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const message = payload.errors.map((err) => err?.message || String(err)).join('; ');
    if (message.includes('请求过于频繁')) {
      throw unavailable(message);
    }
    throw invalidArgument(message);
  }
  return payload.data ?? {};
};

const isRateLimited = (err) => (
  err instanceof GrpcError
  && err.code === grpcStatus.UNAVAILABLE
  && String(err.message).includes('请求过于频繁')
);

const crmRead = async (params) => {
  const attempts = positiveInteger(params.leadPollAttempts, DEFAULT_LEAD_POLL_ATTEMPTS);
  const intervalMs = positiveInteger(params.leadPollIntervalMs, DEFAULT_LEAD_POLL_INTERVAL_MS);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await crmFetch(params);
    } catch (err) {
      if (!isRateLimited(err) || attempt === attempts) throw err;
      await params.sleep(intervalMs);
    }
  }
  throw unavailable('CRM read retry attempts exhausted');
};

const uniqueRecord = (label, result, data) => {
  const total = Number(result?.total ?? data.length);
  if (total === 0 || data.length === 0) {
    throw notFound(`${label} not found`);
  }
  if (total !== 1 || data.length !== 1) {
    throw invalidArgument(`${label} matched ${total || data.length} records`);
  }
  return data[0];
};

const listOpportunityScenario = async (ctx, request, deps) => {
  if (request.scenarioId) {
    return { id: request.scenarioId, name: request.scenarioKeyword || request.scenarioId };
  }
  const keyword = requireString(request.scenarioKeyword, 'scenarioKeyword');
  const data = await crmRead({
    ...deps,
    operationName: 'ListOpportunityScenario',
    query: QUERIES.listOpportunityScenario,
    variables: {
      search: {
        keyword,
        type: [deps.defaultScenarioType],
      },
      pagination: { skip: 0, limit: 10 },
      sortBy: { by: 'updated_at', order: -1 },
    },
  });
  const result = data.list_opportunity_scenario ?? {};
  return uniqueRecord('scenario', result, result.data ?? []);
};

const findCustomer = async (request, deps) => {
  const customerName = requireString(request.customerName, 'customerName');
  const data = await crmRead({
    ...deps,
    operationName: 'ListAllCompany',
    query: QUERIES.listAllCompany,
    variables: {
      search: { name: [customerName] },
      pagination: { skip: 0, limit: 10 },
    },
  });
  const result = data.list_all_company ?? {};
  return uniqueRecord('customer', result, result.data ?? []);
};

const relateCustomerToScenario = async (scenario, customer, deps) => {
  try {
    await crmFetch({
      ...deps,
      operationName: 'OpportunityScenarioRelatedCompany',
      query: QUERIES.relateScenarioCompany,
      variables: {
        id: scenario.id,
        companyIds: [customer.id],
      },
    });
  } catch (err) {
    if (err instanceof GrpcError && /已存在关联的(?:场景|客户)/.test(String(err.message))) {
      return;
    }
    throw err;
  }
};

const listGeneratedLead = async (scenario, customer, deps) => {
  const data = await crmRead({
    ...deps,
    operationName: 'ListLeads',
    query: QUERIES.listLeads,
    variables: {
      search: {
        list_type: 'claim_by',
        client_name: customer.name,
      },
      pagination: { skip: 0, limit: 10 },
    },
  });
  const leads = data.list_leads?.data ?? [];
  return leads.find((lead) => (
    lead?.client_name === customer.name
    && lead?.opportunity_scenario?.id === scenario.id
    && lead?.type === 'first_team_self_scenario'
  ));
};

const waitForGeneratedLead = async (scenario, customer, deps) => {
  for (let attempt = 1; attempt <= deps.leadPollAttempts; attempt += 1) {
    const lead = await listGeneratedLead(scenario, customer, deps);
    if (lead) return lead;
    if (attempt < deps.leadPollAttempts) {
      await deps.sleep(deps.leadPollIntervalMs);
    }
  }
  throw unavailable('generated lead was not visible after scenario association');
};

const resolveProcessor = async (request, customer, deps) => {
  if (request.useCustomerOwner) {
    if (!customer.claim_by?.id) {
      throw invalidArgument('customer owner is missing');
    }
    return customer.claim_by;
  }
  if (request.processorUserId) {
    return {
      id: request.processorUserId,
      name: request.processorName || '',
      username: request.processorUsername || '',
    };
  }
  const username = stringValue(request.processorUsername);
  const name = stringValue(request.processorName);
  if (!username && !name) {
    throw invalidArgument('processorUsername, processorUserId, processorName, or useCustomerOwner is required');
  }
  const search = username ? { username } : { name };
  const data = await crmRead({
    ...deps,
    operationName: 'ListUser',
    query: QUERIES.listUser,
    variables: {
      search,
      pagination: { skip: 0, limit: 10 },
    },
  });
  const result = data.listUser ?? {};
  const users = (result.data ?? []).filter((user) => user.enabled !== false);
  return uniqueRecord('processor', { total: users.length }, users);
};

const createTodo = async (request, lead, processor, deadline, deps) => {
  const data = await crmFetch({
    ...deps,
    operationName: 'CreateTodoList',
    query: QUERIES.createTodo,
    variables: {
      name: requireString(request.todoName, 'todoName'),
      type: 'leads',
      relation: lead.id,
      deadline,
      processor: [processor.id],
    },
  });
  return data.create_todo_list;
};

const getLeadInfo = async (leadID, deps) => {
  const data = await crmRead({
    ...deps,
    operationName: 'LeadsInfo',
    query: QUERIES.leadsInfo,
    variables: { id: leadID },
  });
  return data.leads_info;
};

const hasProcessor = (value, processorID) => {
  const processors = Array.isArray(value) ? value : value ? [value] : [];
  return processors.some((user) => user?.id === processorID);
};

const findTodo = (leadInfo, request, lead, processor) => {
  const todoName = requireString(request.todoName, 'todoName');
  return (leadInfo?.todos ?? []).find((item) => (
    item?.name === todoName
    && item?.type === 'leads'
    && item?.relation?.id === lead.id
    && hasProcessor(item?.processor, processor.id)
  ));
};

const verifyTodo = (leadInfo, request, lead, processor) => {
  if (!leadInfo?.id) {
    throw unavailable('leads_info did not return the generated lead');
  }
  const todo = findTodo(leadInfo, request, lead, processor);
  if (!todo) {
    throw unavailable('created lead todo was not visible in leads_info');
  }
  return todo;
};

const toRef = (value = {}) => ({
  id: stringValue(value.id),
  name: stringValue(value.name),
  username: stringValue(value.username),
});

const toScenario = (value = {}) => ({
  id: stringValue(value.id),
  name: stringValue(value.name),
  type: stringValue(value.type),
  status: stringValue(value.status),
});

const toCustomer = (value = {}) => ({
  id: stringValue(value.id),
  name: stringValue(value.name),
  owner: toRef(value.claim_by),
});

const toLead = (value = {}) => ({
  id: stringValue(value.id),
  clientName: stringValue(value.client_name),
  type: stringValue(value.type),
});

const toTodo = (value = {}) => ({
  id: stringValue(value.id),
  name: stringValue(value.name),
  type: stringValue(value.type),
  deadline: stringValue(value.deadline),
  relationId: stringValue(value.relation?.id),
});

export async function createScenarioLeadTodo(ctx = {}, deps = {}) {
  const config = resolveConfig(ctx);
  const secret = resolveSecret(ctx);
  const request = ctx.request ?? ctx.req ?? {};
  const deadline = normalizeDeadline(request.deadline);
  const runtimeDeps = {
    ...config,
    ...secret,
    fetchImpl: deps.fetch ?? globalThis.fetch,
    sleep: deps.sleep ?? sleep,
  };

  const scenario = await listOpportunityScenario(ctx, request, runtimeDeps);
  const customer = await findCustomer(request, runtimeDeps);
  await relateCustomerToScenario(scenario, customer, runtimeDeps);
  const lead = await waitForGeneratedLead(scenario, customer, runtimeDeps);
  const processor = await resolveProcessor(request, customer, runtimeDeps);
  const existingTodo = findTodo(lead, request, lead, processor);
  if (existingTodo) {
    return {
      scenario: toScenario(scenario),
      customer: toCustomer(customer),
      lead: toLead(lead),
      processor: toRef(processor),
      todo: toTodo(existingTodo),
      deadline,
      verified: true,
    };
  }
  await createTodo(request, lead, processor, deadline, runtimeDeps);
  const leadInfo = await getLeadInfo(lead.id, runtimeDeps);
  const todo = verifyTodo(leadInfo, request, lead, processor);

  return {
    scenario: toScenario(scenario),
    customer: toCustomer(customer),
    lead: toLead(leadInfo),
    processor: toRef(processor),
    todo: toTodo(todo),
    deadline,
    verified: true,
  };
}

const registerHandlers = (ctx = {}) => ({
  [METHOD_CREATE_SCENARIO_LEAD_TODO_PATH]: () => createScenarioLeadTodo(ctx),
});

export function rpcdef(ctx = {}) {
  return registerHandlers(ctx);
}

const callSdkHandler = (ctx, path) => registerHandlers(ctx)[path]();

export const handlers = {
  [METHOD_CREATE_SCENARIO_LEAD_TODO_FULL]: (ctx) => callSdkHandler(ctx, METHOD_CREATE_SCENARIO_LEAD_TODO_PATH),
};

export const _test = {
  QUERIES,
  createScenarioLeadTodo,
  crmFetch,
  normalizeDeadline,
  resolveConfig,
  resolveProcessor,
  resolveSecret,
  rpcdef,
  verifyTodo,
};
