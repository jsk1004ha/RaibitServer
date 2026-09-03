package store

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

type recoveryImage struct {
	Schema             string `json:"schema"`
	Image              string `json:"image"`
	WorkloadUID        string `json:"workloadUid"`
	WorkloadGeneration int64  `json:"workloadGeneration"`
	ObservedAt         string `json:"observedAt,omitempty"`
}
type recoveryProvenance struct {
	ProviderImage    recoveryImage `json:"providerImageProvenance"`
	ProviderIdentity struct {
		Namespace string `json:"namespace"`
		Name      string `json:"name"`
	} `json:"providerIdentity"`
	CredentialUID        string `json:"credentialSecretUID"`
	CredentialGeneration string `json:"credentialSecretGeneration"`
}
type recoverySpec struct {
	Type        string                     `json:"type"`
	Plan        string                     `json:"plan"`
	Region      string                     `json:"region"`
	Version     *string                    `json:"version"`
	DesiredSpec map[string]json.RawMessage `json:"desiredSpec"`
}

var recoveryImagePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9./_:-]*@sha256:[0-9a-f]{64}$`)

func recoverySourceGeneration(r *Resource) (string, error) {
	state, err := json.Marshal(r.DesiredState)
	if err != nil {
		return "", ErrRecoverySource
	}
	var p recoveryProvenance
	if err = json.Unmarshal(state, &p); err != nil {
		return "", ErrRecoverySource
	}
	image := p.ProviderImage
	if image.Schema != "raibitserver.provider-image/v1" || !recoveryImagePattern.MatchString(image.Image) || strings.HasSuffix(image.Image, strings.Repeat("0", 64)) ||
		!kubernetesUIDPattern.MatchString(image.WorkloadUID) || image.WorkloadGeneration < 1 || image.WorkloadGeneration > 9007199254740991 {
		return "", ErrRecoverySource
	}
	if _, err = time.Parse(time.RFC3339Nano, image.ObservedAt); err != nil {
		return "", ErrRecoverySource
	}
	if !kubernetesDNSLabelPattern.MatchString(p.ProviderIdentity.Namespace) || !kubernetesDNSLabelPattern.MatchString(p.ProviderIdentity.Name) || len(p.ProviderIdentity.Name) > 52 ||
		!kubernetesUIDPattern.MatchString(p.CredentialUID) || !credentialGenerationPattern.MatchString(p.CredentialGeneration) || r.ConnectionSecretName != p.ProviderIdentity.Name+"-connection" {
		return "", ErrRecoverySource
	}
	p.ProviderImage.ObservedAt = ""
	spec := recoverySpec{Type: r.Type, Plan: r.Plan, Region: r.Region, DesiredSpec: make(map[string]json.RawMessage)}
	if r.Version != "" || r.VersionPresent {
		spec.Version = &r.Version
	}
	for _, key := range []string{"storageMb", "storageGb", "databaseName", "database", "username", "bucket", "collection", "topic"} {
		if value, exists := r.DesiredSpec[key]; exists {
			raw, e := json.Marshal(value)
			if e != nil {
				return "", ErrRecoverySource
			}
			spec.DesiredSpec[key] = raw
		}
	}
	raw, err := json.Marshal(struct {
		ResourceID       string             `json:"resourceId"`
		ProjectID        string             `json:"projectId"`
		Engine           string             `json:"engine"`
		Provider         string             `json:"provider"`
		SourceSpec       recoverySpec       `json:"sourceSpec"`
		SourceProvenance recoveryProvenance `json:"sourceProvenance"`
	}{r.ID, r.ProjectID, r.Engine, r.Provider, spec, p})
	if err != nil {
		return "", ErrRecoverySource
	}
	canonical, err := canonicalRecoveryJSON(raw)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("resource-incarnation/v1:sha256:%x", sha256.Sum256(canonical)), nil
}

// canonicalRecoveryJSON matches JSON.stringify number/string encoding and sorts object keys.
func canonicalRecoveryJSON(raw json.RawMessage) ([]byte, error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return nil, ErrRecoveryInput
	}
	switch raw[0] {
	case '{':
		var object map[string]json.RawMessage
		if json.Unmarshal(raw, &object) != nil {
			return nil, ErrRecoveryInput
		}
		keys := make([]string, 0, len(object))
		for k := range object {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool {
			return slices.Compare(utf16.Encode([]rune(keys[i])), utf16.Encode([]rune(keys[j]))) < 0
		})
		var out bytes.Buffer
		out.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				out.WriteByte(',')
			}
			key, e := recoveryJSONString(k)
			if e != nil {
				return nil, e
			}
			out.Write(key)
			out.WriteByte(':')
			v, e := canonicalRecoveryJSON(object[k])
			if e != nil {
				return nil, e
			}
			out.Write(v)
		}
		out.WriteByte('}')
		return out.Bytes(), nil
	case '[':
		var array []json.RawMessage
		if json.Unmarshal(raw, &array) != nil {
			return nil, ErrRecoveryInput
		}
		var out bytes.Buffer
		out.WriteByte('[')
		for i, v := range array {
			if i > 0 {
				out.WriteByte(',')
			}
			b, e := canonicalRecoveryJSON(v)
			if e != nil {
				return nil, e
			}
			out.Write(b)
		}
		out.WriteByte(']')
		return out.Bytes(), nil
	case '"':
		var value string
		if json.Unmarshal(raw, &value) != nil {
			return nil, ErrRecoveryInput
		}
		return recoveryJSONString(value)
	case 't', 'f', 'n':
		if !json.Valid(raw) {
			return nil, ErrRecoveryInput
		}
		return raw, nil
	default:
		n, err := strconv.ParseFloat(string(raw), 64)
		if err != nil {
			return nil, ErrRecoveryInput
		}
		if n == 0 {
			return []byte("0"), nil
		}
		format := byte('f')
		absolute := n
		if absolute < 0 {
			absolute = -absolute
		}
		if absolute < 1e-6 || absolute >= 1e21 {
			format = 'e'
		}
		encoded := strconv.FormatFloat(n, format, -1, 64)
		encoded = strings.ReplaceAll(strings.ReplaceAll(encoded, "e-0", "e-"), "e+0", "e+")
		return []byte(encoded), nil
	}
}

func recoveryJSONString(s string) ([]byte, error) {
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(s); err != nil {
		return nil, ErrRecoveryInput
	}
	encoded := strings.TrimSuffix(out.String(), "\n")
	encoded = strings.ReplaceAll(strings.ReplaceAll(encoded, `\u2028`, "\u2028"), `\u2029`, "\u2029")
	return []byte(encoded), nil
}
