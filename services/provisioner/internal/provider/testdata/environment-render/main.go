package main

import (
	"encoding/json"
	"os"

	"github.com/raibitserver/provisioner/internal/provider"
	"github.com/raibitserver/provisioner/internal/store"
)

type identity struct {
	Name       string         `json:"name"`
	Namespace  string         `json:"namespace"`
	SecretName string         `json:"secretName"`
	PVCName    string         `json:"pvcName"`
	Endpoint   string         `json:"endpoint"`
	Labels     map[string]any `json:"labels"`
}

type probeInput struct {
	ProdEnvironmentID string `json:"prodEnvironmentId"`
	DevEnvironmentID  string `json:"devEnvironmentId"`
	LogicalSlug       string `json:"logicalSlug"`
}

func main() {
	const image = "registry.example/postgresql@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	var input probeInput
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		panic(err)
	}
	base := store.Resource{
		ID: "resource-storage-probe", ProjectID: "project-probe", OrganizationID: "club", ProjectSlug: "project",
		Name: "Assets", Slug: "physical-assets", LogicalSlug: input.LogicalSlug, Engine: "postgresql", Provider: "dedicated-local", Plan: "shared-small", Region: "local",
		DesiredSpec: map[string]any{"databaseName": "team_assets", "storageMb": 256}, DesiredState: map[string]any{},
	}
	prod := base
	prod.EnvironmentID, prod.EnvironmentKind = input.ProdEnvironmentID, "prod"
	dev := base
	dev.EnvironmentID, dev.EnvironmentKind = input.DevEnvironmentID, "dev"
	output := make(map[string]identity, 2)
	for kind, resource := range map[string]*store.Resource{"prod": &prod, "dev": &dev} {
		plan, err := provider.Compile(resource, image)
		if err != nil {
			panic(err)
		}
		output[kind] = identity{plan.Name, plan.Namespace, plan.SecretName, plan.PVCName, plan.Endpoint, plan.Labels}
	}
	if err := json.NewEncoder(os.Stdout).Encode(output); err != nil {
		panic(err)
	}
}
