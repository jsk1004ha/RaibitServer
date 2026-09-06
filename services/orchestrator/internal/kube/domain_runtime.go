package kube

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/raibitserver/orchestrator/internal/command"
)

type DomainObservation struct {
	CertificateReady bool
	IngressReady     bool
}

type DomainAbsence struct {
	CertificateAbsent bool
	IngressAbsent     bool
}

type DomainKubernetes interface {
	Apply(context.Context, DomainPlan) error
	Observe(context.Context, DomainPlan) (DomainObservation, error)
	Delete(context.Context, DomainPlan) (DomainAbsence, error)
}

type KubectlDomainKubernetes struct {
	runner     command.Runner
	outputDir  string
	kubeconfig string
	context    string
	timeout    time.Duration
	dryRun     bool
}

type KubectlDomainOptions struct {
	OutputDir, Kubeconfig, Context string
	Timeout                        time.Duration
	DryRun                         bool
}

func NewKubectlDomainKubernetes(runner command.Runner, options KubectlDomainOptions) *KubectlDomainKubernetes {
	if runner == nil { runner = command.OSRunner{} }
	return &KubectlDomainKubernetes{runner: runner, outputDir: options.OutputDir, kubeconfig: options.Kubeconfig, context: options.Context, timeout: options.Timeout, dryRun: options.DryRun}
}

func (k *KubectlDomainKubernetes) Apply(ctx context.Context, plan DomainPlan) error {
	if err := os.MkdirAll(k.outputDir, 0o755); err != nil { return fmt.Errorf("create domain manifest directory: %w", err) }
	path := filepath.Join(k.outputDir, plan.Name+"-apply.json")
	payload, err := ListJSON(plan.Manifests)
	if err != nil { return fmt.Errorf("encode domain manifests: %w", err) }
	if err := os.WriteFile(path, append(payload, '\n'), 0o600); err != nil { return fmt.Errorf("write domain manifests: %w", err) }
	_, err = k.run(ctx, []string{"apply", "--server-side", "-f", path})
	return err
}

func (k *KubectlDomainKubernetes) Observe(ctx context.Context, plan DomainPlan) (DomainObservation, error) {
	certificate, err := k.get(ctx, "certificate", plan)
	if err != nil { return DomainObservation{}, err }
	ingress, err := k.get(ctx, "ingress", plan)
	if err != nil { return DomainObservation{}, err }
	return DomainObservation{CertificateReady: certificateReady(certificate, plan), IngressReady: ingressReady(ingress, plan)}, nil
}

func (k *KubectlDomainKubernetes) Delete(ctx context.Context, plan DomainPlan) (DomainAbsence, error) {
	selector := "raibitserver.io/custom-domain=true,raibitserver.io/domain-id=" + plan.DomainID
	if _, err := k.run(ctx, []string{"delete", "certificate,ingress", "--namespace", plan.Namespace, "--selector", selector, "--ignore-not-found=true", "--wait=true"}); err != nil {
		return DomainAbsence{}, err
	}
	if k.dryRun {
		return DomainAbsence{}, nil
	}
	certificate, err := k.get(ctx, "certificate", plan)
	if err != nil { return DomainAbsence{}, err }
	ingress, err := k.get(ctx, "ingress", plan)
	if err != nil { return DomainAbsence{}, err }
	return DomainAbsence{CertificateAbsent: len(certificate) == 0, IngressAbsent: len(ingress) == 0}, nil
}

func (k *KubectlDomainKubernetes) get(ctx context.Context, kind string, plan DomainPlan) ([]byte, error) {
	result, err := k.run(ctx, []string{"get", kind + "/" + plan.Name, "--namespace", plan.Namespace, "--ignore-not-found=true", "--output=json"})
	if err != nil { return nil, err }
	return []byte(strings.TrimSpace(result.Stdout)), nil
}

func (k *KubectlDomainKubernetes) run(ctx context.Context, args []string) (command.Result, error) {
	if k.kubeconfig != "" { args = append(args, "--kubeconfig", k.kubeconfig) }
	if k.context != "" { args = append(args, "--context", k.context) }
	return k.runner.Run(ctx, command.Command{Name: "kubectl", Args: args}, k.dryRun, k.timeout)
}

type observedDomainObject struct {
	Metadata struct {
		Labels map[string]string `json:"labels"`
	} `json:"metadata"`
	Spec struct {
		DNSNames []string `json:"dnsNames"`
		SecretName string `json:"secretName"`
		IssuerRef struct {
			Name  string `json:"name"`
			Kind  string `json:"kind"`
			Group string `json:"group"`
		} `json:"issuerRef"`
		TLS []struct {
			Hosts []string `json:"hosts"`
			SecretName string `json:"secretName"`
		} `json:"tls"`
		Rules []struct {
			Host string `json:"host"`
			HTTP struct {
				Paths []struct {
					Backend struct {
						Service struct {
							Name string `json:"name"`
							Port struct { Number int `json:"number"` } `json:"port"`
						} `json:"service"`
					} `json:"backend"`
				} `json:"paths"`
			} `json:"http"`
		} `json:"rules"`
	} `json:"spec"`
	Status struct {
		Conditions []struct {
			Type   string `json:"type"`
			Status string `json:"status"`
		} `json:"conditions"`
	} `json:"status"`
}

func certificateReady(raw []byte, plan DomainPlan) bool {
	var object observedDomainObject
	if len(raw) == 0 || json.Unmarshal(raw, &object) != nil || !observedLabelsMatch(object.Metadata.Labels, plan) || len(object.Spec.DNSNames) != 1 || object.Spec.DNSNames[0] != domainHostname(plan) || object.Spec.SecretName != plan.Name+"-tls" || object.Spec.IssuerRef.Name != domainIssuer(plan) || object.Spec.IssuerRef.Kind != "ClusterIssuer" || object.Spec.IssuerRef.Group != "cert-manager.io" { return false }
	for _, condition := range object.Status.Conditions { if condition.Type == "Ready" && condition.Status == "True" { return true } }
	return false
}

func ingressReady(raw []byte, plan DomainPlan) bool {
	var object observedDomainObject
	if len(raw) == 0 || json.Unmarshal(raw, &object) != nil || !observedLabelsMatch(object.Metadata.Labels, plan) || len(object.Spec.Rules) != 1 || len(object.Spec.Rules[0].HTTP.Paths) != 1 || len(object.Spec.TLS) != 1 || len(object.Spec.TLS[0].Hosts) != 1 || object.Spec.TLS[0].Hosts[0] != domainHostname(plan) || object.Spec.TLS[0].SecretName != plan.Name+"-tls" { return false }
	backend := object.Spec.Rules[0].HTTP.Paths[0].Backend.Service
	return object.Spec.Rules[0].Host == domainHostname(plan) && backend.Name == domainServiceName(plan) && backend.Port.Number == domainServicePort(plan)
}

func observedLabelsMatch(labels map[string]string, plan DomainPlan) bool {
	expected, _ := domainMetadata(plan)["labels"].(map[string]any)
	if len(labels) != len(expected) { return false }
	for key, value := range expected { if labels[key] != fmt.Sprint(value) { return false } }
	return true
}

func domainManifest(plan DomainPlan, kind string) map[string]any { for _, manifest := range plan.Manifests { if manifest["kind"] == kind { return manifest } }; return nil }
func domainMetadata(plan DomainPlan) map[string]any { value, _ := domainManifest(plan, "Certificate")["metadata"].(map[string]any); return value }
func domainHostname(plan DomainPlan) string { spec, _ := domainManifest(plan, "Certificate")["spec"].(map[string]any); names, _ := spec["dnsNames"].([]any); if len(names) != 1 { return "" }; return fmt.Sprint(names[0]) }
func domainIssuer(plan DomainPlan) string { spec, _ := domainManifest(plan, "Certificate")["spec"].(map[string]any); issuer, _ := spec["issuerRef"].(map[string]any); return fmt.Sprint(issuer["name"]) }
func domainServiceName(plan DomainPlan) string { service, _ := domainBackend(plan)["service"].(map[string]any); return fmt.Sprint(service["name"]) }
func domainServicePort(plan DomainPlan) int { service, _ := domainBackend(plan)["service"].(map[string]any); port, _ := service["port"].(map[string]any); value, _ := port["number"].(int); return value }
func domainBackend(plan DomainPlan) map[string]any { spec, _ := domainManifest(plan, "Ingress")["spec"].(map[string]any); rules, _ := spec["rules"].([]any); rule, _ := rules[0].(map[string]any); http, _ := rule["http"].(map[string]any); paths, _ := http["paths"].([]any); path, _ := paths[0].(map[string]any); backend, _ := path["backend"].(map[string]any); return backend }
