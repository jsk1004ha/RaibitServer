export const E2E_MODES = Object.freeze({
  DRY: 'dry',
  LIVE: 'live',
  AUTO: 'auto',
});

const VALID_MODES = new Set(Object.values(E2E_MODES));
const LIVE_TOOL_GROUPS = Object.freeze([
  ['docker'],
  ['kubectl'],
  ['kind', 'k3d'],
]);

export function parseE2EOptions(args = [], env = process.env) {
  let requestedMode = env.RAIBITSERVER_E2E_MODE || E2E_MODES.DRY;
  let execute = env.RAIBITSERVER_EXECUTE === '1';

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--dry-run' || arg === '--dry') {
      requestedMode = E2E_MODES.DRY;
      execute = false;
    } else if (arg === '--live') {
      requestedMode = E2E_MODES.LIVE;
    } else if (arg === '--execute') {
      execute = true;
    } else if (arg === '--mode') {
      if (!args[i + 1]) throw new Error('--mode requires dry, live, or auto');
      requestedMode = args[i + 1];
      i += 1;
    } else if (arg.startsWith('--mode=')) {
      requestedMode = arg.slice('--mode='.length);
    } else {
      throw new Error(`unknown e2e option: ${arg}`);
    }
  }

  return { requestedMode: normalizeE2EMode(requestedMode), execute };
}

export function normalizeE2EMode(value) {
  const mode = String(value || E2E_MODES.DRY).toLowerCase();
  if (!VALID_MODES.has(mode)) throw new Error(`invalid e2e mode: ${value}; expected dry, live, or auto`);
  return mode;
}

export function hasLiveE2ETools(tools = {}) {
  return LIVE_TOOL_GROUPS.every((group) => group.some((tool) => tools[tool] === true));
}

export function missingLiveE2EToolGroups(tools = {}) {
  return LIVE_TOOL_GROUPS
    .filter((group) => !group.some((tool) => tools[tool] === true))
    .map((group) => group.join('|'));
}

export function resolveE2EPlan({ requestedMode = E2E_MODES.DRY, execute = false, tools = {} } = {}) {
  const normalized = normalizeE2EMode(requestedMode);
  const liveToolsReady = hasLiveE2ETools(tools);
  const missingTools = missingLiveE2EToolGroups(tools);

  if (normalized === E2E_MODES.LIVE) {
    if (!execute) throw new Error('live E2E requires --execute or RAIBITSERVER_EXECUTE=1 to make side effects explicit');
    if (!liveToolsReady) throw new Error(`live E2E requires local tools: ${missingTools.join(', ')}`);
    return {
      requestedMode: normalized,
      mode: E2E_MODES.LIVE,
      label: 'live-container-execute',
      dryRun: false,
      execute: true,
      liveToolsReady,
      missingTools,
      setup: liveE2ESetupPlan(tools),
    };
  }

  if (normalized === E2E_MODES.AUTO && execute && liveToolsReady) {
    return {
      requestedMode: normalized,
      mode: E2E_MODES.LIVE,
      label: 'live-container-execute',
      dryRun: false,
      execute: true,
      liveToolsReady,
      missingTools,
      setup: liveE2ESetupPlan(tools),
    };
  }

  return {
    requestedMode: normalized,
    mode: E2E_MODES.DRY,
    label: liveToolsReady ? 'dry-run-container-ready' : 'deterministic-dry-run',
    dryRun: true,
    execute: false,
    liveToolsReady,
    missingTools,
    setup: deterministicE2EFallbackPlan(missingTools),
  };
}

export function assertLegacyDevE2EDryRun(plan = {}) {
  if (plan.dryRun === false) {
    throw new Error('legacy TypeScript dev E2E is dry-run only; use the Go builder and Go orchestrator control-plane workers for live verification');
  }
}

export function liveE2ESetupPlan(tools = {}, options = {}) {
  const clusterName = options.clusterName || 'raibitserver-e2e';
  const registryName = options.registryName || 'raibitserver-registry';
  const registryPort = Number(options.registryPort || 5000);
  const clusterEngine = tools.kind ? 'kind' : tools.k3d ? 'k3d' : 'unavailable';
  const commands = [
    `docker inspect ${shellQuote(registryName)} >/dev/null 2>&1 || docker run -d -p ${registryPort}:5000 --restart=always --name ${shellQuote(registryName)} registry:2; docker start ${shellQuote(registryName)} >/dev/null`,
    clusterEngine === 'kind'
      ? kindCreateClusterCommand({ clusterName, registryName, registryPort })
      : `k3d cluster list ${shellQuote(clusterName)} >/dev/null 2>&1 || k3d cluster create ${shellQuote(clusterName)} --agents 1 --registry-use ${shellQuote(`${registryName}:5000`)} -p "80:80@loadbalancer"`,
    ...(clusterEngine === 'kind' ? [
      `docker network inspect kind >/dev/null 2>&1 && docker network connect kind ${shellQuote(registryName)} 2>/dev/null || true`,
      kindLocalRegistryConfigMapCommand({ registryPort }),
    ] : []),
    'kubectl apply -f infra/operators/manageddatabase-crd.yaml',
    'kubectl apply -f infra/operators/managedresources-crd.yaml',
    'kubectl get namespace ingress-nginx || kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml',
    'kubectl wait --namespace ingress-nginx --for=condition=ready pod --selector=app.kubernetes.io/component=controller --timeout=180s',
    `kubectl get nodes -o wide && kubectl get pods -A`,
  ];
  return { clusterEngine, clusterName, registryName, registryPort, registryReachableFromCluster: clusterEngine !== 'unavailable', ingress: 'ingress-nginx', commands };
}

export function deterministicE2EFallbackPlan(missingTools = []) {
  return {
    clusterEngine: 'dry-run',
    registryName: 'dry-run-registry',
    ingress: 'dry-run-ingress',
    reason: missingTools.length ? `missing live tool group(s): ${missingTools.join(', ')}` : 'execute flag not set',
    commands: [],
  };
}

function kindCreateClusterCommand({ clusterName, registryName, registryPort }) {
  return `kind get clusters | grep -qx ${shellQuote(clusterName)} || cat <<'KIND_CONFIG' | kind create cluster --name ${shellQuote(clusterName)} --config=-
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
containerdConfigPatches:
- |-
  [plugins."io.containerd.grpc.v1.cri".registry.mirrors."localhost:${registryPort}"]
    endpoint = ["http://${registryName}:5000"]
nodes:
- role: control-plane
  extraPortMappings:
  - containerPort: 80
    hostPort: 80
    protocol: TCP
KIND_CONFIG`;
}

function kindLocalRegistryConfigMapCommand({ registryPort }) {
  return `cat <<'KIND_REGISTRY' | kubectl apply -f -
apiVersion: v1
kind: ConfigMap
metadata:
  name: local-registry-hosting
  namespace: kube-public
data:
  localRegistryHosting.v1: |
    host: "localhost:${registryPort}"
    help: "https://kind.sigs.k8s.io/docs/user/local-registry/"
KIND_REGISTRY`;
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", "'\"'\"'")}'`;
}
