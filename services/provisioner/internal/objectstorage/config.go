package objectstorage

import (
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
	"strings"
)

const (
	ProviderName         = "seaweedfs"
	Version              = "4.46"
	SourceCommit         = "d997fba1575583a89cf0cc50dc0150642286c86d"
	OCIIndexDigest       = "sha256:08d516132314207d10c8e37cbffc1f32b147d870169688734cc61c6231625b62"
	PinnedImage          = "chrislusf/seaweedfs@" + OCIIndexDigest
	ConfigSecretKey      = "seaweedfs-s3.json"
	ConfigMountPath      = "/etc/seaweedfs/s3.json"
	GatewayPodLabelKey   = "app.kubernetes.io/component"
	GatewayPodLabelValue = "object-storage-admission-gateway"
)

var (
	ErrConfig     = errors.New("invalid authenticated SeaweedFS package config")
	bucketPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$`)
	keyPattern    = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)
)

type Credentials struct {
	AccessKey string
	SecretKey string
}

type Config struct {
	Image              string
	Bucket             string
	SecretName         string
	GatewayNamespace   string
	TrustedTLSEndpoint string
	Admin              Credentials
	Tenant             Credentials
}

type Runtime struct {
	Image            string
	Port             int
	RunAsUser        int64
	Args             []string
	SecretData       map[string]string
	ConnectionKeys   []string
	ConfigSecretKey  string
	ConfigMountPath  string
	GatewayNamespace string
}

type identityConfig struct {
	Name        string             `json:"name"`
	Credentials []credentialConfig `json:"credentials"`
	Actions     []string           `json:"actions"`
}

type credentialConfig struct {
	AccessKey string `json:"accessKey"`
	SecretKey string `json:"secretKey"`
}

func Compile(config Config) (Runtime, error) {
	if config.Image != PinnedImage ||
		!bucketPattern.MatchString(config.Bucket) ||
		!validDNSLabel(config.SecretName) ||
		!validDNSLabel(config.GatewayNamespace) ||
		!validCredentials(config.Admin) ||
		!validCredentials(config.Tenant) ||
		config.Admin.AccessKey == config.Tenant.AccessKey ||
		config.Admin.SecretKey == config.Tenant.SecretKey ||
		!validTrustedEndpoint(config.TrustedTLSEndpoint) {
		return Runtime{}, ErrConfig
	}
	auth := struct {
		Identities []identityConfig `json:"identities"`
	}{
		Identities: []identityConfig{
			{
				Name:        "raibitserver-provider-admin",
				Credentials: []credentialConfig{{AccessKey: config.Admin.AccessKey, SecretKey: config.Admin.SecretKey}},
				Actions:     []string{"Admin", "Read", "Write", "List", "Tagging"},
			},
			{
				Name:        "raibitserver-tenant-" + config.Bucket,
				Credentials: []credentialConfig{{AccessKey: config.Tenant.AccessKey, SecretKey: config.Tenant.SecretKey}},
				Actions: []string{
					"Read:" + config.Bucket,
					"Write:" + config.Bucket,
					"List:" + config.Bucket,
					"Tagging:" + config.Bucket,
				},
			},
		},
	}
	authJSON, err := json.Marshal(auth)
	if err != nil {
		return Runtime{}, ErrConfig
	}
	return Runtime{
		Image: PinnedImage, Port: 8333, RunAsUser: 1000,
		Args: []string{"server", "-dir=/data", "-s3", "-s3.port=8333", "-s3.config=" + ConfigMountPath, "-filer"},
		SecretData: map[string]string{
			"S3_ENDPOINT": config.TrustedTLSEndpoint, "S3_BUCKET": config.Bucket, "S3_REGION": "local",
			"S3_ACCESS_KEY": config.Tenant.AccessKey, "S3_SECRET_KEY": config.Tenant.SecretKey,
			"admin.access-key": config.Admin.AccessKey, "admin.secret-key": config.Admin.SecretKey,
			"tenant.access-key": config.Tenant.AccessKey, "tenant.secret-key": config.Tenant.SecretKey,
			"gateway.namespace": config.GatewayNamespace,
			ConfigSecretKey:     string(authJSON),
		},
		ConnectionKeys:   []string{"S3_ENDPOINT", "S3_BUCKET", "S3_REGION", "S3_ACCESS_KEY", "S3_SECRET_KEY"},
		ConfigSecretKey:  ConfigSecretKey,
		ConfigMountPath:  ConfigMountPath,
		GatewayNamespace: config.GatewayNamespace,
	}, nil
}

func validCredentials(credentials Credentials) bool {
	if !keyPattern.MatchString(credentials.AccessKey) ||
		len(credentials.SecretKey) < 24 ||
		len(credentials.SecretKey) > 256 ||
		strings.TrimSpace(credentials.SecretKey) != credentials.SecretKey {
		return false
	}
	for _, character := range credentials.SecretKey {
		if character < 0x21 || character > 0x7e {
			return false
		}
	}
	return true
}

func validTrustedEndpoint(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Port() != "" ||
		parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	host := parsed.Hostname()
	return parsed.Host == host &&
		strings.HasPrefix(host, "resources--") &&
		strings.HasSuffix(host, ".raibitserver.app") &&
		strings.Count(host, ".") == 2
}

func validDNSLabel(value string) bool {
	return len(value) > 0 && len(value) <= 63 && bucketPattern.MatchString(value)
}
