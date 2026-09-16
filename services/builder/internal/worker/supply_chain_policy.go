package worker

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/raibitserver/builder/internal/controlplane"
)

const sourceStageLimit = 15 * time.Minute
const registryStageLimit = 10 * time.Minute

func (b *Builder) stageTimeout(limit time.Duration) time.Duration {
	return min(b.Config.Timeout, limit)
}

func (b *Builder) validateVerificationPolicy() error {
	severities := strings.Split(b.Config.ScanSeverity, ",")
	high, critical := false, false
	for _, severity := range severities {
		switch strings.TrimSpace(severity) {
		case "HIGH":
			high = true
		case "CRITICAL":
			critical = true
		case "UNKNOWN", "LOW", "MEDIUM":
		default:
			return errors.New("live scanner severity must contain valid vulnerability levels")
		}
	}
	if !high || !critical {
		return errors.New("live scanner policy must include HIGH and CRITICAL vulnerabilities")
	}
	key := strings.TrimSpace(b.Config.VerificationKeyPath)
	if key == "" || !filepath.IsAbs(key) || filepath.Clean(key) != key || key == filepath.Clean(b.Config.SigningKeyPath) {
		return errors.New("live image verification requires an independent absolute public trust key path")
	}
	return nil
}

func (b *Builder) verifyImage(ctx context.Context, state *buildContext, digest string) error {
	if b.Config.DryRun {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("verify image context: %w", err)
	}
	if err := b.recheckTargetDeletion(ctx, state); err != nil {
		return err
	}
	if err := b.Store.RenewWorkflowJobLease(ctx, state.Job.Lease(), time.Now().UTC()); err != nil {
		return err
	}
	image, err := digestPinnedImage(state.Image, digest)
	if err != nil {
		return fmt.Errorf("verify image identity: %w", err)
	}
	command := Command{
		Name: b.Config.Signer,
		Args: []string{"verify", "--new-bundle-format=false", "--check-claims=true", "--key", b.Config.VerificationKeyPath, image},
		Env:  state.RegistryEnv, CleanRegistryEnv: true,
	}
	result, err := b.Runner.Run(ctx, command, CommandOptions{Timeout: b.stageTimeout(registryStageLimit), Sensitive: true})
	state.Steps = append(state.Steps, StepResult{Type: "image-verify", Command: result.Command, DryRun: result.DryRun})
	if err == nil {
		err = ctx.Err()
	}
	if err != nil {
		eventErr := b.Store.AppendDeploymentEvent(ctx, controlplane.DeploymentEventInput{DeploymentID: state.Deployment.ID, Type: "build.image_verify_failed", Message: "image trust verification failed", Metadata: map[string]any{"tool": b.Config.Signer, "digest": digest, "result": "failed", "dryRun": false}})
		return errors.Join(fmt.Errorf("verify image signature: %w", err), eventErr)
	}
	if err := b.recheckTargetDeletion(ctx, state); err != nil {
		return err
	}
	if err := b.Store.RenewWorkflowJobLease(ctx, state.Job.Lease(), time.Now().UTC()); err != nil {
		return err
	}
	state.VerifyEvidence = map[string]any{"tool": b.Config.Signer, "image": image, "digest": digest, "result": "verified", "evidence": "configured-public-key", "dryRun": false}
	return b.Store.AppendDeploymentEvent(ctx, controlplane.DeploymentEventInput{DeploymentID: state.Deployment.ID, Type: "build.image_verified", Message: "image trust verification passed", Metadata: state.VerifyEvidence})
}
