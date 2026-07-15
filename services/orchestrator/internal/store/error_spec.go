package store

import "strings"

const (
	ErrorCodeBuildFailed               = "BUILD_FAILED"
	ErrorCodeRolloutFailed             = "ROLLOUT_FAILED"
	ErrorCodeKubernetesReconcileFailed = "KUBERNETES_RECONCILE_FAILED"
	ErrorCodeImagePullBackoff          = "IMAGE_PULL_BACKOFF"
	ErrorCodeInsufficientQuota         = "INSUFFICIENT_QUOTA"
	ErrorCodeProviderCredentialFailed  = "PROVIDER_CREDENTIAL_FAILED"
	ErrorCodeDeploymentCancelled       = "DEPLOYMENT_CANCELLED"
	ErrorCodeWorkflowHandlerMissing    = "WORKFLOW_HANDLER_MISSING"
	ErrorCodeUnknownInfra              = "UNKNOWN_INFRA_ERROR"
)

type ErrorSpec struct {
	Code        string `json:"code"`
	Area        string `json:"area"`
	Severity    string `json:"severity"`
	Retryable   bool   `json:"retryable"`
	UserMessage string `json:"userMessage"`
	Message     string `json:"message,omitempty"`
}

func ErrorSpecForCode(code string) ErrorSpec {
	switch NormalizeErrorCode(code) {
	case ErrorCodeBuildFailed:
		return ErrorSpec{Code: ErrorCodeBuildFailed, Area: "build", Severity: "error", Retryable: true, UserMessage: "The image build failed. Check build logs, Dockerfile, and configured build commands."}
	case ErrorCodeRolloutFailed:
		return ErrorSpec{Code: ErrorCodeRolloutFailed, Area: "orchestrator", Severity: "error", Retryable: true, UserMessage: "The Kubernetes rollout failed. Check runtime logs, image pull status, probes, and resource limits."}
	case ErrorCodeKubernetesReconcileFailed:
		return ErrorSpec{Code: ErrorCodeKubernetesReconcileFailed, Area: "orchestrator", Severity: "error", Retryable: true, UserMessage: "The orchestrator could not reconcile the desired Kubernetes state."}
	case ErrorCodeImagePullBackoff:
		return ErrorSpec{Code: ErrorCodeImagePullBackoff, Area: "orchestrator", Severity: "error", Retryable: true, UserMessage: "Kubernetes could not pull the container image. Verify registry credentials, image name, and tag/digest."}
	case ErrorCodeInsufficientQuota:
		return ErrorSpec{Code: ErrorCodeInsufficientQuota, Area: "quota", Severity: "error", Retryable: false, UserMessage: "The requested operation exceeds the current organization or user quota."}
	case ErrorCodeProviderCredentialFailed:
		return ErrorSpec{Code: ErrorCodeProviderCredentialFailed, Area: "provisioner", Severity: "error", Retryable: true, UserMessage: "The resource provider could not create or store credentials for the managed resource."}
	case ErrorCodeDeploymentCancelled:
		return ErrorSpec{Code: ErrorCodeDeploymentCancelled, Area: "deployment", Severity: "info", Retryable: false, UserMessage: "Deployment cancellation was requested."}
	case ErrorCodeWorkflowHandlerMissing:
		return ErrorSpec{Code: ErrorCodeWorkflowHandlerMissing, Area: "workflow", Severity: "error", Retryable: false, UserMessage: "No worker handler is registered for this workflow type."}
	default:
		return ErrorSpec{Code: ErrorCodeUnknownInfra, Area: "unknown", Severity: "error", Retryable: false, UserMessage: "An unexpected infrastructure error occurred."}
	}
}

func ErrorSpecForFailure(failure error, fallbackCode string) ErrorSpec {
	spec := ErrorSpecForCode(fallbackCode)
	if failure != nil {
		spec.Message = Redact(failure.Error())
	}
	return spec
}

func NormalizeErrorCode(code string) string {
	normalized := strings.TrimPrefix(strings.ToUpper(strings.TrimSpace(code)), "ERR_")
	switch {
	case normalized == "":
		return ErrorCodeUnknownInfra
	case strings.Contains(normalized, "IMAGE_PULL") || strings.Contains(normalized, "IMAGEPULLBACKOFF"):
		return ErrorCodeImagePullBackoff
	default:
		return normalized
	}
}
