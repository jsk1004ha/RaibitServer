import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('PostgreSQL builder claims only deployment build workflows', async () => {
  const source = await fs.readFile('services/builder/internal/controlplane/postgres_store.go', 'utf8');
  assert.match(source, /type\s+IN\s*\([^)]*'build-and-deploy'[^)]*'preview-deploy'[^)]*\)/s);
  assert.doesNotMatch(source, /type\s+IN\s*\([^)]*'(?:github-repository-sync|preview-cleanup)'/s);
  assert.match(source, /NOT EXISTS[\s\S]*JOIN "Service"[\s\S]*JOIN "Project"/);
  for (const status of ['DELETE_REQUESTED', 'DELETING', 'DELETE_FAILED']) {
    assert.match(source, new RegExp(status));
  }
});

test('live builder digest and supply-chain execution fail closed', async () => {
  const source = await fs.readFile('services/builder/internal/worker/builder.go', 'utf8');
  assert.match(source, /buildctl[\s\S]*--metadata-file/);
  assert.match(source, /func \(b \*Builder\) resolveDigest\([^)]*\) \(string, error\)/);
  assert.match(source, /if b\.Config\.DryRun[\s\S]*deterministicDigest/);
  assert.match(source, /secret-looking build arg/i);
  assert.match(source, /func \(b \*Builder\) scanImage/);
  assert.match(source, /func \(b \*Builder\) signImage/);
  const digestIndex = source.indexOf('b.resolveDigest(state)');
  const scanIndex = source.indexOf('b.scanImage(ctx, state');
  const signIndex = source.indexOf('b.signImage(ctx, state');
  const readyIndex = source.indexOf('b.Store.PublishImageReady', source.indexOf('processClaimedJob'));
  assert.ok(digestIndex > 0 && digestIndex < scanIndex && scanIndex < signIndex && signIndex < readyIndex,
    'digest, scan, and sign must complete before fenced IMAGE_READY persistence');
  const resolveDigestIndex = source.indexOf('func (b *Builder) resolveDigest');
  const metadataReadIndex = source.indexOf('os.ReadFile(state.MetadataFile)', resolveDigestIndex);
  const carriedDigestIndex = source.indexOf('state.Deployment.ImageDigest', resolveDigestIndex);
  assert.ok(metadataReadIndex > 0 && metadataReadIndex < carriedDigestIndex,
    'a newly built image must use registry metadata instead of a carried deployment digest');
});

test('builder cancellation and IMAGE_READY publication are deletion and lease fenced', async () => {
  const [store, postgres, builder, storeTests, builderTests] = await Promise.all([
    fs.readFile('services/builder/internal/controlplane/store.go', 'utf8'),
    fs.readFile('services/builder/internal/controlplane/postgres_store.go', 'utf8'),
    fs.readFile('services/builder/internal/worker/builder.go', 'utf8'),
    fs.readFile('services/builder/internal/controlplane/store_test.go', 'utf8'),
    fs.readFile('services/builder/internal/worker/builder_test.go', 'utf8'),
  ]);
  assert.match(store, /ErrBuildTargetDeleting/);
  assert.match(store, /CancelWorkflowJob/);
  assert.match(store, /StartBuild/);
  assert.match(store, /PublishImageReady/);
  assert.match(postgres, /FOR UPDATE OF d, s, p/);
  assert.match(postgres, /lockBuildStartTargetSQL/);
  assert.match(postgres, /lockWorkflowLeaseSQL/);
  assert.match(builder, /b\.Store\.StartBuild/);
  assert.match(builder, /recheckTargetDeletion[\s\S]*scanImage[\s\S]*recheckTargetDeletion[\s\S]*signImage/);
  assert.match(builder, /build\.cancelled_deleting_target/);
  assert.match(storeTests, /TestFileStoreSkipsBuildJobsWhoseServiceOrProjectIsDeleting/);
  assert.match(storeTests, /stale owner image publication must be fenced/);
  assert.match(builderTests, /TestBuilderStopsBeforeScanWhenServiceIsTombstonedMidBuild/);
  assert.match(builderTests, /TestBuilderFinalPublicationFenceRejectsTombstoneAfterSigning/);
  assert.match(builderTests, /TestBuilderAtomicBuildStartRejectsTombstoneAfterInitialParentCheck/);
});

test('IMAGE_READY publication completes deployment, event, and workflow atomically', async () => {
  const [store, postgres, builder, storeTests] = await Promise.all([
    fs.readFile('services/builder/internal/controlplane/store.go', 'utf8'),
    fs.readFile('services/builder/internal/controlplane/postgres_store.go', 'utf8'),
    fs.readFile('services/builder/internal/worker/builder.go', 'utf8'),
    fs.readFile('services/builder/internal/controlplane/store_test.go', 'utf8'),
  ]);
  const filePublication = store.slice(store.indexOf('func (s *FileStore) PublishImageReady'), store.indexOf('func (s *FileStore) AppendBuildLog'));
  for (const marker of ['IMAGE_READY', 'WorkflowSucceeded', 'deploymentEvents', 'lastResult']) assert.match(filePublication, new RegExp(marker));
  assert.ok(filePublication.indexOf('WorkflowSucceeded') < filePublication.lastIndexOf('s.save(state)'));

  const postgresPublication = postgres.slice(postgres.indexOf('func (s *PostgresStore) PublishImageReady'), postgres.indexOf('func (s *PostgresStore) AppendBuildLog'));
  const workflowIndex = postgresPublication.indexOf('WorkflowSucceeded');
  const eventIndex = postgresPublication.indexOf('appendDeploymentEventRow');
  const commitIndex = postgresPublication.lastIndexOf('tx.Commit()');
  assert.ok(workflowIndex > 0 && workflowIndex < eventIndex && eventIndex < commitIndex,
    'PostgreSQL publication must write workflow and event before one transaction commit');

  const process = builder.slice(builder.indexOf('func (b *Builder) processClaimedJob'), builder.indexOf('func (b *Builder) resolveState'));
  const publicationIndex = process.indexOf('b.Store.PublishImageReady');
  assert.ok(publicationIndex > 0);
  assert.doesNotMatch(process.slice(publicationIndex), /CompleteWorkflowJob|AppendDeploymentEvent/);
  assert.match(storeTests, /TestFileStoreImagePublicationAtomicallyCompletesJobAndRecordsEvent/);
  assert.match(storeTests, /non-serializable publication evidence must not persist a partial FileStore state/);
});

test('orchestrator exposes an explicit mutable-image policy and validates sha256 digests', async () => {
  const source = await fs.readFile('services/orchestrator/internal/kube/deployment.go', 'utf8');
  assert.match(source, /func ResolveImageReference\([^)]*allowMutable bool\) \(string, error\)/);
  assert.match(source, /sha256:\[a-f0-9\]\{64\}/);
  assert.match(source, /allowMutable/);
});
