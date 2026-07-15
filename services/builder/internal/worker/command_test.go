package worker

import "testing"

func TestWithoutAmbientRegistryCredentials(t *testing.T) {
	filtered := withoutAmbientRegistryCredentials([]string{
		"PATH=/usr/bin",
		"DOCKER_CONFIG=/shared/registry-auth",
		"REGISTRY_AUTH_FILE=/shared/containers-auth.json",
		"HOME=/home/user",
	})
	if len(filtered) != 2 || filtered[0] != "PATH=/usr/bin" || filtered[1] != "HOME=/home/user" {
		t.Fatalf("ambient registry credentials were not removed: %#v", filtered)
	}
}
