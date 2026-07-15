package command

import (
	"context"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRunInputDoesNotEchoSecretBearingProcessOutput(t *testing.T) {
	t.Setenv("RAIBITSERVER_COMMAND_HELPER", "1")
	secret := "provider-secret-must-not-escape"
	t.Setenv("RAIBITSERVER_COMMAND_HELPER_SECRET", secret)
	_, err := run(
		context.Background(),
		os.Args[0],
		[]string{"-test.run=TestCommandFailureHelper", "--"},
		[]byte(secret),
		false,
		time.Minute,
	)
	if err == nil {
		t.Fatal("expected helper command failure")
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("secret-bearing stdin command output leaked through error: %v", err)
	}
}

func TestSensitiveOutputIsReturnedOnlyOnSuccessAndRedactedOnFailure(t *testing.T) {
	t.Setenv("RAIBITSERVER_COMMAND_HELPER", "1")
	secret := "provider-secret-output-must-not-escape"
	t.Setenv("RAIBITSERVER_COMMAND_HELPER_SECRET", secret)

	_, output, err := runSensitiveOutput(
		context.Background(),
		os.Args[0],
		[]string{"-test.run=TestCommandSuccessHelper", "--"},
		time.Minute,
	)
	if err != nil || !strings.Contains(string(output), secret) {
		t.Fatalf("sensitive output must be available to the in-process parser on success: output=%q err=%v", output, err)
	}

	_, output, err = runSensitiveOutput(
		context.Background(),
		os.Args[0],
		[]string{"-test.run=TestCommandFailureHelper", "--"},
		time.Minute,
	)
	if err == nil || len(output) != 0 || strings.Contains(err.Error(), secret) {
		t.Fatalf("failed sensitive output must be withheld: output=%q err=%v", output, err)
	}
}

func TestCreateInputClassifiesAlreadyExistsWithoutExposingPayload(t *testing.T) {
	t.Setenv("RAIBITSERVER_COMMAND_HELPER", "1")
	secret := "provider-create-payload-must-not-escape"
	t.Setenv("RAIBITSERVER_COMMAND_HELPER_SECRET", secret)
	_, err := runCreateInput(
		context.Background(),
		os.Args[0],
		[]string{"-test.run=TestAlreadyExistsHelper", "--"},
		[]byte(secret),
		time.Minute,
	)
	if !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("expected classified AlreadyExists, got %v", err)
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("create payload leaked through classified error: %v", err)
	}
}

func TestCreateInputUIDReturnsOnlyAValidatedObjectIdentity(t *testing.T) {
	t.Setenv("RAIBITSERVER_COMMAND_HELPER", "1")
	uid := "5c0c1aa2-e18f-43be-9dc7-3dfbf158cd21"
	t.Setenv("RAIBITSERVER_COMMAND_HELPER_UID", uid)
	t.Setenv("RAIBITSERVER_COMMAND_HELPER_SECRET", "provider-create-output-must-not-escape")

	commandLine, actualUID, err := runCreateInputUID(
		context.Background(),
		os.Args[0],
		[]string{"-test.run=TestCreateUIDHelper", "--"},
		[]byte("sensitive-secret-manifest"),
		time.Minute,
	)
	if err != nil || actualUID != uid {
		t.Fatalf("create must return only the server-assigned UID: command=%q uid=%q err=%v", commandLine, actualUID, err)
	}

	t.Setenv("RAIBITSERVER_COMMAND_HELPER_UID", "invalid uid provider-create-output-must-not-escape")
	_, actualUID, err = runCreateInputUID(
		context.Background(),
		os.Args[0],
		[]string{"-test.run=TestCreateUIDHelper", "--"},
		[]byte("sensitive-secret-manifest"),
		time.Minute,
	)
	if err == nil || actualUID != "" || strings.Contains(err.Error(), "provider-create-output-must-not-escape") {
		t.Fatalf("invalid create output must fail closed without disclosure: uid=%q err=%v", actualUID, err)
	}
}

func TestSecretUIDVerificationAndDeletionUsePreconditionsWithoutReadingSecretData(t *testing.T) {
	tokenPath := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenPath, []byte("service-account-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	type requestRecord struct {
		Authorization string
		Path          string
		DryRun        []string
		UID           string
		Propagation   string
	}
	records := make([]requestRecord, 0, 2)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		var options struct {
			DryRun            []string `json:"dryRun"`
			PropagationPolicy string   `json:"propagationPolicy"`
			Preconditions     struct {
				UID string `json:"uid"`
			} `json:"preconditions"`
		}
		if err := json.NewDecoder(request.Body).Decode(&options); err != nil {
			t.Errorf("decode DeleteOptions: %v", err)
		}
		records = append(records, requestRecord{
			Authorization: request.Header.Get("Authorization"),
			Path:          request.URL.Path,
			DryRun:        options.DryRun,
			UID:           options.Preconditions.UID,
			Propagation:   options.PropagationPolicy,
		})
		response.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(response, `{"kind":"Secret","data":{"password":"must-never-be-returned"}}`)
	}))
	defer server.Close()

	runner := OSRunner{KubernetesAPIURL: server.URL, ServiceAccountTokenFile: tokenPath, HTTPClient: server.Client()}
	uid := "5c0c1aa2-e18f-43be-9dc7-3dfbf158cd21"
	if _, err := runner.VerifySecretUID(context.Background(), "tenant-one", "postgres-connection", uid, time.Minute); err != nil {
		t.Fatal(err)
	}
	if _, err := runner.DeleteSecretUID(context.Background(), "tenant-one", "postgres-connection", uid, time.Minute); err != nil {
		t.Fatal(err)
	}
	if _, err := runner.DeleteObjectUID(context.Background(), "statefulset", "tenant-one", "postgres", uid, time.Minute); err != nil {
		t.Fatal(err)
	}
	if len(records) != 3 {
		t.Fatalf("expected verification and deletion requests, got %#v", records)
	}
	for _, record := range records[:2] {
		if record.Authorization != "Bearer service-account-token" || record.Path != "/api/v1/namespaces/tenant-one/secrets/postgres-connection" || record.UID != uid {
			t.Fatalf("UID-fenced Secret request was malformed: %#v", record)
		}
	}
	if records[2].Authorization != "Bearer service-account-token" || records[2].Path != "/apis/apps/v1/namespaces/tenant-one/statefulsets/postgres" || records[2].UID != uid {
		t.Fatalf("UID-fenced StatefulSet request was malformed: %#v", records[2])
	}
	if len(records[0].DryRun) != 1 || records[0].DryRun[0] != "All" || len(records[1].DryRun) != 0 {
		t.Fatalf("verification must be dry-run while deletion must be live: %#v", records)
	}
	if records[0].Propagation != "Background" || records[1].Propagation != "Background" || records[2].Propagation != "Foreground" {
		t.Fatalf("Secret deletion must avoid an admission-deadlocked foreground GC finalizer while workload deletion stays foreground: %#v", records)
	}
}

func TestSecretMetadataLookupUsesNoOpDryRunPatchAndRequestsOnlyPartialObjectMetadata(t *testing.T) {
	tokenPath := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenPath, []byte("service-account-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var accept, authorization, contentType, method, path string
	var dryRun []string
	var patch []any
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		accept = request.Header.Get("Accept")
		authorization = request.Header.Get("Authorization")
		contentType = request.Header.Get("Content-Type")
		method = request.Method
		path = request.URL.Path
		dryRun = request.URL.Query()["dryRun"]
		if err := json.NewDecoder(request.Body).Decode(&patch); err != nil {
			t.Errorf("decode metadata inspection patch: %v", err)
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(response, `{"apiVersion":"meta.k8s.io/v1","kind":"PartialObjectMetadata","metadata":{"uid":"5c0c1aa2-e18f-43be-9dc7-3dfbf158cd21","name":"postgres-connection","namespace":"tenant-one","labels":{"raibitserver.io/managed":"true"},"annotations":{"raibitserver.io/credential-generation":"generation"}}}`)
	}))
	defer server.Close()
	runner := OSRunner{KubernetesAPIURL: server.URL, ServiceAccountTokenFile: tokenPath, HTTPClient: server.Client()}
	commandLine, metadata, err := runner.GetSecretMetadata(context.Background(), "tenant-one", "postgres-connection", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if metadata == nil || metadata.UID != "5c0c1aa2-e18f-43be-9dc7-3dfbf158cd21" || metadata.Labels["raibitserver.io/managed"] != "true" {
		t.Fatalf("metadata-only identity was not decoded: command=%q metadata=%#v", commandLine, metadata)
	}
	if method != http.MethodPatch || path != "/api/v1/namespaces/tenant-one/secrets/postgres-connection" || authorization != "Bearer service-account-token" {
		t.Fatalf("metadata request was malformed: method=%q path=%q auth=%q", method, path, authorization)
	}
	if contentType != "application/json-patch+json" || len(dryRun) != 1 || dryRun[0] != "All" || len(patch) != 0 {
		t.Fatalf("metadata inspection must be an empty dry-run JSON patch: content-type=%q dryRun=%#v patch=%#v", contentType, dryRun, patch)
	}
	if accept != "application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=v1" {
		t.Fatalf("Secret lookup must negotiate the metadata-only representation, got %q", accept)
	}
}

func TestSecretMetadataLookupRejectsFullSecretRepresentations(t *testing.T) {
	tokenPath := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenPath, []byte("service-account-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		_, _ = fmt.Fprint(response, `{"apiVersion":"v1","kind":"Secret","metadata":{"uid":"5c0c1aa2-e18f-43be-9dc7-3dfbf158cd21","name":"postgres-connection","namespace":"tenant-one"},"data":{"password":"must-never-be-trusted"}}`)
	}))
	defer server.Close()
	runner := OSRunner{KubernetesAPIURL: server.URL, ServiceAccountTokenFile: tokenPath, HTTPClient: server.Client()}
	_, metadata, err := runner.GetSecretMetadata(context.Background(), "tenant-one", "postgres-connection", time.Minute)
	if err == nil || metadata != nil || !strings.Contains(err.Error(), "metadata-only") || strings.Contains(err.Error(), "must-never-be-trusted") {
		t.Fatalf("a full Secret response must fail closed without exposing its data: metadata=%#v err=%v", metadata, err)
	}
}

func TestSecretMetadataLookupRejectsPartialMetadataResponsesContainingSecretData(t *testing.T) {
	tokenPath := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenPath, []byte("service-account-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		_, _ = fmt.Fprint(response, `{"apiVersion":"meta.k8s.io/v1","kind":"PartialObjectMetadata","metadata":{"uid":"5c0c1aa2-e18f-43be-9dc7-3dfbf158cd21","name":"postgres-connection","namespace":"tenant-one"},"data":{"password":"partial-response-secret-must-not-escape"}}`)
	}))
	defer server.Close()
	runner := OSRunner{KubernetesAPIURL: server.URL, ServiceAccountTokenFile: tokenPath, HTTPClient: server.Client()}

	_, metadata, err := runner.GetSecretMetadata(context.Background(), "tenant-one", "postgres-connection", time.Minute)
	if err == nil || metadata != nil || strings.Contains(err.Error(), "partial-response-secret-must-not-escape") {
		t.Fatalf("a metadata response containing Secret data must fail closed without disclosure: metadata=%#v err=%v", metadata, err)
	}
}

func TestSecretMetadataLookupRejectsContentBeyondTheResponseLimit(t *testing.T) {
	tokenPath := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenPath, []byte("service-account-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	metadata := `{"apiVersion":"meta.k8s.io/v1","kind":"PartialObjectMetadata","metadata":{"uid":"5c0c1aa2-e18f-43be-9dc7-3dfbf158cd21","name":"postgres-connection","namespace":"tenant-one"}}`
	padding := strings.Repeat(" ", (64<<10)-len(metadata))
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		_, _ = fmt.Fprint(response, metadata+padding+`{"data":{"password":"oversized-response-secret-must-not-escape"}}`)
	}))
	defer server.Close()
	runner := OSRunner{KubernetesAPIURL: server.URL, ServiceAccountTokenFile: tokenPath, HTTPClient: server.Client()}

	_, observed, err := runner.GetSecretMetadata(context.Background(), "tenant-one", "postgres-connection", time.Minute)
	if err == nil || observed != nil || strings.Contains(err.Error(), "oversized-response-secret-must-not-escape") {
		t.Fatalf("an oversized metadata response must fail closed without disclosure: metadata=%#v err=%v", observed, err)
	}
}

func TestSecretUIDRequestErrorsNeverExposeAPIResponseBodies(t *testing.T) {
	tokenPath := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenPath, []byte("service-account-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusConflict)
		_, _ = fmt.Fprint(response, `{"data":{"password":"api-response-secret-must-not-escape"}}`)
	}))
	defer server.Close()
	runner := OSRunner{KubernetesAPIURL: server.URL, ServiceAccountTokenFile: tokenPath, HTTPClient: server.Client()}

	_, err := runner.VerifySecretUID(context.Background(), "tenant-one", "postgres-connection", "5c0c1aa2-e18f-43be-9dc7-3dfbf158cd21", time.Minute)
	if err == nil || !errors.Is(err, ErrSecretUIDMismatch) || strings.Contains(err.Error(), "api-response-secret-must-not-escape") {
		t.Fatalf("API response body must be withheld on UID mismatch: %v", err)
	}
}

func TestSecretUIDVerificationClassifiesMissingObjectsAndRejectsRemotePlainHTTP(t *testing.T) {
	tokenPath := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenPath, []byte("service-account-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()
	runner := OSRunner{KubernetesAPIURL: server.URL, ServiceAccountTokenFile: tokenPath, HTTPClient: server.Client()}
	_, err := runner.VerifySecretUID(context.Background(), "tenant-one", "postgres-connection", "5c0c1aa2-e18f-43be-9dc7-3dfbf158cd21", time.Minute)
	if !errors.Is(err, ErrSecretNotFound) {
		t.Fatalf("missing Secret must be classified for safe reconciliation: %v", err)
	}

	runner.KubernetesAPIURL = "http://api.example.invalid"
	_, err = runner.VerifySecretUID(context.Background(), "tenant-one", "postgres-connection", "5c0c1aa2-e18f-43be-9dc7-3dfbf158cd21", time.Minute)
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "https") {
		t.Fatalf("non-loopback Kubernetes API URLs must require TLS: %v", err)
	}
}

func TestDefaultKubernetesHTTPClientReusesItsBoundedTLSTransport(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(response, `{}`)
	}))
	defer server.Close()
	directory := t.TempDir()
	tokenPath := filepath.Join(directory, "token")
	caPath := filepath.Join(directory, "ca.crt")
	if err := os.WriteFile(tokenPath, []byte("service-account-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	certificate := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw})
	if err := os.WriteFile(caPath, certificate, 0o600); err != nil {
		t.Fatal(err)
	}
	runner := OSRunner{KubernetesAPIURL: server.URL, ServiceAccountTokenFile: tokenPath, ServiceAccountCAFile: caPath}
	first, err := runner.kubernetesHTTPClient()
	if err != nil {
		t.Fatal(err)
	}
	second, err := runner.kubernetesHTTPClient()
	if err != nil || first != second {
		t.Fatalf("default Kubernetes client and its TLS transport must be reused: first=%p second=%p err=%v", first, second, err)
	}
	for range 2 {
		if _, err := runner.VerifySecretUID(context.Background(), "tenant-one", "postgres-connection", "5c0c1aa2-e18f-43be-9dc7-3dfbf158cd21", time.Minute); err != nil {
			t.Fatal(err)
		}
	}
}

func TestCommandFailureHelper(t *testing.T) {
	if os.Getenv("RAIBITSERVER_COMMAND_HELPER") != "1" {
		return
	}
	secret := os.Getenv("RAIBITSERVER_COMMAND_HELPER_SECRET")
	_, _ = fmt.Fprintln(os.Stderr, secret)
	os.Exit(1)
}

func TestCommandSuccessHelper(t *testing.T) {
	if os.Getenv("RAIBITSERVER_COMMAND_HELPER") != "1" {
		return
	}
	_, _ = fmt.Fprintln(os.Stdout, os.Getenv("RAIBITSERVER_COMMAND_HELPER_SECRET"))
}

func TestAlreadyExistsHelper(t *testing.T) {
	if os.Getenv("RAIBITSERVER_COMMAND_HELPER") != "1" {
		return
	}
	_, _ = fmt.Fprintln(os.Stderr, "Error from server (AlreadyExists): secrets provider already exists")
	_, _ = fmt.Fprintln(os.Stderr, os.Getenv("RAIBITSERVER_COMMAND_HELPER_SECRET"))
	os.Exit(1)
}

func TestCreateUIDHelper(t *testing.T) {
	if os.Getenv("RAIBITSERVER_COMMAND_HELPER") != "1" {
		return
	}
	_, _ = fmt.Fprintln(os.Stdout, os.Getenv("RAIBITSERVER_COMMAND_HELPER_UID"))
	_, _ = fmt.Fprintln(os.Stderr, os.Getenv("RAIBITSERVER_COMMAND_HELPER_SECRET"))
	os.Exit(0)
}
