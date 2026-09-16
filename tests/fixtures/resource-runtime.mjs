// Explicit operator configuration for credential-free repository test fixtures.
process.env.RAIBITSERVER_RESOURCE_ENVIRONMENT = 'local';
for (const engine of ['postgresql', 'mysql', 'mariadb', 'mongodb', 'redis', 'valkey']) {
  process.env[`RAIBITSERVER_PROVIDER_${engine.toUpperCase()}_IMAGE`] = `registry.example.test/${engine}@sha256:${'a'.repeat(64)}`;
}
