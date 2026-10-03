package controlplane

import "strings"

func templateResourcesReady(state map[string]any, job record) bool {
	payload := mapField(job, "payload")
	deployment := findRecord(recordSlice(state, "deployments"), workflowDeploymentID(job))
	raw, present := payload["templateResourceIds"]
	if !present {
		service := findRecord(recordSlice(state, "services"), stringField(deployment, "serviceId"))
		sourceType := coalesceString(stringField(mapField(deployment, "desiredSpecSnapshot"), "sourceType"), stringField(service, "sourceType"))
		return !strings.EqualFold(sourceType, "template") && !strings.EqualFold(stringField(payload, "sourceType"), "template")
	}
	values, ok := raw.([]any)
	if !ok {
		return false
	}
	if len(values) == 0 {
		return true
	}
	projectID, environmentID := stringField(deployment, "projectId"), stringField(deployment, "environmentId")
	if projectID == "" || environmentID == "" {
		return false
	}
	resources, bindings := recordSlice(state, "resources"), recordSlice(state, "environmentResources")
	for _, value := range values {
		resourceID, ok := value.(string)
		if !ok || strings.TrimSpace(resourceID) != resourceID || resourceID == "" {
			return false
		}
		resource := findRecord(resources, resourceID)
		if resource == nil || stringField(resource, "projectId") != projectID || !strings.EqualFold(strings.TrimSpace(stringField(resource, "status")), "READY") {
			return false
		}
		bound := false
		for _, binding := range bindings {
			if stringField(binding, "resourceId") == resourceID && stringField(binding, "projectId") == projectID && stringField(binding, "environmentId") == environmentID {
				bound = true
				break
			}
		}
		if !bound {
			return false
		}
	}
	return true
}
