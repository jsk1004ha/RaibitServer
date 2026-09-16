import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';

test('rendered ingester RBAC permits only identity GET plus existing discovery reads',
  {skip:!process.env.OBSERVABILITY_HELM_RENDER},()=>{
  // Given actual rendered Helm resources, when evaluating effective ClusterRole rules.
  const documents = YAML.parseAllDocuments(readFileSync(process.env.OBSERVABILITY_HELM_RENDER,'utf8')).map(document=>document.toJSON());
  for (const component of ['log-ingester','metrics-ingester']) {
    const role = documents.find(document=>document?.kind==='ClusterRole' && document.metadata.name.endsWith('-'+component));
    assert.ok(role);
    const permissions = role.rules.flatMap(rule=>rule.apiGroups.flatMap(group=>rule.resources.flatMap(resource=>rule.verbs.map(verb=>group+'/'+resource+':'+verb))));
    // Then required identity access exists and no other permission is added.
    const required = ['/namespaces:get','/pods:get','apps/replicasets:get','apps/deployments:get','batch/jobs:get','batch/cronjobs:get'];
    const discovery = component==='log-ingester' ? ['/pods:list','/pods:watch','/pods/log:get'] : ['metrics.k8s.io/pods:get','metrics.k8s.io/pods:list','metrics.k8s.io/pods:watch'];
    assert.deepEqual(permissions.sort(),[...required,...discovery].sort(),component);
  }
});
