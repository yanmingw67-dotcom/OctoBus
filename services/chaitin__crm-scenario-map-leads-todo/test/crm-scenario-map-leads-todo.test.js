import test from 'node:test';
import assert from 'node:assert/strict';

import { GrpcError, grpcStatus } from '@chaitin-ai/octobus-sdk';

import {
  METHOD_CREATE_SCENARIO_LEAD_TODO_FULL,
  _test,
  handlers,
} from '../src/crm-scenario-map-leads-todo.js';
import { service } from '../src/service.js';

const buildCtx = (overrides = {}) => ({
  config: {
    baseUrl: 'http://crm.example.test/query',
    defaultScenarioType: 'first_team_self',
    defaultGroupId: '645da87f24c86c2b8ef1f71f',
    leadPollAttempts: 2,
    leadPollIntervalMs: 1,
    ...(overrides.config || {}),
  },
  secret: {
    apiToken: 'test-token',
    ...(overrides.secret || {}),
  },
  request: {
    scenarioKeyword: 'ADP智能体开发',
    customerName: '民航局空管局技术中心',
    todoName: '测试',
    deadline: '2026-06-23',
    processorUsername: 'yanming.wang',
    ...(overrides.request || {}),
  },
});

const createFetch = (handler) => {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, body });
    const data = await handler(body, calls.length);
    return {
      status: 200,
      text: async () => JSON.stringify({ data }),
    };
  };
  fetch.calls = calls;
  return fetch;
};

test('verifyTodo accepts the CRM object processor shape', () => {
  const todo = {
    id: 'todo-1',
    name: '测试',
    type: 'leads',
    relation: { id: 'lead-1' },
    processor: { id: 'owner-1', name: '王延明', username: 'yanming.wang' },
  };

  assert.equal(_test.verifyTodo(
    { id: 'lead-1', todos: [todo] },
    { todoName: '测试' },
    { id: 'lead-1' },
    { id: 'owner-1' },
  ), todo);
});

test('crmFetch includes the operation name in non-JSON upstream errors', async () => {
  await assert.rejects(
    () => _test.crmFetch({
      baseUrl: 'http://crm.example.test/query',
      apiToken: 'test-token',
      operationName: 'ListLeads',
      query: 'query ListLeads { list_leads { total } }',
      variables: {},
      fetchImpl: async () => ({ status: 429, text: async () => '请求过于频繁，请稍后再试\n' }),
    }),
    /CRM ListLeads returned non-JSON response/,
  );
});

test('CreateScenarioLeadTodo associates customer, creates lead todo, and verifies it', async () => {
  const fetch = createFetch((body) => {
    if (body.query.includes('list_opportunity_scenario')) {
      return {
        list_opportunity_scenario: {
          total: 1,
          data: [{
            id: 'scenario-1',
            name: 'ADP智能体开发',
            type: 'first_team_self',
            status: 'active',
            group: { id: '645da87f24c86c2b8ef1f71f', name: '政府' },
          }],
        },
      };
    }
    if (body.query.includes('list_all_company')) {
      return {
        list_all_company: {
          total: 1,
          data: [{
            id: 'company-1',
            name: '民航局空管局技术中心',
            claim_by: { id: 'owner-1', name: '王延明', username: 'yanming.wang' },
          }],
        },
      };
    }
    if (body.query.includes('opportunity_scenario_related_company')) {
      return { opportunity_scenario_related_company: null };
    }
    if (body.query.includes('list_leads')) {
      return {
        list_leads: {
          total: 1,
          data: [{
            id: 'lead-1',
            client_name: '民航局空管局技术中心',
            type: 'first_team_self_scenario',
            opportunity_scenario: { id: 'scenario-1', name: 'ADP智能体开发' },
            todos: [],
            created_at: '2026-06-21T00:00:00Z',
          }],
        },
      };
    }
    if (body.query.includes('listUser')) {
      return {
        listUser: {
          total: 1,
          data: [{ id: 'owner-1', name: '王延明', username: 'yanming.wang', enabled: true }],
        },
      };
    }
    if (body.query.includes('create_todo_list')) {
      assert.deepEqual(body.variables, {
        name: '测试',
        type: 'leads',
        relation: 'lead-1',
        deadline: '2026-06-23T00:00:00+08:00',
        processor: ['owner-1'],
      });
      return { create_todo_list: 'todo-1' };
    }
    if (body.query.includes('leads_info')) {
      return {
        leads_info: {
          id: 'lead-1',
          client_name: '民航局空管局技术中心',
          opportunity_scenario: { id: 'scenario-1', name: 'ADP智能体开发' },
          todos: [{
            id: 'todo-1',
            name: '测试',
            type: 'leads',
            deadline: '2026-06-22T16:00:00Z',
            is_finished: false,
            relation: { id: 'lead-1', name: '民航局空管局技术中心' },
            processor: [{ id: 'owner-1', name: '王延明', username: 'yanming.wang' }],
            creator: { id: 'creator-1', name: '创建人', username: 'creator' },
            created_at: '2026-06-21T00:00:00Z',
          }],
        },
      };
    }
    throw new Error(`unexpected query: ${body.query}`);
  });

  const result = await _test.createScenarioLeadTodo(buildCtx(), { fetch });

  assert.equal(result.scenario.id, 'scenario-1');
  assert.equal(result.customer.id, 'company-1');
  assert.equal(result.lead.id, 'lead-1');
  assert.equal(result.todo.id, 'todo-1');
  assert.equal(result.todo.relationId, 'lead-1');
  assert.equal(result.deadline, '2026-06-23T00:00:00+08:00');
  assert.deepEqual(fetch.calls.map((call) => call.body.operationName), [
    'ListOpportunityScenario',
    'ListAllCompany',
    'OpportunityScenarioRelatedCompany',
    'ListLeads',
    'ListUser',
    'CreateTodoList',
    'LeadsInfo',
  ]);
  assert.equal(fetch.calls[0].init.headers.Authorization, 'Bearer test-token');
  assert.ok(service);
});

test('CreateScenarioLeadTodo reuses an existing matching lead todo instead of creating a duplicate', async () => {
  const fetch = createFetch((body) => {
    if (body.query.includes('list_opportunity_scenario')) {
      return { list_opportunity_scenario: { total: 1, data: [{ id: 'scenario-1', name: 'ADP智能体开发' }] } };
    }
    if (body.query.includes('list_all_company')) {
      return { list_all_company: { total: 1, data: [{ id: 'company-1', name: '客户' }] } };
    }
    if (body.query.includes('opportunity_scenario_related_company')) {
      return { opportunity_scenario_related_company: null };
    }
    if (body.query.includes('list_leads')) {
      return {
        list_leads: {
          total: 1,
          data: [{
            id: 'lead-1',
            client_name: '客户',
            type: 'first_team_self_scenario',
            opportunity_scenario: { id: 'scenario-1' },
            todos: [{
              id: 'todo-existing',
              name: '测试',
              type: 'leads',
              deadline: '2026-06-22T16:00:00Z',
              relation: { id: 'lead-1', name: '客户' },
              processor: { id: 'owner-1', name: '王延明', username: 'yanming.wang' },
            }],
          }],
        },
      };
    }
    if (body.query.includes('listUser')) {
      return { listUser: { total: 1, data: [{ id: 'owner-1', name: '王延明', username: 'yanming.wang', enabled: true }] } };
    }
    if (body.query.includes('create_todo_list')) {
      throw new Error('must not create a duplicate todo');
    }
    throw new Error(`unexpected query: ${body.query}`);
  });

  const result = await _test.createScenarioLeadTodo(buildCtx({ request: { customerName: '客户' } }), { fetch });

  assert.equal(result.todo.id, 'todo-existing');
  assert.equal(result.verified, true);
  assert.equal(fetch.calls.some((call) => call.body.operationName === 'CreateTodoList'), false);
  assert.equal(fetch.calls.some((call) => call.body.operationName === 'LeadsInfo'), false);
});

test('CreateScenarioLeadTodo tolerates the CRM duplicate customer association response', async () => {
  const baseFetch = createFetch((body) => {
    if (body.query.includes('list_all_company')) {
      return { list_all_company: { total: 1, data: [{ id: 'company-1', name: '客户' }] } };
    }
    if (body.query.includes('list_leads')) {
      return {
        list_leads: {
          total: 1,
          data: [{
            id: 'lead-1',
            client_name: '客户',
            type: 'first_team_self_scenario',
            opportunity_scenario: { id: 'scenario-1', name: 'ADP智能体开发' },
            todos: [{
              id: 'todo-existing',
              name: '测试',
              type: 'leads',
              relation: { id: 'lead-1' },
              processor: { id: 'owner-1' },
            }],
          }],
        },
      };
    }
    if (body.query.includes('listUser')) {
      return { listUser: { total: 1, data: [{ id: 'owner-1', username: 'yanming.wang', enabled: true }] } };
    }
    throw new Error(`unexpected query: ${body.query}`);
  });
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.operationName === 'OpportunityScenarioRelatedCompany') {
      return {
        status: 200,
        text: async () => JSON.stringify({ errors: [{ message: '已存在关联的客户: 客户' }] }),
      };
    }
    return baseFetch(url, init);
  };

  const result = await _test.createScenarioLeadTodo(buildCtx({
    request: { scenarioId: 'scenario-1', scenarioKeyword: '', customerName: '客户' },
  }), { fetch });

  assert.equal(result.todo.id, 'todo-existing');
  assert.equal(result.verified, true);
});

test('CreateScenarioLeadTodo can use customer owner as processor', async () => {
  const fetch = createFetch((body) => {
    if (body.query.includes('list_opportunity_scenario')) {
      return { list_opportunity_scenario: { total: 1, data: [{ id: 'scenario-1', name: 'ADP智能体开发' }] } };
    }
    if (body.query.includes('list_all_company')) {
      return {
        list_all_company: {
          total: 1,
          data: [{ id: 'company-1', name: '客户', claim_by: { id: 'owner-1', name: 'Owner', username: 'owner' } }],
        },
      };
    }
    if (body.query.includes('opportunity_scenario_related_company')) {
      return { opportunity_scenario_related_company: null };
    }
    if (body.query.includes('list_leads')) {
      return {
        list_leads: {
          total: 1,
          data: [{ id: 'lead-1', client_name: '客户', type: 'first_team_self_scenario', opportunity_scenario: { id: 'scenario-1', name: 'ADP智能体开发' } }],
        },
      };
    }
    if (body.query.includes('create_todo_list')) {
      assert.deepEqual(body.variables.processor, ['owner-1']);
      return { create_todo_list: 'todo-1' };
    }
    if (body.query.includes('leads_info')) {
      return {
        leads_info: {
          id: 'lead-1',
          client_name: '客户',
          opportunity_scenario: { id: 'scenario-1', name: 'ADP智能体开发' },
          todos: [{
            id: 'todo-1',
            name: '跟进',
            type: 'leads',
            deadline: '2026-06-22T16:00:00Z',
            relation: { id: 'lead-1', name: '客户' },
            processor: [{ id: 'owner-1', name: 'Owner', username: 'owner' }],
          }],
        },
      };
    }
    throw new Error(`unexpected query: ${body.query}`);
  });

  const result = await _test.createScenarioLeadTodo(buildCtx({
    request: {
      customerName: '客户',
      todoName: '跟进',
      useCustomerOwner: true,
      processorUsername: '',
    },
  }), { fetch });

  assert.equal(result.processor.id, 'owner-1');
  assert.equal(fetch.calls.some((call) => call.body.operationName === 'ListUser'), false);
});

test('CreateScenarioLeadTodo rejects ambiguous scenario and customer matches', async () => {
  const scenarioFetch = createFetch((body) => {
    if (body.query.includes('list_opportunity_scenario')) {
      return { list_opportunity_scenario: { total: 2, data: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] } };
    }
    throw new Error('should not continue after ambiguous scenario');
  });

  await assert.rejects(
    () => _test.createScenarioLeadTodo(buildCtx(), { fetch: scenarioFetch }),
    (err) => {
      assert.ok(err instanceof GrpcError);
      assert.equal(err.code, grpcStatus.INVALID_ARGUMENT);
      assert.match(err.message, /scenario matched 2 records/);
      return true;
    },
  );

  const customerFetch = createFetch((body) => {
    if (body.query.includes('list_opportunity_scenario')) {
      return { list_opportunity_scenario: { total: 1, data: [{ id: 'scenario-1', name: 'ADP智能体开发' }] } };
    }
    if (body.query.includes('list_all_company')) {
      return { list_all_company: { total: 2, data: [{ id: 'c1', name: '客户' }, { id: 'c2', name: '客户' }] } };
    }
    throw new Error('should not continue after ambiguous customer');
  });

  await assert.rejects(
    () => _test.createScenarioLeadTodo(buildCtx({ request: { customerName: '客户' } }), { fetch: customerFetch }),
    /customer matched 2 records/,
  );
});

test('CreateScenarioLeadTodo retries rate limited lead lookup', async () => {
  let leadAttempts = 0;
  const baseFetch = createFetch((body) => {
    if (body.query.includes('list_opportunity_scenario')) {
      return { list_opportunity_scenario: { total: 1, data: [{ id: 'scenario-1', name: 'ADP智能体开发' }] } };
    }
    if (body.query.includes('list_all_company')) {
      return { list_all_company: { total: 1, data: [{ id: 'company-1', name: '客户', claim_by: { id: 'owner-1' } }] } };
    }
    if (body.query.includes('opportunity_scenario_related_company')) {
      return { opportunity_scenario_related_company: null };
    }
    if (body.query.includes('list_leads')) {
      return {
        list_leads: {
          total: 1,
          data: [{ id: 'lead-1', client_name: '客户', type: 'first_team_self_scenario', opportunity_scenario: { id: 'scenario-1' } }],
        },
      };
    }
    if (body.query.includes('listUser')) {
      return { listUser: { total: 1, data: [{ id: 'owner-1', username: 'yanming.wang', enabled: true }] } };
    }
    if (body.query.includes('create_todo_list')) {
      return { create_todo_list: 'todo-1' };
    }
    if (body.query.includes('leads_info')) {
      return {
        leads_info: {
          id: 'lead-1',
          client_name: '客户',
          opportunity_scenario: { id: 'scenario-1' },
          todos: [{ id: 'todo-1', name: '测试', type: 'leads', relation: { id: 'lead-1' }, processor: [{ id: 'owner-1' }] }],
        },
      };
    }
    throw new Error(`unexpected query: ${body.query}`);
  });
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.operationName === 'ListLeads') {
      leadAttempts += 1;
      if (leadAttempts === 1) {
        return { status: 429, text: async () => '请求过于频繁，请稍后再试\n' };
      }
    }
    return baseFetch(url, init);
  };

  const result = await _test.createScenarioLeadTodo(buildCtx({
    request: { customerName: '客户' },
    config: { leadPollAttempts: 3 },
  }), { fetch, sleep: async () => {} });

  assert.equal(result.lead.id, 'lead-1');
  assert.equal(leadAttempts, 2);
});

test('SDK handler invokes CreateScenarioLeadTodo with context config and secret', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetch((body) => {
    if (body.query.includes('list_opportunity_scenario')) {
      return { list_opportunity_scenario: { total: 1, data: [{ id: 'scenario-1', name: 'ADP智能体开发' }] } };
    }
    if (body.query.includes('list_all_company')) {
      return { list_all_company: { total: 1, data: [{ id: 'company-1', name: '客户', claim_by: { id: 'owner-1' } }] } };
    }
    if (body.query.includes('opportunity_scenario_related_company')) {
      return { opportunity_scenario_related_company: null };
    }
    if (body.query.includes('list_leads')) {
      return { list_leads: { total: 1, data: [{ id: 'lead-1', client_name: '客户', type: 'first_team_self_scenario', opportunity_scenario: { id: 'scenario-1' } }] } };
    }
    if (body.query.includes('listUser')) {
      return { listUser: { total: 1, data: [{ id: 'owner-1', username: 'yanming.wang', enabled: true }] } };
    }
    if (body.query.includes('create_todo_list')) {
      return { create_todo_list: 'todo-1' };
    }
    if (body.query.includes('leads_info')) {
      return {
        leads_info: {
          id: 'lead-1',
          client_name: '客户',
          opportunity_scenario: { id: 'scenario-1' },
          todos: [{ id: 'todo-1', name: '测试', type: 'leads', relation: { id: 'lead-1' }, processor: [{ id: 'owner-1' }] }],
        },
      };
    }
    throw new Error(`unexpected query: ${body.query}`);
  });

  try {
    const result = await handlers[METHOD_CREATE_SCENARIO_LEAD_TODO_FULL](buildCtx({ request: { customerName: '客户' } }));
    assert.equal(result.todo.id, 'todo-1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
