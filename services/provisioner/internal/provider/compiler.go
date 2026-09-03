package provider

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/raibitserver/provisioner/internal/store"
)

var (
	digestImagePattern          = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-fA-F0-9]{64}$`)
	slugPattern                 = regexp.MustCompile(`[^a-z0-9]+`)
	dnsNamePattern              = regexp.MustCompile(`[^a-z0-9-]+`)
	dnsLabelPattern             = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`)
	credentialGenerationPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
)

type Plan struct {
	Image           string
	Engine          string
	Provider        string
	Name            string
	Namespace       string
	SecretName      string
	PVCName         string
	Endpoint        string
	ConnectionKeys  []string
	ProbeCommand    []string
	SecretData      map[string]string
	Labels          map[string]any
	PublicManifests []map[string]any
}

func Compile(resource *store.Resource, image string) (*Plan, error) {
	if resource == nil {
		return nil, fmt.Errorf("resource is required")
	}
	engine, err := supportedEngine(resource.Engine, resource.Provider)
	if err != nil {
		return nil, err
	}
	planName := strings.ToLower(strings.TrimSpace(resource.Plan))
	if planName != "" && planName != "shared-small" && planName != "dedicated-local" {
		return nil, fmt.Errorf("provider plan %q is not implemented by the dedicated local reconciler", resource.Plan)
	}
	if strings.TrimSpace(resource.Version) != "" {
		return nil, fmt.Errorf("provider version selection is not implemented; use the operator-pinned provider image")
	}
	region := strings.ToLower(strings.TrimSpace(resource.Region))
	if region != "" && region != "local" {
		return nil, fmt.Errorf("provider region %q is not served by the dedicated local reconciler", resource.Region)
	}
	image = strings.TrimSpace(image)
	if !digestImagePattern.MatchString(image) {
		return nil, fmt.Errorf("provider image for %s must be configured and pinned by sha256 digest", engine)
	}
	name, namespace, secretName, pvcName, err := ObjectNames(resource)
	if err != nil {
		return nil, err
	}
	password, err := randomSecret(32)
	if err != nil {
		return nil, fmt.Errorf("generate provider credential: %w", err)
	}
	secondary, err := randomSecret(32)
	if err != nil {
		return nil, fmt.Errorf("generate provider credential: %w", err)
	}
	reconcileToken, err := randomSecret(18)
	if err != nil {
		return nil, fmt.Errorf("generate provider reconcile token: %w", err)
	}
	database := identifier(firstNonEmpty(stringValue(resource.DesiredSpec, "databaseName"), resource.Name, "app"))
	target := database
	switch engine {
	case "object-storage":
		target = strings.ReplaceAll(identifier(firstNonEmpty(stringValue(resource.DesiredSpec, "bucket"), stringValue(resource.DesiredSpec, "databaseName"), resource.Name, "app")), "_", "-")
	case "qdrant":
		target = identifier(firstNonEmpty(stringValue(resource.DesiredSpec, "collection"), stringValue(resource.DesiredSpec, "databaseName"), resource.Name, "app"))
	case "nats":
		target = identifier(firstNonEmpty(stringValue(resource.DesiredSpec, "topic"), stringValue(resource.DesiredSpec, "databaseName"), resource.Name, "app"))
	}
	username := identifier(firstNonEmpty(stringValue(resource.DesiredSpec, "username"), name+"-app"))
	if (engine == "mysql" || engine == "mariadb") && username == "root" {
		return nil, fmt.Errorf("provider username %q is reserved by the %s image", username, engine)
	}
	host := name + "." + namespace + ".svc.cluster.local"
	port, data, connectionKeys, container := providerContract(engine, host, target, username, password, secondary, secretName)
	endpoint := fmt.Sprintf("%s:%d", host, port)
	labels := map[string]any{
		"app.kubernetes.io/name":       name,
		"app.kubernetes.io/managed-by": "raibitserver",
		"raibitserver.io/managed":      "true",
		"raibitserver.io/project-id":   boundedDNSName(resource.ProjectID, resource.ProjectID, 63),
		"raibitserver.io/resource-id":  boundedDNSName(resource.ID, resource.ID, 63),
		"raibitserver.io/provider":     engine,
	}
	storage := storageSize(resource.DesiredSpec)
	plan := &Plan{
		Image:  image,
		Engine: engine, Provider: "raibitserver-local-" + engine, Name: name, Namespace: namespace,
		SecretName: secretName, PVCName: pvcName, Endpoint: endpoint, ConnectionKeys: connectionKeys, ProbeCommand: container.ProbeCommand, SecretData: data, Labels: labels,
	}
	plan.PublicManifests = []map[string]any{
		tenantNamespaceManifest(namespace, resource.ProjectID, resource.ProjectSlug),
		persistentVolumeClaim(namespace, pvcName, labels, storage),
		service(namespace, name, labels, port),
		statefulSet(namespace, name, labels, image, port, secretName, pvcName, reconcileToken, data, container),
		networkPolicy(namespace, name, labels, port),
	}
	return plan, nil
}

func tenantNamespaceManifest(namespace, projectID, projectSlug string) map[string]any {
	return map[string]any{
		"apiVersion": "v1",
		"kind":       "Namespace",
		"metadata": map[string]any{
			"name": namespace,
			"labels": map[string]any{
				"app.kubernetes.io/managed-by":       "raibitserver",
				"raibitserver.io/managed":            "true",
				"raibitserver.io/namespace-kind":     "application",
				"raibitserver.io/project":            boundedDNSName(projectSlug, projectID, 63),
				"raibitserver.io/project-id":         boundedDNSName(projectID, projectID, 63),
				"pod-security.kubernetes.io/enforce": "restricted",
				"pod-security.kubernetes.io/audit":   "restricted",
				"pod-security.kubernetes.io/warn":    "restricted",
			},
		},
	}
}

func (p *Plan) SecretManifest() map[string]any {
	return p.secretManifest(nil)
}

func (p *Plan) OwnedSecretManifest(resourceID, projectID, generation string) (map[string]any, error) {
	resourceID = strings.TrimSpace(resourceID)
	projectID = strings.TrimSpace(projectID)
	generation = strings.TrimSpace(generation)
	if resourceID == "" || projectID == "" || !credentialGenerationPattern.MatchString(generation) {
		return nil, fmt.Errorf("credential Secret ownership identity is invalid")
	}
	return p.secretManifest(map[string]any{
		"raibitserver.io/credential-owner":      "raibitserver-provisioner",
		"raibitserver.io/credential-generation": generation,
		"raibitserver.io/resource-id":           resourceID,
		"raibitserver.io/project-id":            projectID,
	}), nil
}

func (p *Plan) secretManifest(annotations map[string]any) map[string]any {
	labels := make(map[string]any, len(p.Labels))
	for key, value := range p.Labels {
		labels[key] = value
	}
	metadata := map[string]any{
		"name": p.SecretName, "namespace": p.Namespace,
		"labels": labels,
	}
	if annotations != nil {
		metadata["annotations"] = annotations
	}
	return map[string]any{
		"apiVersion": "v1", "kind": "Secret",
		"metadata": metadata,
		"type":     "Opaque", "immutable": true, "stringData": p.SecretData,
	}
}

func (p *Plan) TenantAccessManifest(serviceAccountName, serviceAccountNamespace, tenantRoleName string) (map[string]any, error) {
	if p == nil || !validDNSLabel(p.Namespace) {
		return nil, fmt.Errorf("provider plan namespace is invalid")
	}
	return tenantAccessManifest(p.Namespace, fmt.Sprint(p.Labels["raibitserver.io/project-id"]), serviceAccountName, serviceAccountNamespace, tenantRoleName)
}

func TenantBootstrapManifests(resource *store.Resource, serviceAccountName, serviceAccountNamespace, tenantRoleName string) ([]map[string]any, error) {
	_, namespace, _, _, err := ObjectNames(resource)
	if err != nil {
		return nil, err
	}
	access, err := tenantAccessManifest(namespace, boundedDNSName(resource.ProjectID, resource.ProjectID, 63), serviceAccountName, serviceAccountNamespace, tenantRoleName)
	if err != nil {
		return nil, err
	}
	return []map[string]any{
		tenantNamespaceManifest(namespace, resource.ProjectID, resource.ProjectSlug),
		access,
	}, nil
}

func tenantAccessManifest(namespace, projectID, serviceAccountName, serviceAccountNamespace, tenantRoleName string) (map[string]any, error) {
	if !validDNSLabel(namespace) {
		return nil, fmt.Errorf("provider namespace is invalid")
	}
	serviceAccountName = strings.TrimSpace(serviceAccountName)
	serviceAccountNamespace = strings.TrimSpace(serviceAccountNamespace)
	tenantRoleName = strings.TrimSpace(tenantRoleName)
	if !validDNSLabel(serviceAccountName) {
		return nil, fmt.Errorf("provisioner service account name is invalid")
	}
	if !validDNSLabel(serviceAccountNamespace) {
		return nil, fmt.Errorf("provisioner service account namespace is invalid")
	}
	if !validDNSLabel(tenantRoleName) {
		return nil, fmt.Errorf("provisioner tenant role name is invalid")
	}
	return map[string]any{
		"apiVersion": "rbac.authorization.k8s.io/v1",
		"kind":       "RoleBinding",
		"metadata": map[string]any{
			"name":      boundedDNSName(serviceAccountName+"-tenant-access", tenantRoleName, 63),
			"namespace": namespace,
			"labels": map[string]any{
				"app.kubernetes.io/managed-by": "raibitserver",
				"raibitserver.io/managed":      "true",
				"raibitserver.io/project-id":   projectID,
			},
		},
		"roleRef": map[string]any{
			"apiGroup": "rbac.authorization.k8s.io",
			"kind":     "ClusterRole",
			"name":     tenantRoleName,
		},
		"subjects": []any{map[string]any{
			"apiGroup":  "",
			"kind":      "ServiceAccount",
			"name":      serviceAccountName,
			"namespace": serviceAccountNamespace,
		}},
	}, nil
}

// UseExistingSecret makes an already-created immutable Secret authoritative for
// retries. It accepts credential changes from the freshly compiled random plan,
// but rejects missing/extra keys and any change to the public provider contract.
func (p *Plan) UseExistingSecret(existing map[string]string) error {
	if p == nil {
		return fmt.Errorf("provider plan is required")
	}
	if len(existing) != len(p.SecretData) {
		return fmt.Errorf("existing provider Secret has an unexpected key set")
	}
	for key := range p.SecretData {
		if strings.TrimSpace(existing[key]) == "" {
			return fmt.Errorf("existing provider Secret is missing required key %q", key)
		}
	}
	for key := range existing {
		if _, ok := p.SecretData[key]; !ok {
			return fmt.Errorf("existing provider Secret contains unexpected key %q", key)
		}
	}

	var expected map[string]string
	switch p.Engine {
	case "postgresql":
		_, expected, _, _ = providerContract(p.Engine, p.SecretData["PGHOST"], p.SecretData["PGDATABASE"], p.SecretData["PGUSER"], existing["PGPASSWORD"], "", p.SecretName)
	case "mysql":
		_, expected, _, _ = providerContract(p.Engine, p.SecretData["MYSQL_HOST"], p.SecretData["MYSQL_DATABASE"], p.SecretData["MYSQL_USER"], existing["MYSQL_PASSWORD"], existing["MYSQL_ROOT_PASSWORD"], p.SecretName)
	case "mariadb":
		_, expected, _, _ = providerContract(p.Engine, p.SecretData["MYSQL_HOST"], p.SecretData["MYSQL_DATABASE"], p.SecretData["MYSQL_USER"], existing["MYSQL_PASSWORD"], existing["MARIADB_ROOT_PASSWORD"], p.SecretName)
	case "mongodb":
		_, expected, _, _ = providerContract(p.Engine, p.SecretData["MONGO_HOST"], p.SecretData["MONGO_DATABASE"], p.SecretData["MONGO_USER"], existing["MONGO_PASSWORD"], "", p.SecretName)
	case "redis", "valkey":
		_, expected, _, _ = providerContract(p.Engine, p.SecretData["REDIS_HOST"], "", "", existing["REDIS_PASSWORD"], "", p.SecretName)
	case "nats":
		_, expected, _, _ = providerContract(p.Engine, hostFromEndpoint(p.Endpoint), p.SecretData["QUEUE_TOPIC"], p.SecretData["QUEUE_USERNAME"], existing["QUEUE_PASSWORD"], "", p.SecretName)
	case "object-storage":
		expected = cloneSecretData(p.SecretData)
		expected["S3_ACCESS_KEY"] = existing["S3_ACCESS_KEY"]
		expected["MINIO_ROOT_USER"] = existing["S3_ACCESS_KEY"]
		expected["S3_SECRET_KEY"] = existing["S3_SECRET_KEY"]
		expected["MINIO_ROOT_PASSWORD"] = existing["S3_SECRET_KEY"]
	case "qdrant":
		expected = cloneSecretData(p.SecretData)
		expected["VECTOR_DB_API_KEY"] = existing["VECTOR_DB_API_KEY"]
		expected["QDRANT__SERVICE__API_KEY"] = existing["VECTOR_DB_API_KEY"]
	default:
		return fmt.Errorf("existing Secret validation is unavailable for provider %q", p.Engine)
	}
	for key, value := range expected {
		if existing[key] != value {
			return fmt.Errorf("existing provider Secret key %q does not match the desired provider contract", key)
		}
	}
	p.SecretData = cloneSecretData(existing)
	return nil
}

func cloneSecretData(input map[string]string) map[string]string {
	result := make(map[string]string, len(input))
	for key, value := range input {
		result[key] = value
	}
	return result
}

func hostFromEndpoint(endpoint string) string {
	if index := strings.LastIndex(endpoint, ":"); index > 0 {
		return endpoint[:index]
	}
	return endpoint
}

func ObjectNames(resource *store.Resource) (name, namespace, secretName, pvcName string, err error) {
	if resource == nil {
		return "", "", "", "", fmt.Errorf("resource is required")
	}
	// Object identity must remain available for cleanup of rows created by older
	// versions even when their provider routing value is no longer accepted for
	// new provisioning.
	if _, err = normalizeEngine(resource.Engine); err != nil {
		return "", "", "", "", err
	}
	if identity, exists := resource.DesiredState["providerIdentity"]; exists {
		persisted, ok := identity.(map[string]any)
		if !ok {
			return "", "", "", "", fmt.Errorf("persisted provider object identity is invalid")
		}
		namespace = strings.TrimSpace(stringValue(persisted, "namespace"))
		name = strings.TrimSpace(stringValue(persisted, "name"))
		if !validDNSLabel(namespace) || !validDNSLabel(name) || len(name)+len("-connection") > 63 {
			return "", "", "", "", fmt.Errorf("persisted provider object identity is invalid")
		}
		secretName = name + "-connection"
		pvcName = name + "-data"
		if existing := strings.TrimSpace(resource.ConnectionSecretName); existing != "" && existing != secretName {
			return "", "", "", "", fmt.Errorf("persisted provider credential name conflicts with provider object identity")
		}
		if providerResult, ok := resource.DesiredState["providerResult"].(map[string]any); ok {
			if legacyNamespace := strings.TrimSpace(stringValue(providerResult, "namespace")); legacyNamespace != "" && legacyNamespace != namespace {
				return "", "", "", "", fmt.Errorf("persisted provider namespace conflicts with provider object identity")
			}
			if legacyName := strings.TrimSpace(stringValue(providerResult, "name")); legacyName != "" && legacyName != name {
				return "", "", "", "", fmt.Errorf("persisted provider name conflicts with provider object identity")
			}
		}
		return name, namespace, secretName, pvcName, nil
	}
	namespace = tenantNamespace(resource)
	if providerResult, ok := resource.DesiredState["providerResult"].(map[string]any); ok {
		if persistedNamespace := strings.TrimSpace(stringValue(providerResult, "namespace")); persistedNamespace != "" {
			if !validDNSLabel(persistedNamespace) {
				return "", "", "", "", fmt.Errorf("persisted provider namespace is invalid")
			}
			namespace = persistedNamespace
		}
	}
	if persistedSecret := strings.TrimSpace(resource.ConnectionSecretName); persistedSecret != "" {
		if validDNSLabel(persistedSecret) && strings.HasSuffix(persistedSecret, "-connection") {
			name = strings.TrimSuffix(persistedSecret, "-connection")
			if name == "" || len(name)+len("-provider") > 63 {
				return "", "", "", "", fmt.Errorf("persisted provider object name is invalid")
			}
			return name, namespace, persistedSecret, name + "-data", nil
		}
	}
	name, err = stableResourceName(resource)
	if err != nil {
		return "", "", "", "", err
	}
	return name, namespace, boundedSlug(name+"-connection", 63), boundedSlug(name+"-data", 63), nil
}

func validDNSLabel(value string) bool {
	return len(value) > 0 && len(value) <= 63 && dnsLabelPattern.MatchString(value)
}

func stableResourceName(resource *store.Resource) (string, error) {
	identity := strings.TrimSpace(resource.ID)
	if identity == "" {
		return "", fmt.Errorf("resource id is required for stable provider object identity")
	}
	base := boundedDNSName(identity, identity, 37)
	hash := sha256.Sum256([]byte(identity))
	return base + "-" + fmt.Sprintf("%x", hash[:6]), nil
}

type containerContract struct {
	Args             []any
	Command          []any
	Ports            []any
	FixedEnvironment map[string]string
	DataMountPath    string
	AdditionalVolume map[string]any
	AdditionalMount  map[string]any
	ProbeCommand     []string
	RunAsUser        int64
}

func providerContract(engine, host, database, username, password, secondary, secretName string) (int, map[string]string, []string, containerContract) {
	switch engine {
	case "postgresql":
		port := 5432
		url := fmt.Sprintf("postgresql://%s:%s@%s:%d/%s", username, password, host, port, database)
		data := map[string]string{"DATABASE_URL": url, "POSTGRES_URL": url, "PGHOST": host, "PGPORT": strconv.Itoa(port), "PGDATABASE": database, "PGUSER": username, "PGPASSWORD": password, "POSTGRES_DB": database, "POSTGRES_USER": username, "POSTGRES_PASSWORD": password}
		probe := fmt.Sprintf(`test "$PGHOST" = %q && test "$PGPORT" = "5432" && test "$PGDATABASE" = %q && test "$PGUSER" = %q && test "$POSTGRES_DB" = "$PGDATABASE" && test "$POSTGRES_USER" = "$PGUSER" && test "$POSTGRES_PASSWORD" = "$PGPASSWORD" && test "$DATABASE_URL" = "postgresql://$PGUSER:$PGPASSWORD@$PGHOST:$PGPORT/$PGDATABASE" && test "$POSTGRES_URL" = "$DATABASE_URL" && exec psql --no-psqlrc --host=127.0.0.1 --port="$PGPORT" --username="$PGUSER" --dbname="$PGDATABASE" --set=ON_ERROR_STOP=1 --command='SELECT 1' >/dev/null`, host, database, username)
		return port, data, []string{"DATABASE_URL", "POSTGRES_URL", "PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"}, containerContract{FixedEnvironment: map[string]string{"PGDATA": "/var/lib/postgresql/data/pgdata"}, DataMountPath: "/var/lib/postgresql/data", ProbeCommand: []string{"/bin/sh", "-ec", probe}, RunAsUser: 70}
	case "mysql":
		port := 3306
		url := fmt.Sprintf("mysql://%s:%s@%s:%d/%s", username, password, host, port, database)
		data := map[string]string{"MYSQL_URL": url, "MYSQL_HOST": host, "MYSQL_PORT": strconv.Itoa(port), "MYSQL_DATABASE": database, "MYSQL_USER": username, "MYSQL_PASSWORD": password, "MYSQL_PWD": password, "MYSQL_ROOT_PASSWORD": secondary}
		probe := fmt.Sprintf(`test "$MYSQL_HOST" = %q && test "$MYSQL_PORT" = "3306" && test "$MYSQL_DATABASE" = %q && test "$MYSQL_USER" = %q && test "$MYSQL_PWD" = "$MYSQL_PASSWORD" && test "$MYSQL_URL" = "mysql://$MYSQL_USER:$MYSQL_PASSWORD@$MYSQL_HOST:$MYSQL_PORT/$MYSQL_DATABASE" && exec mysql --protocol=TCP --host=127.0.0.1 --port="$MYSQL_PORT" --user="$MYSQL_USER" "$MYSQL_DATABASE" --execute='SELECT 1' >/dev/null`, host, database, username)
		return port, data, []string{"MYSQL_URL", "MYSQL_HOST", "MYSQL_PORT", "MYSQL_DATABASE", "MYSQL_USER", "MYSQL_PASSWORD"}, containerContract{DataMountPath: "/var/lib/mysql", ProbeCommand: []string{"/bin/sh", "-ec", probe}, RunAsUser: 999}
	case "mariadb":
		port := 3306
		url := fmt.Sprintf("mysql://%s:%s@%s:%d/%s", username, password, host, port, database)
		data := map[string]string{"MARIADB_URL": url, "MYSQL_URL": url, "MYSQL_HOST": host, "MYSQL_PORT": strconv.Itoa(port), "MYSQL_DATABASE": database, "MYSQL_USER": username, "MYSQL_PASSWORD": password, "MYSQL_PWD": password, "MARIADB_DATABASE": database, "MARIADB_USER": username, "MARIADB_PASSWORD": password, "MARIADB_ROOT_PASSWORD": secondary}
		probe := fmt.Sprintf(`test "$MYSQL_HOST" = %q && test "$MYSQL_PORT" = "3306" && test "$MYSQL_DATABASE" = %q && test "$MYSQL_USER" = %q && test "$MYSQL_PWD" = "$MYSQL_PASSWORD" && test "$MARIADB_DATABASE" = "$MYSQL_DATABASE" && test "$MARIADB_USER" = "$MYSQL_USER" && test "$MARIADB_PASSWORD" = "$MYSQL_PASSWORD" && test "$MYSQL_URL" = "mysql://$MYSQL_USER:$MYSQL_PASSWORD@$MYSQL_HOST:$MYSQL_PORT/$MYSQL_DATABASE" && test "$MARIADB_URL" = "$MYSQL_URL" && exec mariadb --protocol=TCP --host=127.0.0.1 --port="$MYSQL_PORT" --user="$MYSQL_USER" "$MYSQL_DATABASE" --execute='SELECT 1' >/dev/null`, host, database, username)
		return port, data, []string{"MARIADB_URL", "MYSQL_URL", "MYSQL_HOST", "MYSQL_PORT", "MYSQL_DATABASE", "MYSQL_USER", "MYSQL_PASSWORD"}, containerContract{DataMountPath: "/var/lib/mysql", ProbeCommand: []string{"/bin/sh", "-ec", probe}, RunAsUser: 999}
	case "mongodb":
		port := 27017
		url := fmt.Sprintf("mongodb://%s:%s@%s:%d/%s?authSource=admin", username, password, host, port, database)
		data := map[string]string{"MONGODB_URI": url, "MONGO_URL": url, "MONGO_HOST": host, "MONGO_DATABASE": database, "MONGO_USER": username, "MONGO_PASSWORD": password, "MONGO_INITDB_DATABASE": database, "MONGO_INITDB_ROOT_USERNAME": username, "MONGO_INITDB_ROOT_PASSWORD": password}
		probe := fmt.Sprintf(`test "$MONGO_HOST" = %q && test "$MONGO_DATABASE" = %q && test "$MONGO_USER" = %q && test "$MONGO_INITDB_DATABASE" = "$MONGO_DATABASE" && test "$MONGO_INITDB_ROOT_USERNAME" = "$MONGO_USER" && test "$MONGO_INITDB_ROOT_PASSWORD" = "$MONGO_PASSWORD" && test "$MONGODB_URI" = "mongodb://$MONGO_USER:$MONGO_PASSWORD@$MONGO_HOST:27017/$MONGO_DATABASE?authSource=admin" && test "$MONGO_URL" = "$MONGODB_URI" && exec mongosh --quiet "mongodb://$MONGO_USER:$MONGO_PASSWORD@127.0.0.1:27017/$MONGO_DATABASE?authSource=admin" --eval 'quit(db.runCommand({ ping: 1 }).ok === 1 ? 0 : 1)' >/dev/null`, host, database, username)
		return port, data, []string{"MONGODB_URI", "MONGO_URL", "MONGO_HOST", "MONGO_DATABASE", "MONGO_USER", "MONGO_PASSWORD"}, containerContract{DataMountPath: "/data/db", ProbeCommand: []string{"/bin/sh", "-ec", probe}, RunAsUser: 999}
	case "redis", "valkey":
		port := 6379
		url := fmt.Sprintf("redis://:%s@%s:%d/0", password, host, port)
		data := map[string]string{"REDIS_URL": url, "REDIS_HOST": host, "REDIS_PORT": strconv.Itoa(port), "REDIS_USERNAME": "default", "REDIS_PASSWORD": password}
		keys := []string{"REDIS_URL", "REDIS_HOST", "REDIS_PORT", "REDIS_USERNAME", "REDIS_PASSWORD"}
		if engine == "valkey" {
			data["VALKEY_URL"] = url
			keys = append(keys, "VALKEY_URL")
		}
		cli := "redis-cli"
		if engine == "valkey" {
			cli = "valkey-cli"
		}
		probe := fmt.Sprintf(`test "$REDIS_HOST" = %q && test "$REDIS_PORT" = "6379" && test "$REDIS_USERNAME" = "default" && test "$REDIS_URL" = "redis://:$REDIS_PASSWORD@$REDIS_HOST:$REDIS_PORT/0"`, host)
		if engine == "valkey" {
			probe += ` && test "$VALKEY_URL" = "$REDIS_URL"`
		}
		probe += "; unset REDISCLI_AUTH VALKEYCLI_AUTH; test \"$(" + cli + " -h 127.0.0.1 -p \"$REDIS_PORT\" --raw AUTH \"$REDIS_PASSWORD\")\" = \"OK\"; export REDISCLI_AUTH=\"$REDIS_PASSWORD\" VALKEYCLI_AUTH=\"$REDIS_PASSWORD\"; test \"$(" + cli + " -h 127.0.0.1 -p \"$REDIS_PORT\" --raw PING)\" = PONG"
		return port, data, keys, containerContract{Args: []any{"--requirepass", "$(REDIS_PASSWORD)"}, DataMountPath: "/data", ProbeCommand: []string{"/bin/sh", "-ec", probe}, RunAsUser: 999}
	case "object-storage":
		port := 9000
		accessKey := "ak-" + strings.ToLower(secondary[:18])
		endpoint := fmt.Sprintf("http://%s:%d", host, port)
		data := map[string]string{"S3_ENDPOINT": endpoint, "S3_BUCKET": database, "S3_REGION": "local", "S3_ACCESS_KEY": accessKey, "S3_SECRET_KEY": password, "MINIO_ROOT_USER": accessKey, "MINIO_ROOT_PASSWORD": password}
		return port, data, []string{"S3_ENDPOINT", "S3_BUCKET", "S3_REGION", "S3_ACCESS_KEY", "S3_SECRET_KEY"}, containerContract{Args: []any{"server", "/data", "--console-address", ":9001"}, Ports: []any{map[string]any{"name": "console", "containerPort": 9001}}, DataMountPath: "/data"}
	case "qdrant":
		port := 6333
		endpoint := fmt.Sprintf("http://%s:%d", host, port)
		data := map[string]string{"VECTOR_DB_URL": endpoint, "QDRANT_URL": endpoint, "VECTOR_DB_API_KEY": password, "QDRANT__SERVICE__API_KEY": password, "VECTOR_DB_COLLECTION": database}
		return port, data, []string{"VECTOR_DB_URL", "QDRANT_URL", "VECTOR_DB_API_KEY", "VECTOR_DB_COLLECTION"}, containerContract{DataMountPath: "/qdrant/storage"}
	case "nats":
		port := 4222
		url := fmt.Sprintf("nats://%s:%s@%s:%d", username, password, host, port)
		config := fmt.Sprintf("jetstream { store_dir: /data/jetstream }\nauthorization { users: [ { user: %q, password: %q } ] }\n", username, password)
		data := map[string]string{"QUEUE_URL": url, "NATS_URL": url, "QUEUE_USERNAME": username, "QUEUE_PASSWORD": password, "QUEUE_TOPIC": database, "nats.conf": config}
		return port, data, []string{"QUEUE_URL", "NATS_URL", "QUEUE_USERNAME", "QUEUE_PASSWORD", "QUEUE_TOPIC"}, containerContract{
			Args:             []any{"-c", "/etc/nats/nats.conf"},
			DataMountPath:    "/data",
			AdditionalVolume: map[string]any{"name": "provider-config", "secret": map[string]any{"secretName": secretName, "items": []any{map[string]any{"key": "nats.conf", "path": "nats.conf"}}}},
			AdditionalMount:  map[string]any{"name": "provider-config", "mountPath": "/etc/nats", "readOnly": true},
		}
	default:
		panic("supported engine without provider contract: " + engine)
	}
}

func persistentVolumeClaim(namespace, name string, labels map[string]any, storage string) map[string]any {
	return map[string]any{"apiVersion": "v1", "kind": "PersistentVolumeClaim", "metadata": map[string]any{"name": name, "namespace": namespace, "labels": labels}, "spec": map[string]any{"accessModes": []any{"ReadWriteOnce"}, "resources": map[string]any{"requests": map[string]any{"storage": storage}}}}
}

func service(namespace, name string, labels map[string]any, port int) map[string]any {
	return map[string]any{"apiVersion": "v1", "kind": "Service", "metadata": map[string]any{"name": name, "namespace": namespace, "labels": labels}, "spec": map[string]any{"clusterIP": "None", "selector": map[string]any{"app.kubernetes.io/name": name}, "ports": []any{map[string]any{"name": "provider", "port": port, "targetPort": "provider"}}}}
}

func statefulSet(namespace, name string, labels map[string]any, image string, port int, secretName, pvcName, reconcileToken string, secretData map[string]string, contract containerContract) map[string]any {
	dataMountPath := contract.DataMountPath
	if dataMountPath == "" {
		dataMountPath = "/data"
	}
	runAsUser := contract.RunAsUser
	if runAsUser <= 0 {
		runAsUser = 10001
	}
	volumes := []any{map[string]any{"name": "data", "persistentVolumeClaim": map[string]any{"claimName": pvcName}}}
	mounts := []any{map[string]any{"name": "data", "mountPath": dataMountPath}}
	if contract.AdditionalVolume != nil {
		volumes = append(volumes, contract.AdditionalVolume)
	}
	if contract.AdditionalMount != nil {
		mounts = append(mounts, contract.AdditionalMount)
	}
	ports := []any{map[string]any{"name": "provider", "containerPort": port}}
	ports = append(ports, contract.Ports...)
	environment := make([]any, 0, len(secretData)+len(contract.FixedEnvironment))
	keys := make([]string, 0, len(secretData))
	for key := range secretData {
		if validEnvironmentVariable(key) {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	for _, key := range keys {
		environment = append(environment, map[string]any{
			"name": key,
			"valueFrom": map[string]any{"secretKeyRef": map[string]any{
				"name": secretName,
				"key":  key,
			}},
		})
	}
	fixedKeys := make([]string, 0, len(contract.FixedEnvironment))
	for key := range contract.FixedEnvironment {
		fixedKeys = append(fixedKeys, key)
	}
	sort.Strings(fixedKeys)
	for _, key := range fixedKeys {
		environment = append(environment, map[string]any{"name": key, "value": contract.FixedEnvironment[key]})
	}
	readinessProbe := map[string]any{"tcpSocket": map[string]any{"port": "provider"}, "initialDelaySeconds": 5, "periodSeconds": 5, "timeoutSeconds": 2, "failureThreshold": 12}
	startupProbe := map[string]any{"tcpSocket": map[string]any{"port": "provider"}, "periodSeconds": 10, "timeoutSeconds": 5, "failureThreshold": 120}
	if len(contract.ProbeCommand) > 0 {
		readinessProbe = map[string]any{"exec": map[string]any{"command": contract.ProbeCommand}, "initialDelaySeconds": 5, "periodSeconds": 5, "timeoutSeconds": 5, "failureThreshold": 12}
		startupProbe = map[string]any{"exec": map[string]any{"command": contract.ProbeCommand}, "periodSeconds": 10, "timeoutSeconds": 5, "failureThreshold": 120}
	}
	container := map[string]any{
		"name": name, "image": image, "imagePullPolicy": "IfNotPresent", "ports": ports,
		"env":            environment,
		"resources":      map[string]any{"requests": map[string]any{"cpu": "100m", "memory": "128Mi", "ephemeral-storage": "256Mi"}, "limits": map[string]any{"cpu": "1", "memory": "1Gi", "ephemeral-storage": "1Gi"}},
		"startupProbe":   startupProbe,
		"readinessProbe": readinessProbe,
		"livenessProbe":  map[string]any{"tcpSocket": map[string]any{"port": "provider"}, "initialDelaySeconds": 30, "periodSeconds": 10, "timeoutSeconds": 2, "failureThreshold": 6},
		"securityContext": map[string]any{
			"allowPrivilegeEscalation": false,
			"runAsNonRoot":             true,
			"runAsUser":                runAsUser,
			"runAsGroup":               runAsUser,
			"capabilities":             map[string]any{"drop": []any{"ALL"}},
		},
		"volumeMounts": mounts,
	}
	if len(contract.Command) > 0 {
		container["command"] = contract.Command
	}
	if len(contract.Args) > 0 {
		container["args"] = contract.Args
	}
	return map[string]any{
		"apiVersion": "apps/v1", "kind": "StatefulSet", "metadata": map[string]any{"name": name, "namespace": namespace, "labels": labels},
		"spec": map[string]any{
			"serviceName": name, "replicas": 1, "selector": map[string]any{"matchLabels": map[string]any{"app.kubernetes.io/name": name}},
			"template": map[string]any{"metadata": map[string]any{"labels": labels, "annotations": map[string]any{"raibitserver.io/reconcile-token": reconcileToken, "raibitserver.io/verify-image-signatures": "required"}}, "spec": map[string]any{"automountServiceAccountToken": false, "securityContext": map[string]any{"runAsNonRoot": true, "runAsUser": runAsUser, "runAsGroup": runAsUser, "fsGroup": runAsUser, "seccompProfile": map[string]any{"type": "RuntimeDefault"}}, "containers": []any{container}, "volumes": volumes}},
		},
	}
}

func validEnvironmentVariable(value string) bool {
	if value == "" {
		return false
	}
	for index, character := range value {
		if (character >= 'A' && character <= 'Z') || character == '_' || (index > 0 && character >= '0' && character <= '9') {
			continue
		}
		return false
	}
	return true
}

func networkPolicy(namespace, name string, labels map[string]any, port int) map[string]any {
	return map[string]any{
		"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy", "metadata": map[string]any{"name": name + "-provider", "namespace": namespace, "labels": labels},
		"spec": map[string]any{"podSelector": map[string]any{"matchLabels": map[string]any{"app.kubernetes.io/name": name}}, "policyTypes": []any{"Ingress", "Egress"}, "ingress": []any{map[string]any{"from": []any{map[string]any{"namespaceSelector": map[string]any{"matchLabels": map[string]any{"kubernetes.io/metadata.name": namespace}}}}, "ports": []any{map[string]any{"protocol": "TCP", "port": port}}}}, "egress": []any{}},
	}
}

func supportedEngine(engine, configuredProvider string) (string, error) {
	normalizedEngine, err := normalizeEngine(engine)
	if err != nil {
		return "", err
	}
	if err := requireLocalCapability(normalizedEngine); err != nil {
		return "", err
	}
	providerName := strings.ToLower(strings.TrimSpace(configuredProvider))
	allowedProviders := map[string]bool{
		"":                                       true,
		"local":                                  true,
		"raibitserver":                           true,
		"managed-catalog":                        true,
		"shared-provider":                        true,
		"dedicated-local":                        true,
		"raibitserver-local-" + normalizedEngine: true,
	}
	if !allowedProviders[providerName] {
		return "", fmt.Errorf("provider %q is not served by the dedicated local reconciler", configuredProvider)
	}
	return normalizedEngine, nil
}

func normalizeEngine(engine string) (string, error) {
	var normalizedEngine string
	switch strings.ToLower(strings.TrimSpace(engine)) {
	case "postgres", "postgresql", "pg":
		normalizedEngine = "postgresql"
	case "mysql":
		normalizedEngine = "mysql"
	case "mariadb":
		normalizedEngine = "mariadb"
	case "mongo", "mongodb":
		normalizedEngine = "mongodb"
	case "redis":
		normalizedEngine = "redis"
	case "valkey":
		normalizedEngine = "valkey"
	case "object-storage", "s3", "minio":
		normalizedEngine = "object-storage"
	case "qdrant", "vector-db":
		normalizedEngine = "qdrant"
	case "nats", "message-queue":
		normalizedEngine = "nats"
	case "sqlite", "sqlite3":
		return "", fmt.Errorf("sqlite is not supported by the live managed-resource reconciler")
	default:
		return "", fmt.Errorf("unsupported live resource engine %q", engine)
	}
	return normalizedEngine, nil
}

func randomSecret(bytes int) (string, error) {
	value := make([]byte, bytes)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func storageSize(spec map[string]any) string {
	if value := intValue(spec, "storageGb"); value > 0 {
		if value > 1024 {
			value = 1024
		}
		return strconv.Itoa(value) + "Gi"
	}
	if value := intValue(spec, "storageMb"); value > 0 {
		if value > 1024*1024 {
			value = 1024 * 1024
		}
		return strconv.Itoa(value) + "Mi"
	}
	return "5Gi"
}

func stringValue(input map[string]any, key string) string {
	if value, ok := input[key].(string); ok {
		return value
	}
	return ""
}

func intValue(input map[string]any, key string) int {
	if value, ok := input[key].(float64); ok {
		return int(value)
	}
	if value, ok := input[key].(int); ok {
		return value
	}
	return 0
}

func identifier(value string) string {
	value = strings.ReplaceAll(slug(value), "-", "_")
	if value == "" || value == "item" {
		return "app"
	}
	if value[0] >= '0' && value[0] <= '9' {
		value = "app_" + value
	}
	if len(value) > 32 {
		value = value[:32]
	}
	return value
}

func boundedSlug(value string, max int) string {
	value = slug(value)
	if len(value) > max {
		value = strings.Trim(value[:max], "-")
	}
	return value
}

func tenantNamespace(resource *store.Resource) string {
	organization := normalizeDNSName(firstNonEmpty(resource.OrganizationID, "org"))
	project := normalizeDNSName(firstNonEmpty(resource.ProjectSlug, resource.ProjectID, "project"))
	identity := organization + "--" + project
	return boundedDNSName(identity, resource.OrganizationID+"\x00"+resource.ProjectID, 63)
}

func boundedDNSName(value, identity string, limit int) string {
	value = normalizeDNSName(value)
	if len(value) <= limit {
		return value
	}
	hash := sha256.Sum256([]byte(firstNonEmpty(identity, value)))
	suffix := fmt.Sprintf("%x", hash[:6])
	if limit <= len(suffix) {
		return suffix[:limit]
	}
	base := strings.TrimRight(value[:limit-len(suffix)-1], "-")
	if base == "" {
		return suffix[:limit]
	}
	return base + "-" + suffix
}

func normalizeDNSName(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = dnsNamePattern.ReplaceAllString(value, "-")
	value = strings.Trim(value, "-")
	if value == "" {
		return "item"
	}
	return value
}

func slug(value string) string {
	value = slugPattern.ReplaceAllString(strings.ToLower(strings.TrimSpace(value)), "-")
	value = strings.Trim(value, "-")
	if value == "" {
		return "item"
	}
	return value
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
