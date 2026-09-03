package reconciler

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// The child test executable is the controlled kubectl process for the CLI proof.
func init() {
	if filepath.Base(os.Args[0]) != "kubectl" || os.Getenv("RAIBITSERVER_PROVENANCE_FIXTURE_DIR") == "" {
		return
	}
	if err := provenanceKubectl(); err != nil {
		fmt.Fprintln(os.Stderr, "controlled kubectl fixture:", err)
		os.Exit(1)
	}
	os.Exit(0)
}

func provenanceKubectl() error {
	directory := os.Getenv("RAIBITSERVER_PROVENANCE_FIXTURE_DIR")
	args := os.Args[1:]
	call := strings.Join(args, " ")
	log, err := os.OpenFile(filepath.Join(directory, "kubectl.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintln(log, call); err != nil {
		return err
	}
	if err := log.Close(); err != nil {
		return err
	}
	if len(args) < 1 {
		return fmt.Errorf("missing command")
	}
	switch args[0] {
	case "create":
		var secret struct {
			Metadata map[string]any `json:"metadata"`
		}
		if err := json.NewDecoder(io.LimitReader(os.Stdin, 1<<20)).Decode(&secret); err != nil {
			return err
		}
		secret.Metadata["uid"] = testCredentialSecretUID
		payload, err := json.Marshal(map[string]any{"apiVersion": "meta.k8s.io/v1", "kind": "PartialObjectMetadata", "metadata": secret.Metadata})
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(directory, "secret-metadata.json"), payload, 0o600); err != nil {
			return err
		}
		_, err = fmt.Print(testCredentialSecretUID)
		return err
	case "apply":
		if len(args) < 4 {
			return fmt.Errorf("missing manifest")
		}
		if args[3] == "-" {
			_, err := io.Copy(io.Discard, io.LimitReader(os.Stdin, 1<<20))
			return err
		}
		payload, err := os.ReadFile(args[3])
		if err != nil {
			return err
		}
		var list struct {
			Items []map[string]any `json:"items"`
		}
		if err := json.Unmarshal(payload, &list); err != nil {
			return err
		}
		for _, item := range list.Items {
			if item["kind"] != "StatefulSet" {
				continue
			}
			item["metadata"].(map[string]any)["uid"] = provenanceUID
			item["metadata"].(map[string]any)["generation"] = 7
			item["status"] = map[string]any{"observedGeneration": 7, "replicas": 1, "readyReplicas": 1, "updatedReplicas": 1, "currentRevision": "rev-7", "updateRevision": "rev-7"}
			workload, err := json.Marshal(item)
			if err != nil {
				return err
			}
			if err := os.WriteFile(filepath.Join(directory, "applied-workload.json"), workload, 0o600); err != nil {
				return err
			}
		}
		return json.NewEncoder(os.Stdout).Encode(map[string]any{"apiVersion": "v1", "kind": "List", "items": list.Items})
	case "get":
		if strings.Contains(call, "service/") {
			if _, err := os.Stat(filepath.Join(directory, "fail-health")); err == nil {
				return fmt.Errorf("service unavailable")
			}
			return nil
		}
		if strings.Contains(call, "statefulset/") && strings.Contains(call, "--output=json") {
			payload, err := os.ReadFile(filepath.Join(directory, "applied-workload.json"))
			if err != nil {
				return err
			}
			_, err = os.Stdout.Write(payload)
			return err
		}
		return nil
	default:
		return fmt.Errorf("unexpected command")
	}
}
