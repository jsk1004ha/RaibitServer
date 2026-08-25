import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import YAML from 'yaml';

const repo = new URL('..', import.meta.url);

test('Cloudflare Tunnel docs lock flat wildcard and security guardrails', async () => {
  const doc = await fs.readFile(new URL('docs/cloudflare-tunnel.md', repo), 'utf8');

  for (const required of [
    '*.<BASE_DOMAIN>',
    'apps--gdg-hongik--festival-2026.<BASE_DOMAIN>',
    'preview--pr-32--gdg-hongik--festival-2026.<BASE_DOMAIN>',
    'console--gdg-hongik--festival-2026-api.<BASE_DOMAIN>',
    'resources--gdg-hongik--festival-2026-postgres.<BASE_DOMAIN>',
    '내부 Kubernetes Ingress Controller',
    'Cloudflare Access',
    'host-only',
    '부모 도메인 쿠키',
    'HttpOnly 쿠키',
    'userRole=ADMIN',
    '/api/*/stream',
    '/github/webhooks',
    'DB 포트를 일반 사용자용 public tunnel로 열지 않습니다',
    'origin port가 인터넷에 열려 있으면',
  ]) {
    assert.match(doc, new RegExp(escapeRegExp(required)));
  }

  assert.doesNotMatch(
    doc,
    /^\|\s*`\*\.apps\.<BASE_DOMAIN>`\s*\|/m,
    'docs must not configure the legacy deep wildcard as an active tunnel route',
  );
  assert.doesNotMatch(doc, /test\.\*\.example\.com.*권장/);
  assert.doesNotMatch(doc, /RAIBITSERVER_COOKIE_DOMAIN/);
});

test('Cloudflare Tunnel example routes one free-tier wildcard to Traefik websecure', async () => {
  const example = await fs.readFile(new URL('deploy/production/cloudflare-tunnel.example.yml', repo), 'utf8');
  const rendered = example
    .replaceAll('<TUNNEL_UUID>', '00000000-0000-0000-0000-000000000000')
    .replaceAll('<TRAEFIK_ORIGIN>', '172.31.99.245');
  const config = YAML.parse(rendered);
  const rules = config.ingress;

  assert.ok(Array.isArray(rules));
  assert.deepEqual(
    rules.filter((rule) => rule.hostname).map((rule) => rule.hostname),
    [
      'raibitserver.app',
      'api.raibitserver.app',
      'console.raibitserver.app',
      '*.raibitserver.app',
    ],
  );

  const originServices = new Set(rules.filter((rule) => rule.hostname).map((rule) => rule.service));
  assert.deepEqual([...originServices], ['https://172.31.99.245:443']);
  assert.equal(rules[0].originRequest.originServerName, 'raibitserver.app');
  assert.equal(rules[1].originRequest.originServerName, 'api.raibitserver.app');
  assert.equal(rules[2].originRequest.originServerName, 'console.raibitserver.app');
  assert.equal(rules[3].originRequest.noTLSVerify, true);
  assert.equal(rules.at(-1).service, 'http_status:404');
  assert.equal(rules.some((rule) => /\.\*\./.test(String(rule.hostname || ''))), false);
  assert.equal(rules.some((rule) => String(rule.service || '').startsWith('tcp://')), false);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
