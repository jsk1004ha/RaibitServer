package backup

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/url"
	"strings"
)

const (
	MaxBundleBytes = 64 << 10
	ConfigFile     = "/var/run/secrets/raibitserver/backup/config.json"
)

// Bundle keeps credentials and raw key material private, including when formatted.
type Bundle struct {
	access  string
	secret  string
	token   string
	current string
	keys    map[string][32]byte
}

func (Bundle) String() string              { return "[backup secret bundle]" }
func (Bundle) GoString() string            { return "[backup secret bundle]" }
func (b Bundle) CurrentKeyVersion() string { return b.current }

func ParseBundle(r io.Reader) (Bundle, error) {
	data, err := io.ReadAll(io.LimitReader(r, MaxBundleBytes+1))
	if err != nil || len(data) > MaxBundleBytes {
		return Bundle{}, ErrConfig
	}
	fields, err := objectFields(data)
	if err != nil {
		return Bundle{}, ErrConfig
	}
	for name := range fields {
		switch name {
		case "version", "accessKeyId", "secretAccessKey", "sessionToken", "currentKeyVersion", "keys":
		default:
			return Bundle{}, ErrConfig
		}
	}
	var version int
	var b Bundle
	if json.Unmarshal(fields["version"], &version) != nil || version != 1 {
		return Bundle{}, ErrConfig
	}
	for name, target := range map[string]*string{"accessKeyId": &b.access, "secretAccessKey": &b.secret, "currentKeyVersion": &b.current} {
		if json.Unmarshal(fields[name], target) != nil || !boundedSecret(*target, 1024) {
			return Bundle{}, ErrConfig
		}
	}
	if token, exists := fields["sessionToken"]; exists {
		if json.Unmarshal(token, &b.token) != nil || !boundedSecret(b.token, 8192) {
			return Bundle{}, ErrConfig
		}
	}
	keyFields, err := objectFields(fields["keys"])
	if err != nil || len(keyFields) == 0 || len(keyFields) > 32 {
		return Bundle{}, ErrConfig
	}
	b.keys = make(map[string][32]byte, len(keyFields))
	seen := make(map[[32]byte]bool)
	for version, raw := range keyFields {
		var encoded string
		if !segmentID.MatchString(version) || json.Unmarshal(raw, &encoded) != nil {
			return Bundle{}, ErrConfig
		}
		decoded, err := base64.StdEncoding.Strict().DecodeString(encoded)
		if err != nil || len(decoded) != 32 || base64.StdEncoding.EncodeToString(decoded) != encoded {
			return Bundle{}, ErrConfig
		}
		key := [32]byte(decoded)
		if seen[key] {
			return Bundle{}, ErrConfig
		}
		seen[key] = true
		b.keys[version] = key
	}
	if _, ok := b.keys[b.current]; !ok {
		return Bundle{}, ErrConfig
	}
	return b, nil
}

func boundedSecret(s string, max int) bool {
	return len(s) > 0 && len(s) <= max && strings.TrimSpace(s) == s && !strings.ContainsAny(s, "\r\n\x00")
}

// objectFields rejects duplicate names (including escaped equivalents), non-object
// input and trailing JSON. Each caller also applies its exact field allow-list.
func objectFields(data []byte) (map[string]json.RawMessage, error) {
	d := json.NewDecoder(bytes.NewReader(data))
	start, err := d.Token()
	if err != nil || start != json.Delim('{') {
		return nil, ErrConfig
	}
	fields := make(map[string]json.RawMessage)
	for d.More() {
		token, err := d.Token()
		if err != nil {
			return nil, ErrConfig
		}
		name, ok := token.(string)
		if !ok {
			return nil, ErrConfig
		}
		if _, exists := fields[name]; exists {
			return nil, ErrConfig
		}
		var raw json.RawMessage
		if d.Decode(&raw) != nil {
			return nil, ErrConfig
		}
		fields[name] = raw
	}
	if _, err := d.Token(); err != nil {
		return nil, ErrConfig
	}
	if _, err := d.Token(); err != io.EOF {
		return nil, ErrConfig
	}
	return fields, nil
}

type OperatorConfig struct {
	enabled  bool
	endpoint string
	bucket   string
	file     string
}

func (OperatorConfig) String() string       { return "[backup operator config]" }
func (OperatorConfig) GoString() string     { return "[backup operator config]" }
func (c OperatorConfig) Enabled() bool      { return c.enabled }
func (c OperatorConfig) BundleFile() string { return c.file }

func ParseOperator(env map[string]string) (OperatorConfig, error) {
	const prefix = "RAIBITSERVER_PROVISIONER_BACKUP_"
	switch env[prefix+"ENABLED"] {
	case "", "false":
		return OperatorConfig{}, nil
	case "true":
	default:
		return OperatorConfig{}, ErrConfig
	}
	u, err := url.Parse(env[prefix+"ENDPOINT"])
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return OperatorConfig{}, ErrConfig
	}
	bucket := env[prefix+"BUCKET"]
	if len(bucket) < 3 || len(bucket) > 63 || strings.ContainsAny(bucket, "/\\: \r\n") || bucket != strings.ToLower(bucket) {
		return OperatorConfig{}, ErrConfig
	}
	for _, c := range bucket {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '.') {
			return OperatorConfig{}, ErrConfig
		}
	}
	if env[prefix+"CONFIG_FILE"] != ConfigFile {
		return OperatorConfig{}, ErrConfig
	}
	return OperatorConfig{enabled: true, endpoint: strings.TrimSuffix(u.String(), "/"), bucket: bucket, file: ConfigFile}, nil
}
